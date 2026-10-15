/**
 * knowledge.js — 知识层（常识库）：**把设定库的图接进来当参照源**
 *
 * ══ 定位（2026-10-15 作者确认）═══════════════════════════════════
 *   此前系统只有【经历层】（会话痕迹，`librarian`）。作者指出：
 *   **"这就是我说的常识库参考"** —— 项目里的设定库图就是知识层，**不用新建**。
 *     ├─ 经历层（episodic）＝ 会话痕迹        → `librarian` ✅ 已有
 *     └─ 知识层（semantic）＝ 设定库图 + 档正文 → **本模块**
 *
 * ══ 三项设计来源（都是现成的，本模块是"接进来"而非重写）════════════
 *   ① **遍历**：移植 `工具\_graph-recall.js` 的算法（种子 → 2 跳扩散 → 层调权 → 带理由召回）
 *   ② **树形**：合并 OpenViking 的"一切皆文件树"范式 —— **树做骨架、图做神经**
 *   ③ **标定**：参数不写死，用真实数据可标定（`calibrate()`）
 *
 * ══ ⚠️ 两套图必须分清（`_schema.md` 与 `_两套图.md` 定）═══════════
 *   · `gate`（读者的门，276 条）—— 手写；判据「读者读到 A，会想跳到 B 吗」
 *   · `cooccur`（检索的路，46 条）—— 统计；判据「查 A 时，要不要去看看 B」
 *   **> 门要少而准；路可以多而杂。**
 *   ⚠️ 遍历该走【`cooccur`】为主（那是"检索的路"）；`gate` 权重低一些，
 *      因为它是给**读者**开的门，不是给检索走的。**此前有人拿门的判据去筛路的
 *      结果、还准备据此改正档 —— 那是把"检索的路"刻进了"读者的门"（见 `_两套图.md`）。**
 *
 * ══ ⛔ 本模块不做的事（边界要清楚）════════════════════════════════
 *   它能说「查 X 时该去看看 Y」，**不能说「X 与 Y 矛盾」** ——
 *   后者需要语义判断，而该能力已两次实测失败（NLI 三版全败；向量比对 −2.8pp 且方向反）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { config, judgesPath, termsPath } from './config.js'

/** 遍历与标定参数（可被环境变量覆盖，也可被 calibrate() 的结果覆盖） */
export const KNOW_OPTS = {
  hops: +(process.env.KNOW_HOPS || 2),
  decay: +(process.env.KNOW_DECAY || 0.5),
  topN: +(process.env.KNOW_TOPN || 8),
  /**
   * gate 的权重折扣 —— **标定结论（2026-10-15，用文档给出的已知期望做探针）**：
   *   | gateWeight | 召回数 | cooccur 占比 | 命中期望 |
   *   |---|---|---|---|
   *   | **0**   | [1,8,1] | **100%** | 4/5 |
   *   | 0.2     | [3,8,3] | 60%      | — |
   *   | 0.5     | [6,8,6] | 19%      | 5/5 |
   *   | 1.0     | [6,8,6] | 13%      | 5/5 |
   * ⚠️ 依据 `_两套图.md`：**「检索该走②（检索的路），不是走①（读者的门）」** ——
   *    而 gate 有 276 条、cooccur 只有 46 条，若不折扣会**数量压制**（实测 gw=0.5 时 gate 占 81%）。
   * ⚠️ 但 gate 并非无用：它带结构性关联（如域内某两档只由 gate 相连，只走 cooccur 会漏）。
   *   ⇒ 故取 **0.3**：cooccur 主导，门只作补充；且**渲染时按来源分组**，不混成一个分。
   */
  gateWeight: +(process.env.KNOW_GATE_W || 0.3),
  /**
   * **向两侧递减**的层调权（作者设想，2026-10-13 01:55 原话）：
   *   > 把权重比作有活动分支的关节树，查询就是不断挥舞树枝直到末梢指向接收口；
   *   > **逻辑链太长，底层逻辑关节几乎不动，那部分完全可以降低占比**；
   *   > 而在这个场景里经常活动的就要特别注意。
   *
   * ⚠️ 此前实现是**二值**的（同层 ×1.5、其余 ×1.0）——**没有"递减"**。
   *   现改为按 **rank 距离**的梯度衰减。
   *
   * 取值依据（`_分层.md` 的实测，22 会话 / 86 次跨层读取）：
   *   | 在哪层发言 | 同层 | 往下 |
   *   |---|---|---|
   *   | 城   | 89% | 11% |
   *   | 世界 | 71% | 29% |
   *   | 宇宙 | 58% | **41%** |
   *   ⇒ **层级越高越会往下翻**；同层始终占最大头 ⇒ 距离 0 应最高、之后快速衰减。
   *   ⚠️ 但**不衰减到 0** —— 该文件的修正是「低层不是该忽略，是**当例证才用**」
   *     （实测往下查占 34.9%），故 distance≥3 仍保留 0.15 的地板。
   *   ⚠️ 方向**对称**（往两侧递减）：`_分层.md` 否掉了"往上查更多"（实测仅 1.2%），
   *     但也未显示"往上必然更少"，故不做方向偏置，只按距离。
   */
  layerDecay: (process.env.KNOW_LAYER_DECAY || '1.0,0.6,0.35,0.2,0.15')
    .split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x)),
  minScore: +(process.env.KNOW_MIN || 0.02),
}

/** 图文件候选路径（相对于 projectRoot） */
const GRAPH_CANDIDATES = [
  '※世界模拟/回想/_graph.json',
  '回想/_graph.json',
  '.dsh-alert/graph.json',
  'alert-graph.json',
]

/** 统一的命名空间前缀 —— **合并 OpenViking「一切皆文件树」范式**：树做骨架、图做神经 */
export const NS = {
  world: 'alert://world/',        // 世界知识（档，按 doc.id 的路径分层）
  graph: 'alert://graph/',        // 连通性（gate / cooccur / cite）
  session: 'alert://session/',    // 经历（会话痕迹 + 指针）
  learning: 'alert://learning/',  // 学习（待审 / 样本）
  meta: 'alert://meta/',          // 元信息（schema / 标定）
}

let _cache = { key: null, val: null }

/** 载入图（带 mtime 缓存）。找不到 ⇒ 返回 null，本模块静默关闭（其余功能不受影响）。 */
export function loadGraph(projectRoot) {
  const root = projectRoot || config().projectRoot
  if (!root) return null
  let file = null
  for (const rel of GRAPH_CANDIDATES) {
    const p = path.join(root, ...rel.split('/'))
    try { if (fs.existsSync(p)) { file = p; break } } catch { /* ignore */ }
  }
  if (!file) return null
  try {
    const st = fs.statSync(file)
    const key = `${file}:${st.mtimeMs}:${st.size}`
    if (_cache.key === key) return _cache.val
    const g = JSON.parse(fs.readFileSync(file, 'utf8'))

    // 建索引：邻接表 + 节点表 + 词→档
    const nodeById = new Map((g.nodes || []).map((n) => [n.id, n]))
    const maxCo = Math.max(1, ...(g.edges || []).filter((e) => e.type === 'cooccur').map((e) => e.weight || 0))
    const adj = new Map()
    const add = (a, b, w, type) => {
      if (!adj.has(a)) adj.set(a, [])
      adj.get(a).push({ to: b, w, type })
    }
    for (const e of g.edges || []) {
      // ⚠️⚠️ 邻接表里只存【原始权重】——**绝不在此处乘 gateWeight**。
      //   首版就是在这里乘的，于是权重被固化成模块常量：
      //   实测 gateWeight 传 0 / 0.2 / 0.5 / 1.0 结果**完全一样**（召回数都是 [6,8,6,8,0,8]），
      //   连标定都失去意义。⇒ 参数必须在 traverse() 里按 opts 现算。
      if (e.type === 'gate') add(e.from, e.to, 1.0, 'gate')
      else if (e.type === 'cooccur') {
        // ⚠️ cooccur 是"检索的路"，**双向**（共现无方向）；gate 是单向的门
        const w = (e.weight || 0) / maxCo
        add(e.from, e.to, w, 'cooccur'); add(e.to, e.from, w, 'cooccur')
      }
    }
    const wordToDoc = new Map()
    for (const t of g.terms || []) if (t.word && !wordToDoc.has(t.word)) wordToDoc.set(t.word, t.doc)

    const val = { file, schema: g.schema, generated: g.generated, nodes: g.nodes || [], edges: g.edges || [], terms: g.terms || [], nodeById, adj, wordToDoc, maxCo, counts: g.counts }
    _cache = { key, val }
    return val
  } catch { return null }
}

/**
 * 树形视图：**把扁平的 doc.id 变成可浏览的树**（OpenViking 范式的核心收益）。
 * `域/子域/类型/条目` → 逐级节点，带该节点的档与统计。
 */
export function tree(g) {
  if (!g) return null
  const root = { name: '', children: new Map(), docs: [], count: 0 }
  for (const n of g.nodes) {
    const parts = String(n.id).split('/')
    let cur = root
    cur.count++
    for (const p of parts.slice(0, -1)) {
      if (!cur.children.has(p)) cur.children.set(p, { name: p, children: new Map(), docs: [], count: 0 })
      cur = cur.children.get(p)
      cur.count++
    }
    cur.docs.push(n)
  }
  return root
}

/** 把树渲染成缩进文本（给人看/给模型看结构；⚠️ 不含档正文，只有路径与标题） */
export function renderTree(g, { maxDepth = 3, maxPerLevel = 12 } = {}) {
  const t = tree(g)
  if (!t) return ''
  const lines = [`${NS.world}（共 ${g.nodes.length} 档）`]
  const walk = (node, depth) => {
    if (depth > maxDepth) return
    const entries = [...node.children.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, maxPerLevel)
    for (const [name, child] of entries) {
      lines.push(`${'  '.repeat(depth)}├─ ${name}/  (${child.count})`)
      walk(child, depth + 1)
    }
    if (node.docs.length && depth <= maxDepth) {
      for (const d of node.docs.slice(0, maxPerLevel)) lines.push(`${'  '.repeat(depth)}· ${d.title}  [${d.layer}]`)
    }
  }
  walk(t, 1)
  return lines.join('\n')
}

/** rank 表（见 `_分层.md`：作者5／宇宙4／世界3／国区2／城1／个体0） */
export const RANKS = { '作者': 5, '宇宙': 4, '世界': 3, '国区': 2, '城': 1, '个体': 0 }

/**
 * ★ 检测【当前语境在谈哪一层】—— 这是"按语境取节点"的那一半。
 *
 * 作者设想（2026-10-13 01:55）：
 *   > 按语境来确认**取这棵树上的哪一个节点**，并**向两侧递减**
 * ⇒ 此前实现只做了"向两侧递减"，但**中心是"种子所在的层"（静态）**；
 *   本函数补上"中心随语境移动"。
 *
 * 做法（纯程序、零成本、可解释）：
 *   统计文本里命中的【术语】各自属于哪个 layer，取命中数最多的那一层作中心。
 *   ⚠️ 为什么取"最多"而非"最高"：`_分层.md` 实测显示**同层始终占最大头**
 *     （城 89% / 世界 71% / 宇宙 58%）——即"谈到的事大多在同一层"。
 *     取最高会把所有语境都拽到宇宙层，等于没做。
 *
 * @returns {{layer, rank, distribution, hits, confident}|null}
 */
export function detectContextLayer(text, gIn) {
  const g = gIn || loadGraph()
  if (!g || !text) return null
  const dist = {}
  let hits = 0
  for (const [w, doc] of g.wordToDoc) {
    if (!w || !String(text).includes(w)) continue
    const n = g.nodeById.get(doc)
    if (!n?.layer) continue
    dist[n.layer] = (dist[n.layer] || 0) + 1
    hits++
  }
  if (!hits) return null
  const sorted = Object.entries(dist).sort((a, b) => b[1] - a[1] || (RANKS[b[0]] ?? -9) - (RANKS[a[0]] ?? -9))
  const [layer] = sorted[0]
  return {
    layer,
    rank: RANKS[layer] ?? null,
    distribution: dist,
    hits,
    // 命中数太少时不可信（1 个术语命中也可能只是巧合）
    confident: hits >= 2,
  }
}

/**
 * **遍历**（移植自 `工具\_graph-recall.js`，并加标定、命名空间、语境中心）。
 *
 * 算法：① 术语命中做种子 → ② 沿图走 N 跳（衰减）→ ③ **按语境层的 rank 距离向两侧递减** → ④ 排序 + 保留理由
 * ⚠️ 保留 `why` 是刻意的：**每条召回都必须能回答"我为什么被想起来"**（可核验）。
 *
 * @param opts.centerRank 手动指定衰减中心层（缺省则由 `seedText` 检测）
 */
export function traverse(seedText, opts = {}, gIn) {
  const O = { ...KNOW_OPTS, ...opts }
  const g = gIn || loadGraph(opts.projectRoot)
  if (!g) return { available: false, reason: '未找到知识图（_graph.json）', seeds: [], hits: [] }

  // ① 种子：术语精确命中（不是向量——**这是"查表"，100% 准、零成本**）
  const score = new Map(), why = new Map(), seedSet = new Set()
  for (const [w, doc] of g.wordToDoc) {
    if (!w || !String(seedText).includes(w)) continue
    if ((score.get(doc) || 0) < 1.0) { score.set(doc, 1.0); why.set(doc, `种子·命中「${w}」`) }
    seedSet.add(doc)
  }
  if (!score.size) {
    return { available: true, seeds: [], hits: [], reason: '查询里没有术语命中 ⇒ 库里无从入口（**该报没有就报没有**）' }
  }

  // ② 扩散（⚠️ 权重在此现算：gate 乘 opts.gateWeight，cooccur 用它自己的归一化权重）
  const effW = (e) => (e.type === 'gate' ? e.w * O.gateWeight : e.w)
  let frontier = new Map(score)
  for (let h = 1; h <= O.hops; h++) {
    const next = new Map()
    for (const [id, s] of frontier) {
      for (const e of (g.adj.get(id) || [])) {
        const w = effW(e)
        if (w <= 0) continue                       // gateWeight=0 ⇒ 门完全不参与（"只走检索的路"）
        const v = s * w * Math.pow(O.decay, h)
        if (v <= O.minScore) continue
        if ((score.get(e.to) || 0) < v) {
          next.set(e.to, Math.max(next.get(e.to) || 0, v))
          why.set(e.to, `${h} 跳 ← ${(g.nodeById.get(id) || {}).title}（${e.type} ${w.toFixed(2)}）`)
        }
      }
    }
    for (const [k, v] of next) if ((score.get(k) || 0) < v) score.set(k, v)
    frontier = next
    if (!next.size) break
  }

  // ③ 层调权：**中心随语境移动 + 向两侧递减**
  //    ⚠️ 与首版的关键差别：中心不再是"种子所在的层"（静态），而是
  //      **当前语境在谈的那一层**（由 seedText 检测）；检测不出时退回种子层。
  const ctxLayer = opts.centerRank != null
    ? { layer: null, rank: opts.centerRank, distribution: {}, hits: 0, confident: true, manual: true }
    : detectContextLayer(seedText, g)
  const seedRanksSet = new Set()
  for (const id of seedSet) { const r = RANKS[g.nodeById.get(id)?.layer]; if (r !== undefined) seedRanksSet.add(r) }
  const centers = ctxLayer && ctxLayer.rank != null ? [ctxLayer.rank] : [...seedRanksSet]

  const decayOf = (layer) => {
    const r = RANKS[layer]
    if (r === undefined || !centers.length) return 1.0        // 跨层等无 rank 的，不加不减
    let best = Infinity
    for (const cr of centers) best = Math.min(best, Math.abs(r - cr))
    const arr = O.layerDecay || [1.0]
    return arr[Math.min(best, arr.length - 1)] ?? arr[arr.length - 1]
  }

  const hits = [...score.entries()].map(([id, s]) => {
    const n = g.nodeById.get(id) || {}
    // ⚠️ 种子【不参与层衰减】（实测缺陷修复）：种子是**术语直接命中的档**，
    //   它不该因为"所在层离语境中心远"而被压下去。
    //   实测反例：一个同时命中「城层档」与「宇宙层档」的查询在宇宙中心下，
    //   那个城层档被衰减到 0.2、掉到第 5 位 —— 而它明明是查询里点名的。
    //   ⇒ 修正：种子 boost 恒为 1.0；**衰减只作用于"扩散来的"档**。
    const isSeed = seedSet.has(id)
    const boost = isSeed ? 1.0 : decayOf(n.layer)
    return {
      id, title: n.title || id, layer: n.layer, line: n.line,
      score: +(s * boost).toFixed(4), raw: s, boost, isSeed, why: why.get(id),
      path: NS.world + id,          // ← 命名空间（树里的位置）
    }
  }).sort((a, b) => b.score - a.score).slice(0, O.topN)

  return {
    available: true,
    seeds: [...score.entries()].filter(([, v]) => v === 1.0).map(([k]) => k),
    hits,
    ctxLayer,                                    // ← 本次的语境层（可核验"中心在哪"）
    reason: null,
  }
}

/**
 * 标定：**用真实查询验证参数，而不是拍**。
 * 判据：种子档应当被排到前面（召回率）；且不应把无关层的大片档拉进来（精确率）。
 * @param probes [{ text, expect: docId[] }]  —— 期望命中的档
 */
export function calibrate(probes, gIn) {
  const g = gIn || loadGraph()
  if (!g) return null
  const grid = []
  for (const hops of [1, 2, 3]) {
    for (const decay of [0.3, 0.5, 0.7]) {
      for (const gw of [0, 0.5, 1.0]) {
        let hit = 0, tot = 0, pulled = 0
        for (const p of probes) {
          const r = traverse(p.text, { hops, decay, gateWeight: gw, topN: 10 }, g)
          if (!r.available) continue
          const ids = r.hits.map((h) => h.id)
          for (const e of (p.expect || [])) { tot++; if (ids.includes(e)) hit++ }
          pulled += ids.length
        }
        grid.push({ hops, decay, gateWeight: gw, recall: tot ? hit / tot : 0, avgPulled: probes.length ? pulled / probes.length : 0 })
      }
    }
  }
  grid.sort((a, b) => b.recall - a.recall || a.avgPulled - b.avgPulled)
  return { probes: probes.length, best: grid[0], grid }
}

/**
 * 渲染（给模型看）。
 * ⚠️ 铁律：**不返回档正文**（那是知识层内容，回显有自我喂食风险）——
 *    只给【路径 + 层 + 分数 + 召回理由】，要内容按路径自行去读。
 * ⚠️ **按来源分组**（`_两套图.md` 的精神：两套图是两件事，不混成一个分）：
 *    先列「作者原话关联」（cooccur —— 有 evidence 可回溯），再列「文档结构关联」（gate）。
 * ⚠️ 本模板每个字都要过 leak-check。
 */
export function renderTraverse(r, { max = 6 } = {}) {
  if (!r) return ''
  if (!r.available) return `⚪ 【知识层】${r.reason || '不可用'}`
  if (!r.hits.length) return `⚪ 【知识层】${r.reason || '没有召回到相关档。'}`

  const seeds = r.hits.filter((h) => !h.why || h.why.startsWith('种子'))
  const co = r.hits.filter((h) => h.why?.includes('cooccur'))
  const ga = r.hits.filter((h) => h.why?.includes('gate'))
  const lines = [`📚 【知识层】相关档 ${r.hits.length} 个（种子 ${seeds.length}）`]
  // ⚠️ 把"衰减中心在哪"说出来 —— 否则使用者无法核验"为什么这条比那条高"。
  //    这正是本系统一贯的纪律：**给出理由，而不只是结果**。
  if (r.ctxLayer?.rank != null) {
    const conf = r.ctxLayer.manual ? '手动指定' : (r.ctxLayer.confident ? '已定' : '样本偏少，仅参考')
    lines.push(`（调权中心：**${r.ctxLayer.layer || 'rank ' + r.ctxLayer.rank}层** — ${conf}${r.ctxLayer.hits ? `；命中 ${r.ctxLayer.hits} 个术语` : ''}）`)
  }

  const push = (list, limit) => {
    for (const h of list.slice(0, limit)) {
      lines.push(`- ${h.title}  [${h.layer}${h.line && h.line !== '未声明' ? '·' + h.line : ''}]  ← ${h.why}`)
    }
  }
  // ⚠️ 种子必须【最先】列出 —— 它是术语精确命中的档（100% 准），
  //    首版只在"既无 cooccur 又无 gate"时才显示它，导致最常见的正常情形下种子被漏掉。
  if (seeds.length) { lines.push('**当前内容直接命中的档**（术语精确匹配）：'); push(seeds, 3) }
  if (co.length) { lines.push('**作者原话里一起出现过的**（可回溯一手依据）：'); push(co, Math.max(2, max - 2)) }
  if (ga.length) { lines.push('**文档结构上的引用**（读者的门，非作者原话）：'); push(ga, 2) }

  lines.push('只给档的位置与来由，不含档文；需要时按标题去读。')
  return lines.join('\n')
}

/**
 * ★ 生长模板（作者 2026-10-15 定：「记录格式、标定生长模板」）
 *
 * 三类东西怎么长，纪律不同：
 * | 长什么 | 谁触发 | 纪律 |
 * |---|---|---|
 * | **新 `cooccur` 边** | **自动**（作者原话里共现 ≥3） | 必须带 `evidence`（原话片段）与 `ts` |
 * | **新 `gate` 边** | **人工，慎重** | 判据只有一条：读者会不会想跳 |
 * | **新 `doc` 节点** | 人工 / 由学习循环提议 | 必带 `layer` 与 `line`（否则分层统计失效） |
 * ⚠️ **不要把学习循环产出的候选直接写成 `doc` 或 `gate`** —— 那等于让模型自己扩世界设定。
 *    正确链路：候选 → 待审记 → 人审 → 才入库。
 */
export function growthTemplate(kind, payload = {}) {
  const base = { ts: new Date().toISOString().slice(0, 10), source: payload.source || '未署名' }
  switch (kind) {
    case 'cooccur':
      return {
        template: { type: 'cooccur', from: '', to: '', weight: 0, ...base, evidence: '' },
        rules: ['weight ≥ 3 才入库（低于此多半是一次偶然提及）', 'evidence 必填：必须是**作者原话片段**，不是接手者的转述', '自动生长，但每条都要能回到一手资料'],
      }
    case 'gate':
      return {
        template: { type: 'gate', from: '', to: '', ...base },
        rules: ['判据唯一：**读者读到 A，会不会想跳到 B**', '手写、慎重；改动用体检工具后**人工过滤输出**', '⚠️ 绝不可按共现自动补链（那是把"检索的路"刻进"读者的门"）'],
      }
    case 'doc':
      return {
        template: { id: '', title: '', layer: '', rank: 0, line: '', status: '正常' },
        rules: ['`id` 是主键：**相对你的档根目录的路径，不带扩展名**', '严禁两种写法（带不带扩展名 / 反斜杠还是正斜杠）—— 本项目曾因"同一东西两处存、格式不一致"一天内三次 bug', '`layer` 与 `line` 必填，否则分层统计与跨层流向失效', '⚠️ 由学习循环提议的新档**必须先入待审记**'],
      }
    default:
      return { template: null, rules: [`未知的生长类型：${kind}（支持 cooccur / gate / doc）`] }
  }
}

/**
 * ★ 知识库的【存储格式规范】（作者 2026-10-15 定：知识库用纯文本记录）
 *
 * 为什么要定死格式（量化理由，实测于本项目真实档案）：
 *   同一份档，js 形式 27306 字节 vs md 形式 22250 字节 —— **md 省 19%**；
 *   而某档 137 行里 **70 行是纯语法**（`const doc = {`、`],`）＝ **51%**。
 *   ⇒ AI 读 js 时，一半的行在处理括号和引号，不是在读内容。
 *   ⇒ 且档案内容含大量中文引号「」、`NOTE:`、`·`、`※` —— 在 md 里是原生语法，
 *     在 js 里是字符串内容，每次都要转义。**故：js 只该作产物（喂 make-docx 排版），不该作源。**
 *
 * 两层分工：
 *   · **正文** → `md`（人写、AI 读 —— 干净、省 token、diff 清晰）
 *   · **图**   → `jsonl`（程序精确读 + 追加式生长）—— 一行一条，不重写全文件
 */
export function formatSpec() {
  return {
    layout: [
      '知识库/',
      '├── 正文/<按 id 路径>.md        ← 人与 AI 共读；标题层级表达结构',
      '│     # 档名          → title',
      '│     ## 一、小节      → h1',
      '│     ### 分节         → h2',
      '│     > 引用           → 注释',
      '│     - 列表           → 条目',
      '├── graph/',
      '│   ├── nodes.jsonl     ← 一行一个档   {id,title,layer,rank,line,status}',
      '│   ├── cooccur.jsonl   ← 一行一条边   {from,to,type:"cooccur",weight,source,evidence,ts}',
      '│   ├── gate.jsonl      ← 一行一条边   {from,to,type:"gate",source,ts}',
      '│   └── cite.jsonl      ← 一行一条溯源 {from,to,speaker,ts}',
      '└── meta/schema.md      ← 结构说明（本项目的 _schema.md 已是 md ✅）',
    ],
    why: [
      '**md 作正文**：实测比等价 js 省 19% 字节；js 的语法行占比实测达 51%（纯噪音）；中文引号/反引号在 md 里无需转义。',
      '**jsonl 作图**：共现图"天天在变、自动生长"—— 追加一行即可，不必重写整个 JSON（现 `_graph.json` 是 77KB 单文件，每改一次全量重写）。',
      '**js 只作产物**：`_md2docjs.js` 自己的注释就是答案 —— "md → js（供 make-docx.js 生成 Word）"。',
    ],
    /** 这套映射不是新设计，而是**复用项目已有约定**（见 `工具\_md2docjs.js`） */
    mappingFrom: '复用 `工具\\_md2docjs.js` 已确立的 md↔行前缀 映射（# → title、## → h1、### → h2、> → NOTE:、- → ·）',
    /** jsonl 的落地纪律 */
    discipline: [
      // ⚠️ 用词纪律（第 4 次踩同类坑）：原句写"判错了也留着"，
      //    而「错了」正是判据「落档纪律」的信号词 ⇒ 自己泄漏自己。改用中性说法。
      '**追加不改写**：新边直接 append（与 `samples.js` 同一纪律）；历史是资产，即使结果有误也留着。',
      '**每条边必带 `ts` 与 `source`**（`_schema.md` 要求："每条边都必须能回答谁给的、什么时候给的"）。',
      '**`cooccur` 必带 `evidence`**（作者原话片段，非转述）——"让每条边都能回到一手资料"。',
      '**`gate` 只手写**，绝不由统计或 LLM 自动生成（`_两套图.md`：那是把"检索的路"刻进"读者的门"）。',
    ],
  }
}

/** 渲染格式规范（给人看/写进 README） */
export function renderFormatSpec({ layout = false } = {}) {
  const s = formatSpec()
  const out = ['【知识库格式规范】', ...s.why.map((x) => '- ' + x)]
  out.push('', '映射来源：' + s.mappingFrom)
  out.push('', '纪律：', ...s.discipline.map((x) => '- ' + x))
  if (layout) { out.push('', '目录结构：'); out.push(...s.layout.map((x) => '  ' + x)) }
  return out.join('\n')
}

/** 知识层诊断：图在不在、多大、参数是什么 */
export function diagnose(projectRoot) {
  const g = loadGraph(projectRoot)
  if (!g) return { ok: false, detail: `未找到知识图。试过：${GRAPH_CANDIDATES.join(' / ')}（在项目根下）` }
  const byType = {}
  for (const e of g.edges) byType[e.type] = (byType[e.type] || 0) + 1
  const byLayer = {}
  for (const n of g.nodes) byLayer[n.layer] = (byLayer[n.layer] || 0) + 1
  // ⚠️ 实测发现：`_graph.json` 里 indeg/outdeg 是 undefined（schema 说"由边算、不手填"，但实际没算）
  const noDeg = g.nodes.filter((n) => n.indeg === undefined).length
  return {
    ok: true, file: g.file, schema: g.schema, generated: g.generated,
    nodes: g.nodes.length, edges: g.edges.length, terms: g.terms.length,
    byType, byLayer, degreesMissing: noDeg,
    detail: `${g.nodes.length} 档 / ${g.edges.length} 边（${Object.entries(byType).map(([k, v]) => k + ' ' + v).join('｜')}）/ ${g.terms.length} 术语`,
    warn: noDeg ? `⚠️ ${noDeg} 个节点缺 indeg/outdeg（schema 要求"由边算"）⇒ 按入度排序不可用` : null,
  }
}
