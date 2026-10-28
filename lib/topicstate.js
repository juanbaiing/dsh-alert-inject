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
import { embed } from './librarian.js'
import { semanticBlocks } from './blocks.js'

/** 默认缓存位置（可用 DSH_ALERT_TOPIC_STATE 覆盖；测试传 file 参数） */
export function defaultStateFile() {
  return process.env.DSH_ALERT_TOPIC_STATE
    || path.join(os.homedir(), '.dsh', 'alert-cache', 'topic-state.json')
}

/** 最多保留多少条用户发言（BOCPD 的"截断"思想：成本有界） */
export const MAX_TURNS = +(process.env.DSH_ALERT_TOPIC_MAX || 50)
/** 单次最多 embed 几条新增（防一次灌爆；每轮正常是 1~2 条） */
export const MAX_EMBED = +(process.env.DSH_ALERT_TOPIC_EMBED || 20)
/** 每条截断长度（向量是文本的函数，太长会拖慢） */
export const SNIP = 300

const h = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12)

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.turns)) return { ok: true, turns: [] }
    return { ok: true, turns: raw.turns }
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, turns: [] }
    return { ok: false, turns: [], why: `话题状态文件读不动：${e?.message || e}` }
  }
}

function saveState(file, turns) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 原子写（同 db.writeProfile 的纪律：先临时文件再 rename）
    const tmp = file + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), turns }, null, 0), 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (e) {
    // ⚠️ 降级必须留痕（§239）—— 写不进去下一轮还会重算，但**要说出来**
    console.warn('[alert-inject/topicstate] ⚠️ 话题状态写不进去：', e?.message || e)
    return { ok: false, why: `写不进去：${e?.message || e}` }
  }
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
  const seen = new Set(turns.map((t) => t.h))
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
  if (fresh.length) {
    try {
      const batch = fresh.slice(-MAX_EMBED)          // 只 embed 增量，且封顶
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
  const sv = saveState(file, kept)
  if (!sv.ok && !why) why = sv.why
  // 当前语义段里有几条用户发言（用于「这一段聊得有点长了」的提醒）
  const currentTurns = sb.blocks.length ? sb.blocks[sb.blocks.length - 1].count : kept.length
  return {
    ok: !why,
    why,
    topicSwitches: sb.threshold !== null ? sb.boundaries.length : null,
    blocks: sb.blocks.length,
    currentTurns,
    embedded,
    total: kept.length,
    threshold: sb.threshold,
  }
}
