/**
 * harvest.js — 从【历史会话】挖『作者发言 ↔ 同一轮读过的设定档』弱标注对
 *
 * ══ 职责边界 ═══════════════════════════════════════════════════════
 *   本模块只做**提取**（纯逻辑），不决定"要不要写、写到哪"。
 *   ⇒ `tools/harvest-weak.mjs`（CLI）与 `lib/bootstrap.js`（首次引导）都调用它。
 *   —— 与本项目既有的「引擎与判据分离」（`_watch-core.js`）同一条思路：
 *     **提取可以复用，策略各自决定。**
 *
 * ══ ⚠️ 这些坑都是实测踩出来的，改代码前先读 ═════════════════════════
 *   ① **`session.jsonl.zstd` 是多帧拼接**，必须逐帧解。
 *      直接 `zstdDecompressSync(整文件)` 只解出第一帧（188 字节会话头），**静默**。
 *      （教训 §237）
 *   ② **绝不能用 `line.includes('"user/message"')` 给行分类** ——
 *      工具的参数/返回里可能含同一个字面串（本项目里就有大量"读会话日志"的操作），
 *      那些行会被误判，**段落被反复打碎**。（教训 §240 错配①）
 *   ③ **纯平台注入物不能开新段** —— 实测结构是两条相邻的 `user/message`：
 *        作者真实发言 → 纯 system-reminder → 工具调用
 *      若给注入物也开段，读了 N 份档的 tool-call 会归到**没有文本**的那一段，
 *      而作者真话那一段反而没有 tool-call ⇒ **两边完美错过**。（教训 §240 错配②）
 *   ④ **系统通知不是作者发言** —— `Background subagent … finished`、
 *      `background job … finished` 会被包在 `user/message` 里送进来，
 *      但它们不是人说的 ⇒ 必须排除，否则就是**直接喂噪声**（作者提醒的"病毒"）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { detectContextLayer, RANKS } from './knowledge.js'

// ══════════════════════════════════════════════════════════════════
// ① 解帧（见文件头坑 ①）
// ══════════════════════════════════════════════════════════════════
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 定位所有帧起点（末尾附文件长度，便于切片） */
export function frameStarts(buf) {
  const starts = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { starts.push(i); i += 4 }
  starts.push(buf.length)
  return starts
}

/** 只读第一帧（会话头，含 cwd）—— 探测归属时必须用这个，别为它全解一个文件 */
export function readSessionHead(file) {
  try {
    const buf = fs.readFileSync(file)
    const s = frameStarts(buf)
    if (s.length < 2) return null
    return JSON.parse(zstdDecompressSync(buf.subarray(s[0], s[1])).toString('utf8').split('\n')[0])
  } catch { return null }
}

/** 全解（逐帧；单帧坏了不拖垮整体） */
export function readSession(file) {
  const buf = fs.readFileSync(file)
  const starts = frameStarts(buf)
  const out = []
  for (let k = 0; k < starts.length - 1; k++) {
    try { out.push(zstdDecompressSync(buf.subarray(starts[k], starts[k + 1]))) } catch { /* 跳坏帧 */ }
  }
  return Buffer.concat(out).toString('utf8')
}

// ══════════════════════════════════════════════════════════════════
// ② 文本清洗（见文件头坑 ③④）
// ══════════════════════════════════════════════════════════════════

/** ⚠️ 平台/系统自己产生的、**不是作者说的**内容 —— 一律排除 */
export const NON_HUMAN = /^(Background subagent|background job|Subagent |Job |Tool result|Current runtime context|\[系统|\[System|System:|Note:|<)/i

/**
 * 剥掉平台注入物，只留作者原话。
 * ⚠️ 平台会**附着**在真实发言后面 ⇒ 必须是"剥"而不是"整条丢"，否则真话会被一起扔掉。
 */
export function stripInjections(t) {
  return String(t)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[a-z-]+>[\s\S]*?<\/\1>/g, (m) => (m.length > 200 ? '' : m))
    .trim()
}

export function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  return null
}

// ══════════════════════════════════════════════════════════════════
// ③ 从工具调用里抽「读了哪份档」
// ══════════════════════════════════════════════════════════════════
export const READ_TOOLS = new Set([
  'read', 'grep', 'glob', 'edit', 'write',
  'ops_grep', 'ops_glob', 'ops_inspect_local_file',
])

/**
 * 返回相对档名（如 `<域>/<地点>/<分类>/<条目>`），不是设定档则 null。
 * ⚠️ 只认「设定档案-JS/**\/*.js」—— 因为那正是要给 Laya 做路由的那 72 份。
 *    `grep` 的 `path` 常常是**目录**（`…/设定档案-JS`）⇒ 本函数会正确地返回 null
 *    （搜整个目录不等于"读了某一份档"，不能当标签）。
 */
export function docFromArgs(name, argsRaw, docRoot = '设定档案-JS') {
  if (!READ_TOOLS.has(name)) return null
  let a
  try { a = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw } catch { return null }
  if (!a || typeof a !== 'object') return null

  // ⚠️⚠️ **只接受 `file_path` / `path`，绝不接受 `pattern` / `glob`**（2026-10-15 实测踩到）
  //    `grep` / `glob` 的 `pattern` 是**搜索模式**，不是文件路径。
  //    首版退到了 `a.pattern` ⇒ 采出一批标签形如
  //      「世界·概念/背景概念/*」  「世界·概念/**/*」
  //    的**假档名**（通配符被当成了档名）——那些样本的标签是**凭空造的**。
  //    ⇒ 宁可漏（pattern 搜整目录本就不等于"读了某一份档"），不可错。
  const cand = a.file_path || a.path
  if (typeof cand !== 'string') return null
  if (cand.includes('*')) return null                  // 兜底：任何通配符都不是具体档
  const norm = cand.replace(/\\/g, '/')
  const re = new RegExp(`(?:^|/)${docRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+(?:/[^/]+)*)\\.js$`)
  const m = norm.match(re)
  return m ? m[1] : null
}

// ══════════════════════════════════════════════════════════════════
// ④ 分段：一条作者发言 + 它之后的全部 AI 活动（含读档）
// ══════════════════════════════════════════════════════════════════
export function segmentsOf(raw, docRoot = '设定档案-JS') {
  const lines = raw.split('\n')
  const segs = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.charCodeAt(0) !== 123) continue       // 非 JSONL 记录
    let o; try { o = JSON.parse(line) } catch { continue }

    // ⚠️ 用 o.type 判断，**绝不能**用 line.includes（文件头坑 ②）
    if (o.type === 'user/message') {
      const rawText = textOf(o.data?.content)
      const t = rawText ? stripInjections(rawText) : ''
      // ⚠️ 纯注入物不开新段（文件头坑 ③）
      if (!t) {
        if (!cur) { cur = { text: null, pos: i + 1, docs: new Set() }; segs.push(cur) }
        continue
      }
      cur = { text: t, pos: i + 1, docs: new Set() }
      segs.push(cur)
      continue
    }

    if (o.type === 'assistant/chunk') {
      if (!cur) continue
      const b = o.data?.chunk?.block
      if (!b || b.type !== 'tool-call') continue
      const doc = docFromArgs(b.name, b.arguments, docRoot)
      if (doc) cur.docs.add(doc)
    }
  }
  return segs
}

// ══════════════════════════════════════════════════════════════════
// ⑤ 会话发现
// ══════════════════════════════════════════════════════════════════
export const SESS_ROOT = path.join(os.homedir(), '.dsh', 'sessions')

/** 列出某个项目根下的全部会话文件 */
export function findSessionDirs(projectRoot, { root = SESS_ROOT } = {}) {
  const want = path.resolve(projectRoot)
  const out = []
  let dirs = []
  try { dirs = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(root, d.name)
    let subs = []
    try { subs = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const s of subs) {
      if (!s.isDirectory()) continue
      const f = path.join(dir, s.name, 'session.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      const head = readSessionHead(f)                    // 只读第一帧
      if (!head?.cwd || path.resolve(head.cwd) !== want) continue
      const st = fs.statSync(f)
      out.push({ file: f, id: s.name, mtime: st.mtimeMs, size: st.size })
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/** 发现**所有**有会话的项目根（首次引导时用：不需要事先知道有哪些项目） */
export function discoverProjects({ root = SESS_ROOT } = {}) {
  const map = new Map()                                  // cwd → {cwd, sessions, bytes}
  let dirs = []
  try { dirs = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(root, d.name)
    let subs = []
    try { subs = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const s of subs) {
      if (!s.isDirectory()) continue
      const f = path.join(dir, s.name, 'session.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      const head = readSessionHead(f)
      if (!head?.cwd) continue
      const e = map.get(head.cwd) || { cwd: head.cwd, sessions: 0, bytes: 0 }
      e.sessions++
      try { e.bytes += fs.statSync(f).size } catch { /* 忽略 */ }
      map.set(head.cwd, e)
    }
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes)
}

// ══════════════════════════════════════════════════════════════════
// ⑥ 沿树衰减取样（作者设想，2026-10-13 01:55 原话）
//
//   > 把权重比作一个**有活动分支的关节树**，查询就是不断挥舞着树枝，直到末梢指向接收口；
//   > 如果**逻辑链太长**，**底层的逻辑关节几乎不动**，那部分**完全可以降低占比**；
//   > 而在这个场景里**经常活动的就要特别注意**。
//   > —— 并明确要求：「**按语境来确认取这棵树上的哪一个节点，并向两侧递减**」
//
//   此前 `knowledge.js` 只把它用在**检索遍历**上（`traverse` 的 `centerRank`）；
//   本函数把它接到**取样**上 —— 决定"一轮里读了 8 份档，该取哪几份做样本"。
//
// ⚠️⚠️ 两条不能违反的纪律：
//   ① **测不出中心层时给「中性权重」，绝不给 0。**
//      否则"没测出来"会被当成"不相关"⇒ **静默丢掉本该留的东西**
//      （§242 那个筛选器误删 60 条好数据，就是这么发生的）。
//   ② **丢掉的必须能被看见。** 取 3 丢 5，要报"丢了 5 条、因为层距远"，
//      而不是悄悄截断（§239：同一输出对应多种内部状态，必有一条在骗人）。
// ══════════════════════════════════════════════════════════════════

/** 沿树衰减的梯度（与 `knowledge.js` 的 `layerDecay` 同源：不衰减到 0，留地板） */
const DECAY = [1.0, 0.6, 0.35, 0.2, 0.15]
const NEUTRAL = 0.5          // ⚠️ 中心层未知时的中性权重（**不是 0**）

/**
 * 给候选档按「与当前语境层的距离」排序。
 * @returns {{rows:Array, ctx:object|null, note:string}}
 */
export function rankDocsByLayer(text, docs, graph) {
  if (!graph?.nodeById) {
    return {
      rows: docs.map((d) => ({ doc: d, weight: NEUTRAL, dist: null, ctxLayer: null, docLayer: null, why: '没有知识图 ⇒ 中性权重（不据此取舍）' })),
      ctx: null,
      note: '未提供知识图 ⇒ 本函数不参与排序（全部中性）',
    }
  }
  let ctx = null
  try { ctx = detectContextLayer(text, graph) } catch { /* 检测失败 ⇒ ctx 保持 null */ }

  const center = ctx?.rank ?? null
  const rows = docs.map((d) => {
    const node = graph.nodeById.get(d)
    const r = RANKS[node?.layer] ?? null
    if (center == null) {
      return { doc: d, weight: NEUTRAL, dist: null, ctxLayer: null, docLayer: node?.layer ?? null, why: '当前语境层没测出来 ⇒ 中性权重' }
    }
    if (r == null) {
      return { doc: d, weight: NEUTRAL, dist: null, ctxLayer: ctx.layer, docLayer: null, why: `该档没有层信息 ⇒ 中性权重（不据此取舍）` }
    }
    const dist = Math.abs(center - r)
    return {
      doc: d, weight: DECAY[dist] ?? 0.15, dist,
      ctxLayer: ctx.layer, docLayer: node.layer,
      why: dist === 0 ? `与语境同层（${ctx.layer}）` : `距语境层 ${dist} 级（${ctx.layer} ↔ ${node.layer}）`,
    }
  })
  rows.sort((a, b) => b.weight - a.weight)
  return { rows, ctx, note: ctx ? `语境层＝${ctx.layer}（命中 ${ctx.hits} 个术语${ctx.confident ? '' : '，**样本少、可信度低**'}）` : '当前语境层没测出来 ⇒ 全部中性权重（不据此取舍）' }
}

// ══════════════════════════════════════════════════════════════════
// ⑦ 编排：从一个会话抽样本
// ══════════════════════════════════════════════════════════════════
/**
 * @returns {{samples:Array, stats:object}}
 *   每条 sample = {task, input, label, labelSource, confidence, ref}
 *   ⚠️ **只产出对象，不写盘** —— 写不写由调用方决定（防病毒第一道闸）。
 *
 * @param graph     知识图（由调用方加载一次复用）。**不给则退化为"按出现顺序取前 N"，并在 stats 里记明**
 * @param useDecay  是否启用沿树衰减取样（默认 true；关掉可做对照）
 */
export function harvestSession(file, { docRoot = '设定档案-JS', maxPerTurn = 3, minText = 12, maxText = 1000, minConf = 0, graph = null, useDecay = true } = {}) {
  const samples = []
  const stats = {
    segments: 0, nonHuman: 0, tooShort: 0, tooLong: 0, lowConf: 0, withDoc: 0,
    // ★ 沿树衰减的取证（**每一个数字都要能被核对**）
    picked: 0, droppedByCap: 0, ctxDetected: 0, ctxUnknown: 0,
    decayUsed: !!(graph && useDecay), layerReasons: [],
  }
  let raw
  try { raw = readSession(file) } catch { return { samples, stats } }

  // ⚠️⚠️ **语境要用「一段上下文」判，不能只用一句话**（2026-10-15 实测踩到）
  //   首版拿**单句发言**去 `detectContextLayer` ⇒ 537 段里只有 3 段测得出层
  //   （口语发言命中术语太少：「命中 1 个术语，样本少、可信度低」）。
  //   ⇒ 衰减形同虚设，开/关结果**完全一样**。
  //   ⇒ 这正是作者说的「**依据上下文范围**」——**范围**才是关键词：
  //     中心层应随**这一段对话的语境**移动，而不是随一句话。
  //   做法：维护一个**滑动语境界**（保留最近 N 字），用它判层。
  let ctxBuf = ''
  const CTX_WINDOW = 2000

  for (const seg of segmentsOf(raw, docRoot)) {
    stats.segments++
    if (!seg.text) continue
    if (NON_HUMAN.test(seg.text)) { stats.nonHuman++; continue }
    ctxBuf = (ctxBuf + '\n' + seg.text).slice(-CTX_WINDOW)     // ★ 语境随对话滚动
    const docs = [...seg.docs]
    if (!docs.length) continue
    stats.withDoc++
    const t = seg.text
    if (t.length < minText) { stats.tooShort++; continue }
    if (t.length > maxText) { stats.tooLong++; continue }

    // ── ★ 沿树衰减：先排序，再截断（而不是按出现顺序截断）──
    let ordered = docs
    if (stats.decayUsed) {
      const r = rankDocsByLayer(ctxBuf, docs, graph)     // ← 用**语境界**，不是单句
      ordered = r.rows.map((x) => x.doc)
      if (r.ctx) { stats.ctxDetected++; if (!r.ctx.confident) stats.ctxUnknown++ } else stats.ctxUnknown++
      // 留 3 条理由，供人工核对"它凭什么这么排"
      if (stats.layerReasons.length < 3) stats.layerReasons.push({ text: t.slice(0, 40), note: r.note, order: r.rows.map((x) => `${x.doc}(${x.weight})`) })
    }

    const conf = 1 / docs.length                       // ⚠️ 读得越多，每一条越不可信
    if (conf < minConf) { stats.lowConf++; continue }
    const picked = ordered.slice(0, maxPerTurn)
    stats.picked += picked.length
    stats.droppedByCap += ordered.length - picked.length       // ★ 丢了几个，记下来

    for (const doc of picked) {
      samples.push({
        task: 'doc_route_weak',
        input: t,
        label: doc,
        labelSource: 'weak_session',
        confidence: +conf.toFixed(3),
        ref: { session: path.basename(path.dirname(file)), pos: seg.pos, docCount: docs.length },
      })
    }
  }
  return { samples, stats }
}
