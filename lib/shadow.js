/**
 * shadow.js — 【影子模式】：新判据先只记录、**不提醒**。
 *
 * ══ 为什么要有它（本项目已有的依据，不是新发明的需求）══════════════
 *   · `.警报判据.json` 的 `_sources说明` 自己记着：
 *     「首轮实测 **5 条警报全是噪声**，根因就是三个判据的对象不同，
 *       却被同一个混合管道全喂了一遍」。
 *   · 而 OOC / 听不懂 这类新判据，**词表命中必然比老判据更宽**（句式类）。
 *   · 若直接 enabled 上线 ⇒ 噪声会淹没真正的提醒，作者会关掉整个功能。
 * ⇒ 影子模式：命中后**不进 `alert_check` 的输出**，只落一条记录；
 *   跑一段后由作者逐条判「该报 / 不该报」，**用真实数据定误报率**，再决定转正。
 *
 * ══ 三条硬约束（全部来自本项目踩过的坑）══════════════════════════
 *   ① **绝不静默**：写盘失败必须 `console.warn` 并回报 `error`（§239）。
 *      ⚠️ 注：`samples.js` 的 `append()` 是 `catch { return false }` ——
 *         本模块**故意不照抄**这一点（那正是 §239 那一族的形状）。
 *   ② **必须去重**：`alert_check` 每轮重扫全部痕迹 ⇒ 同一处命中会被反复找到。
 *      没有指纹 ⇒ 日志随轮数**平方增长**（`samples.js` 的指纹注释记着同一件事）。
 *   ③ **必须防无限增长**：超过上限就**轮转**（保留历史），**绝不截断**（§241）。
 *
 * ══ 数据布局（默认 `~/.dsh/alert-shadow/`）════════════════════════
 *   hits.jsonl      追加：一次命中 = 一条（判据 / 位置 / 源 / 命中词 / 片段）
 *   verdicts.jsonl  追加：一次裁决 = 一条
 *                   ⚠️ **不重写 hits 文件** —— 裁决是追加，故无损、可回溯
 *   last-run.json   【覆盖】：只留最新一次扫描的统计
 *                   ⇒ 用来回答「**它到底在不在跑**」（否则 0 命中分不清
 *                     "扫了没命中" vs "根本没扫" —— 这正是硬规则 4）
 *
 * ⚠️ 本文件的输出**只给作者看**（CLI 终端），**不回注模型** ⇒ 不属于"回显触发词"。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'

export const SHADOW_OPTS = {
  dir: process.env.SHADOW_DIR || path.join(HOME, '.dsh', 'alert-shadow'),
  maxBytes: +(process.env.SHADOW_MAX_MB || 8) * 1024 * 1024,   // 超过就轮转，防无限增长
  /** 单次汇总最多读多少条 —— 超过就**明说**，不静默只读一部分 */
  maxRead: +(process.env.SHADOW_MAX_READ || 20000),
}

export const hitsFile = () => path.join(SHADOW_OPTS.dir, 'hits.jsonl')
export const verdictsFile = () => path.join(SHADOW_OPTS.dir, 'verdicts.jsonl')
export const lastRunFile = () => path.join(SHADOW_OPTS.dir, 'last-run.json')

/**
 * 命中的内容指纹 —— **不含时间戳**。
 * ⇒ 同一处命中（同一会话·同一判据·同一位置·同一命中词）无论哪一轮扫到，只落一条。
 */
export function hitKey(h) {
  const key = [h.session ?? '', h.judge ?? '', h.pos ?? '', h.term ?? ''].join('\u0000')
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)
}

/**
 * 已见指纹集合。**按 mtime 缓存**，避免每次 append 都全文件重读。
 * ⚠️ 轮转（rename）时**保留内存中的集合** —— 否则轮转后旧指纹全丢，历史命中会被重记一遍。
 */
let seenCache = { file: null, mtime: 0, set: null }
function seen(file) {
  try {
    const st = fs.statSync(file)
    if (seenCache.file === file && seenCache.mtime === st.mtimeMs && seenCache.set) return seenCache.set
    const set = seenCache.file === file && seenCache.set ? seenCache.set : new Set()
    for (const e of readJsonl(file)) if (e.h) set.add(e.h)
    seenCache = { file, mtime: st.mtimeMs, set }
    return set
  } catch {
    // 文件不存在（首次运行 / 刚轮转）—— 保留已有集合，不清空
    return seenCache.file === file && seenCache.set ? seenCache.set : new Set()
  }
}

/** 读 jsonl；坏行**计数并回报**，不静默丢弃。 */
export function readJsonl(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return [] }
  const ok = []
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue
    try { ok.push(JSON.parse(l)) } catch { ok.push({ _badLine: true }) }
  }
  return ok.filter((e) => !e._badLine)
}

/** 坏行条数（用于汇总时如实报告，而不是假装文件是好的） */
export function countBadLines(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return 0 }
  let bad = 0
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue
    try { JSON.parse(l) } catch { bad++ }
  }
  return bad
}

function rotateIfBig(file) {
  try {
    const st = fs.statSync(file)
    if (st.size > SHADOW_OPTS.maxBytes) {
      fs.renameSync(file, file.replace(/\.jsonl$/, `.${Date.now()}.jsonl`))
    }
  } catch { /* 文件不存在则无需轮转 */ }
}

/**
 * 记录一批命中。**永不抛**（影子记录绝不能影响主流程），
 * 但**失败必须留痕** —— 返回 `error`，并 `console.warn`。
 *
 * @param hits   [{ judge, kind, pos, block, term, why, snippet }]
 * @param session 会话标识（用于指纹与人工定位）
 * @returns {{added:number, skipped:number, error:string|null}}
 */
export function recordHits(hits, session = '') {
  const res = { added: 0, skipped: 0, error: null }
  if (!hits || !hits.length) return res
  try {
    const f = hitsFile()
    const s = seen(f)
    const buf = []
    for (const h of hits) {
      const rec = { ts: new Date().toISOString(), session, ...h }
      const k = hitKey(rec)
      if (s.has(k)) { res.skipped++; continue }
      s.add(k)                                   // 先占位，防同进程内连续两次写入重复
      buf.push(JSON.stringify({ ...rec, h: k }))
    }
    if (!buf.length) return res
    rotateIfBig(f)
    fs.mkdirSync(SHADOW_OPTS.dir, { recursive: true })
    fs.appendFileSync(f, buf.join('\n') + '\n', 'utf8')
    res.added = buf.length
  } catch (e) {
    // ⚠️ §239：降级可以，**降级必须留痕**。绝不 catch 之后假装成功。
    res.error = e instanceof Error ? e.message : String(e)
    console.warn('[alert-inject/shadow] ⚠️ 影子记录写入失败（判据仍在跑，只是没记下来）：', res.error)
  }
  return res
}

/**
 * 写"最近一次扫描"的心跳（**覆盖**，永远只有一条）。
 * 用途：回答「它到底在不在跑、扫了多少条」—— 这是硬规则 4 的落地。
 */
export function writeLastRun(info) {
  try {
    fs.mkdirSync(SHADOW_OPTS.dir, { recursive: true })
    fs.writeFileSync(lastRunFile(), JSON.stringify({ ts: new Date().toISOString(), ...info }, null, 2), 'utf8')
    return { ok: true, error: null }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.warn('[alert-inject/shadow] ⚠️ 心跳写入失败：', error)
    return { ok: false, error }
  }
}

export function loadLastRun() {
  try { return JSON.parse(fs.readFileSync(lastRunFile(), 'utf8')) } catch { return null }
}

/**
 * 汇总 —— **三态**，不是二态。
 *   good（该报）／bad（不该报）／**unknown（未裁决）**
 * ⚠️ 误报率的分母**只能是已裁决数**。把"未裁决"算进分母 =
 *    拿"我不知道"当"没问题"（`AGENTS.md` 硬规则 3 明令禁止）。
 */
export function summary() {
  const hits = readJsonl(hitsFile())
  const verdicts = readJsonl(verdictsFile())
  const vmap = new Map()                        // 后写的裁决覆盖先写的（可改判）
  for (const v of verdicts) if (v.key) vmap.set(v.key, v.verdict)

  const byJudge = new Map()
  let good = 0, bad = 0, unknown = 0

  hits.forEach((h, i) => {
    const k = h.h || hitKey(h)
    const v = vmap.get(k) ?? null                // null = 未裁决（三态）
    if (!byJudge.has(h.judge)) byJudge.set(h.judge, { judge: h.judge, total: 0, good: 0, bad: 0, unknown: 0 })
    const g = byJudge.get(h.judge)
    g.total++
    if (v === 'good') { g.good++; good++ } else if (v === 'bad') { g.bad++; bad++ } else { g.unknown++; unknown++ }
    h._n = i + 1                                 // 稳定序号（1-based，给 CLI 用）
    h._verdict = v
    h._key = k
  })

  const judged = good + bad
  const rate = (g) => { const j = g.good + g.bad; return j ? g.bad / j : null }

  return {
    total: hits.length,
    good, bad, unknown, judged,
    falseReportRate: judged ? bad / judged : null,
    byJudge: [...byJudge.values()].map((g) => ({ ...g, falseReportRate: rate(g) })),
    hits,
    lastRun: loadLastRun(),
    badLines: { hits: countBadLines(hitsFile()), verdicts: countBadLines(verdictsFile()) },
    overMaxRead: hits.length >= SHADOW_OPTS.maxRead,
    files: { hits: hitsFile(), verdicts: verdictsFile(), lastRun: lastRunFile(), dir: SHADOW_OPTS.dir },
  }
}

/**
 * 裁决第 n 条（n ＝ `summary()` 里的稳定序号）。
 * ⚠️ **追加一条裁决事件，不改写 hits 文件** —— 追加是无损的，重写是有损的。
 */
export function markVerdict(n, verdict, note = '') {
  if (verdict !== 'good' && verdict !== 'bad') return { ok: false, error: `verdict 只能是 good / bad，收到：${verdict}` }
  const s = summary()
  const h = s.hits.find((x) => x._n === Number(n))
  if (!h) return { ok: false, error: `没有第 ${n} 条命中（当前共 ${s.total} 条）` }
  try {
    fs.mkdirSync(SHADOW_OPTS.dir, { recursive: true })
    const rec = { ts: new Date().toISOString(), key: h._key, n: h._n, verdict, judge: h.judge, note }
    fs.appendFileSync(verdictsFile(), JSON.stringify(rec) + '\n', 'utf8')
    return { ok: true, error: null, hit: h }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.warn('[alert-inject/shadow] ⚠️ 裁决写入失败：', error)
    return { ok: false, error }
  }
}
