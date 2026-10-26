/**
 * feelings.js — 「**感觉表**」：不记内容，只记「**我判断得准不准**」
 *
 * ══ 它解决什么（2026-10-26 · 作者原话）══════════════════════════════
 *   「权重自学习，但我动不了权重……能不能退一步，把学习内容记下来」
 *   「当时的方向是『全记』，那么，现在能不能做到，记下感觉」
 *
 *   ⇒ 三层退让（见 `DESIGN-feeling.md` §0.1）：
 *     ① 改权重（要梯度）       —— API 环境做不到
 *     ② 记样本（要训练环境）   —— 训练器不在本项目
 *     ③ **记先验（只要数数）** —— 就是本模块
 *
 * ══ 为什么是「judge 级」而不是「内容级」══════════════════════════════
 *   键若取**内容** ⇒ 退回「全记」（已验证失败）；
 *   键若取**语义向量** ⇒ 等价于再做一次检索；
 *   ⇒ 只有取**判断的身份**（judge id）才稳定、可数、不漂移。
 *
 * ══ 为什么只认「用户裁决」（自举陷阱，必须写死）══════════════════════
 *   `lib/fok.js` 实测分离点仅 **~59%**（有对应 top1 ≥65%、无对应 ≤53%）。
 *   若拿 FOK 自己的判断去喂感觉、再用感觉回喂 FOK，就是**噪声自我强化**。
 *   ⇒ 本模块**只接受 `by: 'user'` 的裁决**；系统自评一律拒收，并说明原因。
 *
 * ══ 三种事件（append-only，一个事件一行）════════════════════════════
 *   `fired`   —— 本轮**哪些 judge 响了**（自动记录，构成分母）
 *   `verdict` —— 用户对某个 judge 的一次裁决（`ok` ／ `noise` ／ `unsure`）
 *   ⚠️ 没有 `fired` 就没有分母；没有 `verdict` 就没有结论 —— **两者缺一，这张表就是空的**。
 *
 * ══ 硬约束（违反任何一条都会重演已知错误）═════════════════════════
 *   1. **绝不静默**：写失败 `console.warn`（§239）；拒收要带 `reason`
 *   2. **必须去重**：同一个裁决不重复记（指纹不含时间）
 *   3. **必须衰减**：统计按时间窗口计算（默认 90 天），旧账不压新账
 *   4. **必须表达「不知道」**：样本不足时 `insufficient: true`，**不许**把"没数据"算成"准确率 0"
 *   5. **不碰档案**：只写 `<数据目录>/memory/db/feelings/`（`REFACTOR.md §六` 硬边界 7）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dbRoot } from './db.js'

/** 库的相对路径（在 `<dbRoot>/` 下，与 `criteria/criteria.jsonl` 同级） */
export const FEELINGS_REL = 'feelings/feelings.jsonl'

/** 允许的 kind —— 只有两种，不开放自由文本（否则计数无从对齐） */
export const FEELING_KINDS = ['fired', 'verdict']

/** 允许的裁决 —— ⚠️ **三态**：`unsure` 是「判不了」，不是「否定」（硬规则 3） */
export const VERDICTS = ['ok', 'noise', 'unsure']

/**
 * 统计窗口（天）。默认 90 —— 一年前的先验不该永远压着（DESIGN-feeling §四-3）。
 * ⚠️ 窗口内样本不足时**不报准确率**，只报"样本不足"。
 */
export const WINDOW_DAYS = +(process.env.FEELINGS_WINDOW_DAYS || 90)

/** 至少多少条裁决才允许给结论（SetFit 门槛「每类 8 条」的项目先例，见 samples.js） */
export const MIN_SAMPLES = +(process.env.FEELINGS_MIN_SAMPLES || 5)

/** 文件绝对路径（**现算**，不缓存 —— 测试里 `DSH_ALERT_DATA_DIR` 会变） */
export function feelingsFile() {
  return path.join(dbRoot(), FEELINGS_REL)
}

/**
 * 内容指纹 —— 决定「这条是否已经记过」。
 * ⚠️ **不含 `when`**（时间必然不同）；`fired` 事件天然需要去重，
 *   故把「本轮有哪些 judge ＋ 当天」折进指纹（同一天同组合只记一次）。
 */
export function feelingKey(e) {
  const key = [
    String(e.kind ?? ''),
    String(e.judge ?? ''),
    String(e.target ?? ''),
    String(e.verdict ?? ''),
    String(e.by ?? ''),
    // fired：按「日期 + 这批 judge 的排序组合」去重，避免一天内每轮都堆一条
    e.kind === 'fired' ? String(e.day ?? '') + '|' + (e.judges || []).slice().sort().join(',') : '',
  ].join('\u0000')
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)
}

/** 读全部事件（**坏行计数并回报**，不静默吞掉 —— 与 db.js 同一纪律） */
export function loadFeelings({ file = feelingsFile() } = {}) {
  if (!fs.existsSync(file)) return { ok: true, events: [], badLines: 0, reason: '感觉表还不存在（还没记过东西）' }
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) {
    return { ok: false, events: [], badLines: 0, reason: `读不动：${e?.message || e}` }
  }
  const events = []
  let badLines = 0
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue
    let o
    try { o = JSON.parse(l) } catch { badLines++; continue }
    // ⚠️ `JSON.parse` 对 null/0/"str"/true 都不报错（§263）—— 形状守卫不能省
    if (!o || typeof o !== 'object') { badLines++; continue }
    events.push(o)
  }
  return { ok: true, events, badLines, reason: '' }
}

/** 已见指纹集合（按 mtime 缓存，避免每次 append 都全文件重读 —— 同 samples.js） */
let _seen = { file: null, mtime: 0, set: new Set() }
function seenSet(file) {
  try {
    const st = fs.statSync(file)
    if (_seen.file === file && _seen.mtime === st.mtimeMs) return _seen.set
    const set = new Set()
    for (const e of loadFeelings({ file }).events) if (e.h) set.add(e.h)
    _seen = { file, mtime: st.mtimeMs, set }
    return set
  } catch { return _seen.file === file ? _seen.set : new Set() }
}

function rotateIfBig(file, maxBytes = 8 * 1024 * 1024) {
  try {
    const st = fs.statSync(file)
    if (st.size > maxBytes) fs.renameSync(file, file.replace(/\.jsonl$/, `.${Date.now()}.jsonl`))
  } catch { /* 不存在则无需轮转 */ }
}

/**
 * 追加一条事件（**唯一的写入口**）。
 *
 * @returns {{ok:boolean, added:boolean, key?:string, reason?:string}}
 *   ⚠️ 被拒时 `reason` **一定**有值 —— 不返回「成功但什么都没做」。
 */
export function appendFeeling(entry = {}) {
  const { kind, when } = entry
  if (!FEELING_KINDS.includes(kind)) {
    return { ok: false, added: false, reason: `kind 只能是 ${FEELING_KINDS.join(' / ')}，收到：${kind}` }
  }
  if (kind === 'verdict') {
    if (!entry.judge) return { ok: false, added: false, reason: 'verdict 必须带 judge（哪一路检测器）' }
    if (!VERDICTS.includes(entry.verdict)) {
      return { ok: false, added: false, reason: `verdict 只能是 ${VERDICTS.join(' / ')}，收到：${entry.verdict}` }
    }
    // ⚠️ 自举陷阱的硬闸：只有用户能裁决
    if (entry.by !== 'user') {
      return { ok: false, added: false, reason: '只有 by=user 的裁决才作数 —— 系统自评会自我强化（FOK 分离点仅 ~59%）' }
    }
  }
  if (kind === 'fired') {
    if (!Array.isArray(entry.judges) || entry.judges.length === 0) {
      return { ok: false, added: false, reason: 'fired 必须带非空的 judges 数组' }
    }
  }

  const day = new Date(when || Date.now()).toISOString().slice(0, 10)
  const rec = {
    kind,
    when: when || new Date().toISOString(),
    ...(kind === 'fired' ? { judges: entry.judges, day } : {
      judge: String(entry.judge),
      target: entry.target ? String(entry.target).slice(0, 200) : null,
      verdict: entry.verdict,
      by: 'user',
      note: entry.note ? String(entry.note).slice(0, 300) : null,
    }),
  }

  const h = feelingKey(rec)
  try {
    const f = feelingsFile()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    if (seenSet(f).has(h)) return { ok: true, added: false, key: h, reason: '已经记过了（同一条不重复记）' }
    rotateIfBig(f)
    fs.appendFileSync(f, JSON.stringify({ h, ...rec }) + '\n', 'utf8')
    _seen.mtime = -1          // 让下一次 seenSet 重读
    return { ok: true, added: true, key: h }
  } catch (e) {
    // ⚠️ §239：降级可以，**降级必须留痕**
    console.warn('[alert-inject/feelings] ⚠️ 写入失败（这条没记上）：', e?.message || e)
    return { ok: false, added: false, reason: `写入失败：${e?.message || e}` }
  }
}

/**
 * 记「本轮哪些 judge 响了」。
 * @param {string[]} judges 本轮输出段的名字（不传 ⇒ 调用方明确说明"这轮没有任何 judge 响"）
 * @param {{when?:(string|number)}} opts
 */
export function recordFired(judges, { when } = {}) {
  const list = [...new Set((judges || []).filter((x) => typeof x === 'string' && x.trim()))]
  if (!list.length) return { ok: true, added: false, reason: '这轮没有任何 judge 响 ⇒ 不记分母（**这不是失败**）' }
  return appendFeeling({ kind: 'fired', judges: list, when })
}

/**
 * 记一次用户裁决。
 * @param {{judge:string, target?:string, verdict:'ok'|'noise'|'unsure', note?:string, when?:string|number}} v
 */
export function recordVerdict({ judge, target, verdict, note, when } = {}) {
  return appendFeeling({ kind: 'verdict', judge, target, verdict, note, when, by: 'user' })
}

/**
 * 按 judge 聚合：分母（fired 次数）、各裁决数、窗口内最近一次。
 *
 * ⚠️ **三态输出**（硬规则 3）：
 *   · `insufficient: true` ⇒ 样本不足，**不许**把"没数据"当"准确率 0"
 *   · `noiseRate` 只在 `insufficient === false` 时才给数，否则 `null`
 *
 * @returns {{ok:boolean, judges:Object, windowDays:number, events:number, badLines:number, reason:string}}
 */
export function feelingsStats({ windowDays = WINDOW_DAYS } = {}) {
  const { ok, events, badLines, reason } = loadFeelings()
  if (!ok) return { ok: false, judges: {}, windowDays, events: 0, badLines, reason }

  const since = Date.now() - windowDays * 86400000
  const judges = {}
  let inWindow = 0
  for (const e of events) {
    const t = Date.parse(e.when || '')
    if (!Number.isFinite(t) || t < since) continue    // 窗口外 = 衰减掉
    inWindow++
    if (e.kind === 'fired') {
      for (const j of e.judges || []) {
        const b = (judges[j] ||= { fired: 0, ok: 0, noise: 0, unsure: 0, lastAt: null })
        b.fired++
      }
      continue
    }
    if (e.kind !== 'verdict') continue
    const j = String(e.judge || '?')
    const b = (judges[j] ||= { fired: 0, ok: 0, noise: 0, unsure: 0, lastAt: null })
    b[e.verdict] = (b[e.verdict] || 0) + 1
    b.lastAt = e.when || null
  }
  for (const j of Object.keys(judges)) {
    const b = judges[j]
    const decided = b.ok + b.noise + b.unsure
    b.decided = decided
    // ⚠️ 样本不足 ⇒ 不给结论。这是本模块最容易被误用成"准确率 0%"的地方
    b.insufficient = decided < MIN_SAMPLES
    b.noiseRate = b.insufficient ? null : +(b.noise / decided).toFixed(3)
  }
  return {
    ok: true,
    judges,
    windowDays,
    events,
    inWindow,
    badLines,
    reason: events.length
      ? `窗口 ${windowDays} 天内有 ${inWindow} 条事件（共 ${events.length} 条）`
      : '感觉表是空的 —— 还没有任何 fired／verdict 事件',
  }
}

/**
 * 渲染成给模型看的一行（**极简，且只在有足够样本的 judge 上说话**）。
 * ⚠️ 没有足够样本时**整段不输出** —— 不给噪音（同 criteria.js 的克制）。
 */
export function renderFeelingsLine({ max = 3 } = {}) {
  const st = feelingsStats()
  if (!st.ok || !st.events) return ''
  const rows = Object.entries(st.judges)
    .filter(([, b]) => !b.insufficient && b.decided >= MIN_SAMPLES)
    .sort((a, b) => (b[1].noiseRate || 0) - (a[1].noiseRate || 0))
    .slice(0, max)
  if (!rows.length) return ''
  return '🧪 检测器历史：' + rows
    .map(([j, b]) => `${j}（${b.decided} 次裁决，否决率 ${(b.noiseRate * 100).toFixed(0)}%）`)
    .join('｜')
}
