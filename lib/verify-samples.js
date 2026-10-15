/**
 * verify-samples.js — **用知识库当裁判，筛出哪些样本可信**
 *
 * ══ 为什么不能只按数量筛（作者 2026-10-15 要求"用知识库的筛选功能"）════
 *   弱标注是"猜"出来的，光看数量会把噪声当资产。但**也不能反过来简单判死**：
 *   知识库里的表**本身有覆盖缺口** —— 实测**场景/口语文本命中率 0/3**
 *   （见 `_警觉与检索.md` §五①；同一条规律也写在作者自己的教训里：
 *    「这类话永远 grep 不到名词」）。
 *
 *   ⇒ 所以本模块一律出**三态**，不是 true/false：
 *
 *   | 判定 | 条件 | 含义 |
 *   |---|---|---|
 *   | ✅ **支持** | 文本命中的术语，其主档**就是**样本标签 | 标签有直接证据 |
 *   | 🟡 **弱支持** | 标签与某个命中档**在图上相邻**（gate/cooccur） | 可能是相关内容 |
 *   | 🔴 **存疑** | 文本命中了术语，但标签与它们**在图上都无边** | 标签**可能**错了 |
 *   | ⬜ **无法判定** | 文本**一个术语都没命中** | ⚠️ **不能判无效** —— 表有缺口 |
 *
 *   ⚠️⚠️ 最后一行是最要紧的一条：**「表没命中」不等于「样本错」**。
 *      把「无法判定」当「无效」排除，会把**恰恰最有价值的那批**（口语、场景文本）
 *      全部误杀 —— 而那正是 Laya 应该学的东西。**这条判据防止筛选本身变成病毒源。**
 *
 * ══ 判据不用语义模型（有实测依据）════════════════════════════════
 *   本模块只用**表命中 + 图邻接**（零成本、可解释、可复算）。
 *   不用向量/NLI —— 本项目已两次实测该路线失败：
 *     · NLI 三版全败（相关句从不是最高分）
 *     · 向量比对 −2.8pp 且方向反
 *   ⇒ 宁可判据保守、可解释，也不引入一个已被证伪的黑箱。
 */

import fs from 'node:fs'
import path from 'node:path'
import { loadGraph } from './knowledge.js'
import { stats, buildDataset } from './samples.js'

/**
 * 建「词 → 档」索引。
 * ⚠️ 两个来源都要用（只用一个覆盖会明显变窄）：
 *   ① `_graph.json` 的 `terms`（67 条，格式 `{word, doc, kind}`）
 *   ② 每个档的 **title**（短名，如 `世界·概念/末` 的 `末`）
 */
export function buildTermIndex(projectRoot) {
  const g = loadGraph(projectRoot)
  if (!g?.nodes?.length) return { index: new Map(), graph: null, nodeCount: 0 }

  const index = new Map()                       // word → Set(doc)
  const add = (w, doc) => {
    if (!w || w.length < 2) return                // 单字词噪声太大，不收
    if (!index.has(w)) index.set(w, new Set())
    index.get(w).add(doc)
  }
  for (const t of g.terms || []) add(t.word, t.doc)
  for (const n of g.nodes) {
    const short = n.title && n.title !== n.id ? n.title : (n.id.includes('/') ? n.id.split('/').pop() : n.id)
    add(short, n.id)
  }
  return { index, graph: g, nodeCount: g.nodes.length }
}

/** 图邻接（无向）—— gate 与 cooccur 都算，但记下来源 */
function buildAdjacency(graph) {
  const adj = new Map()                          // doc → Map(neighbor → Set(type))
  const put = (a, b, type) => {
    if (!adj.has(a)) adj.set(a, new Map())
    const m = adj.get(a)
    if (!m.has(b)) m.set(b, new Set())
    m.get(b).add(type)
  }
  for (const e of graph.edges || []) { put(e.from, e.to, e.type); put(e.to, e.from, e.type) }
  return adj
}

/**
 * 判**一条**样本。
 * @returns {{verdict:'支持'|'弱支持'|'存疑'|'无法判定', hits:string[], near:string[], reason:string}}
 */
export function judgeSample(input, label, { index, adj }) {
  const text = String(input || '')
  const hits = []
  const hitDocs = new Set()
  for (const [word, docs] of index) {
    if (text.includes(word)) {
      hits.push(word)
      for (const d of docs) hitDocs.add(d)
    }
  }

  if (!hits.length) {
    // ⚠️ 不能判无效 —— 表有覆盖缺口，口语/场景文本本来就常命中不到
    return { verdict: '无法判定', hits: [], near: [], reason: '文本未命中任何已知术语（表有覆盖缺口，不代表样本错）' }
  }
  if (hitDocs.has(label)) {
    return { verdict: '支持', hits, near: [], reason: `文本命中「${label}」自己的术语` }
  }
  const nb = adj.get(label)
  const near = [...hitDocs].filter((d) => nb?.has(d))
  if (near.length) {
    const via = [...nb.get(near[0])].join('/')
    return { verdict: '弱支持', hits, near, reason: `标签与命中的「${near[0]}」在图上相邻（${via}）` }
  }
  return {
    verdict: '存疑', hits, near: [],
    reason: `命中「${hits.slice(0, 3).join('、')}」，但它们与标签「${label}」在图上都无边`,
  }
}

/**
 * 批量判定某个任务的样本（默认 `doc_route_weak`）。
 * @returns {{rows:Array, summary:object}}
 */
export function verifyTask(task = 'doc_route_weak', { projectRoot, file } = {}) {
  const { index, graph, nodeCount } = buildTermIndex(projectRoot)
  if (!graph) return { rows: [], summary: { error: `未找到知识图（projectRoot=${projectRoot}）` } }
  const adj = buildAdjacency(graph)

  const ds = buildDataset(task, { file })
  // ⚠️ 弱标注的标签在 `prediction` 里（label 为空 —— 那是"未经人工确认"的正确语义）
  const rows = ds.map((x) => {
    const label = x.prediction ?? x.label
    const j = judgeSample(x.input, label, { index, adj })
    return { ...j, label, input: x.input, confidence: x.confidence, ref: x.ref }
  })

  const summary = { task, total: rows.length, nodeCount, termCount: index.size, graphNodes: nodeCount }
  for (const r of rows) summary[r.verdict] = (summary[r.verdict] || 0) + 1
  return { rows, summary }
}

/** 渲染报告（人可读） */
export function renderVerify({ rows, summary }, { show = 12 } = {}) {
  const L = []
  if (summary.error) return `⚠️ ${summary.error}`
  L.push('══ 用知识库筛选样本 ══')
  L.push(`任务「${summary.task}」　共 ${summary.total} 条　知识图 ${summary.graphNodes} 节点　词表 ${summary.termCount} 词`)
  L.push('')
  const pct = (n) => `${((n / Math.max(summary.total, 1)) * 100).toFixed(0)}%`
  L.push(`  ✅ 支持      ${String(summary['支持'] || 0).padStart(4)} 条（${pct(summary['支持'] || 0)}）　文本直接命中该档的术语`)
  L.push(`  🟡 弱支持    ${String(summary['弱支持'] || 0).padStart(4)} 条（${pct(summary['弱支持'] || 0)}）　与命中档图上相邻`)
  L.push(`  🔴 存疑      ${String(summary['存疑'] || 0).padStart(4)} 条（${pct(summary['存疑'] || 0)}）　标签与命中档都无边 ⇒ **建议排除**`)
  L.push(`  ⬜ 无法判定  ${String(summary['无法判定'] || 0).padStart(4)} 条（${pct(summary['无法判定'] || 0)}）　⚠️ **不能判无效**：表有覆盖缺口`)
  L.push('')
  const sus = rows.filter((r) => r.verdict === '存疑').slice(0, show)
  if (sus.length) {
    L.push(`── 存疑样本（前 ${sus.length} 条，建议你核一下）──`)
    for (const r of sus) {
      L.push(`  [conf=${r.confidence}] 标签「${r.label}」`)
      L.push(`     ${r.reason}`)
      L.push(`     文本: ${String(r.input).slice(0, 64).replace(/\n/g, ' ')}…`)
    }
  }
  const good = rows.filter((r) => r.verdict === '支持').slice(0, Math.min(6, show))
  if (good.length) {
    L.push(`── 支持样本（前 ${good.length} 条，标签有证据）──`)
    for (const r of good) {
      L.push(`  [conf=${r.confidence}] 标签「${r.label}」命中「${r.hits.slice(0, 3).join('、')}」`)
    }
  }
  return L.join('\n')
}
