/**
 * topicstate.js — **增量话题状态**：只维护「最近 N 条用户发言」，不依赖全量索引
 *
 * ══ 为什么有这个文件（2026-10-27 · 跨领域反思的落地）══════════════════════
 *   原来的做法：话题边界检测从 `librarian` 索引取向量 —— 但那个索引是给**检索**用的，
 *   会话一长它就 stale（实测：0.1MB → 5.7MB，索引永远追不上）⇒ 语义分块永远降级成轮数。
 *
 *   ⇒ 跨领域搜索（§297）给的答案：**不要维护全量历史**。
 *     · 信号处理 **BOCPD**：只维护「运行长度后验」，O(1) 增量、截断后成本有界
 *     · 语音 **streaming diarization**：单遍因果、不重算已见样本
 *   ⇒ 本模块照此实现：只保留最近 N 条用户发言的向量（缓存文件），每轮只 embed **新增的**那几条。
 *
 * ══ 三条纪律（与项目三态一致）═════════════════════════════════════
 *   ① **失败不静默**：embed 失败/文件损坏 ⇒ 返回 `{ok:false, why}`，由调用方降级并留痕
 *   ② **样本不足 ≠ 没有切换**：<4 条时 `topicSwitches: null`（那是"判不了"）
 *   ③ **去重按内容指纹**：同一句话重复出现（重启/重发）不重复 embed
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { embed, cosine } from './librarian.js'
import { semanticBlocks } from './blocks.js'

/** 默认缓存位置（可用 DSH_ALERT_TOPIC_STATE 覆盖；测试传 file 参数） */
export function defaultStateFile() {
  return process.env.DSH_ALERT_TOPIC_STATE
    || path.join(os.homedir(), '.dsh', 'alert-cache', 'topic-state.json')
}

/** 最多保留多少条用户发言（BOCPD 的"截断"思想：成本有界） */
export const MAX_TURNS = +(process.env.DSH_ALERT_TOPIC_MAX || 50)
/** 单次最多 embed 几条新增（2026-10-27 从 20 改 **5**：首次 embed 20 条实测 ~8 秒，
 *  是 alert_check 耗时大头；改成 5 条 ≈ 2 秒，之后每轮补 1 条、几轮追平） */
export const MAX_EMBED = +(process.env.DSH_ALERT_TOPIC_EMBED || 5)
/** 每条截断长度（向量是文本的函数，太长会拖慢） */
export const SNIP = 300

const h = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12)

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.turns)) return { ok: true, turns: [] }
    return {
      ok: true,
      turns: raw.turns,
      lastUserCount: typeof raw.lastUserCount === 'number' ? raw.lastUserCount : null,
      lastResult: raw.lastResult && typeof raw.lastResult === 'object' ? raw.lastResult : null,
      // ⚠️ 已 embed 过的全部 hash（**独立于 turns**：turns 只留最近 50 条，
      //    而输入是全量用户发言 ⇒ 只用 turns 去重会导致被截断的头部**每轮都被当成新增**、反复 embed）
      seenHashes: Array.isArray(raw.seenHashes) ? raw.seenHashes : [],
    }
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, turns: [] }
    return { ok: false, turns: [], why: `话题状态文件读不动：${e?.message || e}` }
  }
}

function saveState(file, turns, extra = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 原子写（同 db.writeProfile 的纪律：先临时文件再 rename）
    const tmp = file + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), turns, ...extra }, null, 0), 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (e) {
    // ⚠️ 降级必须留痕（§239）—— 写不进去下一轮还会重算，但**要说出来**
    console.warn('[alert-inject/topicstate] ⚠️ 话题状态写不进去：', e?.message || e)
    return { ok: false, why: `写不进去：${e?.message || e}` }
  }
}

/**
 * 块质心（块内 turns 的向量均值）——用于「回切检测」。
 * ⚠️ 纯计算，不调模型；块太短或没向量 ⇒ null。
 */
function blockCentroid(block, turns) {
  const vs = []
  for (let i = block.start; i <= block.end && i < turns.length; i++) {
    const v = turns[i]?.vec
    if (Array.isArray(v) && v.length) vs.push(v)
  }
  if (!vs.length) return null
  const dim = vs[0].length
  const out = new Array(dim).fill(0)
  for (const v of vs) for (let d = 0; d < dim; d++) out[d] += v[d] || 0
  for (let d = 0; d < dim; d++) out[d] /= vs.length
  return out
}

/**
 * **回切检测**（2026-10-27 加）——「上厕所回来，把上学的路解压出来」。
 *
 * 判据：当前块（最后一段）的质心，与**更早的块**（至少隔一个，即跳过紧邻块）的质心余弦
 *   ≥ 阈值 ⇒ 判定「回到了之前的话题」。
 * ⇒ 调用方据此把那个旧块的原文/摘要取回来重新摆到眼前（RECAP 的「按依赖恢复」）。
 *
 * ⚠️ 只在 `blocks.length >= 3` 时做（两块时"回到"没有意义）。
 * ⚠️ 阈值 0.75 是保守值：比语义块切分的动态阈值高——**"回到"要比"同一话题"更强才认**。
 */
export function detectBacktrack(blocks, turns, { threshold = 0.75, maxLookback = 5 } = {}) {
  if (!blocks || blocks.length < 3) return null
  const cur = blocks[blocks.length - 1]
  const cc = blockCentroid(cur, turns)
  if (!cc) return null
  let best = null
  for (let b = blocks.length - 3; b >= Math.max(0, blocks.length - 3 - maxLookback); b--) {
    const pc = blockCentroid(blocks[b], turns)
    if (!pc) continue
    const sim = cosine(cc, pc)
    if (!best || sim > best.sim) {
      // 该块的代表文本：取块内第一条用户发言（截断）
      const first = turns[blocks[b].start]?.text || ''
      best = { blockIndex: b, sim: +sim.toFixed(3), excerpt: String(first).slice(0, 60) }
    }
  }
  if (!best || best.sim < threshold) return null
  return best
}

/**
 * 更新话题状态并返回**真实的话题切换次数**。
 *
 * @param {string[]} userTexts 本次会话里的用户发言（按时间顺序；调用方从 acts 里取）
 * @param {{file?:string, max?:number, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, why?:string, topicSwitches:number|null, blocks:number, embedded:number, total:number, threshold:number|null}>}
 *   `topicSwitches === null` ⇒ **判不了**（样本不足或算不出），调用方应降级成"轮数"文案
 */
export async function updateTopicState(userTexts, { file = defaultStateFile(), max = MAX_TURNS } = {}) {
  const st = loadState(file)
  const turns = st.turns.slice()
  /**
   * ⚠️ 去重集合 = `seenHashes`（历史全部）+ `turns`（兼容旧缓存）——
   *   不能只用 `turns`：它只保留最近 `max` 条，而输入是**全量**用户发言，
   *   被截断掉的头部每轮都会被当成"新增"、反复 embed（实测第 2 次调用仍 embed 5 条）。
   */
  const seen = new Set([...(st.seenHashes || []), ...turns.map((t) => t.h)])
  const fresh = []
  for (const text of userTexts || []) {
    const t = String(text || '').trim()
    if (!t) continue
    const key = h(t.slice(0, SNIP))
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push({ h: key, text: t.slice(0, SNIP) })
  }
  let embedded = 0
  let why = st.ok ? undefined : st.why
  /**
   * ★ B（2026-10-27）：**本轮没有新用户发言 ⇒ 直接返回上次结果**（不重算、不重写）。
   *   判据：缓存里记了 `lastUserCount` 与 `lastResult`，且本次传入的发言数没变。
   *   ⚠️ 它不掩盖"第一次还没算过"：没有 `lastResult` 时照常计算。
   */
  const userCount = (userTexts || []).length
  if (!fresh.length && st.lastUserCount === userCount && st.lastResult) {
    return { ok: true, why: undefined, embedded: 0, total: turns.length, ...st.lastResult }
  }
  if (fresh.length) {
    try {
      const batch = fresh.slice(-MAX_EMBED)          // 只 embed 增量，且封顶（首次 5 条，之后每轮 1 条）
      const vecs = await embed(batch.map((x) => x.text))
      batch.forEach((x, i) => {
        if (Array.isArray(vecs[i]) && vecs[i].length) { turns.push({ ...x, vec: vecs[i] }); embedded++ }
      })
    } catch (e) {
      why = `embed 失败：${e?.message || e}`
    }
  }
  const kept = turns.slice(-max)
  const sb = semanticBlocks(kept.map((t, i) => ({ i, vec: t.vec })))
  // 当前语义段里有几条用户发言（用于「这一段聊得有点长了」的提醒）
  const currentTurns = sb.blocks.length ? sb.blocks[sb.blocks.length - 1].count : kept.length
  // ★ 回切检测（2026-10-27）：「上厕所回来，把上学的路解压出来」
  const backtrack = detectBacktrack(sb.blocks, kept)
  const result = {
    topicSwitches: sb.threshold !== null ? sb.boundaries.length : null,
    blocks: sb.blocks.length,
    currentTurns,
    threshold: sb.threshold,
    backTo: backtrack,
  }
  const sv = saveState(file, kept, { lastUserCount: userCount, lastResult: result, seenHashes: [...seen].slice(-500) })
  if (!sv.ok && !why) why = sv.why
  return { ok: !why, why, embedded, total: kept.length, ...result }
}
