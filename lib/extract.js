/**
 * extract.js — 知识抽取：**让模型读文本建图，但由程序证明它没编**
 *
 * ══ 调研结论（2026-10-15，读过一手来源）═══════════════════════════
 *   ① 行业共识：**抽取结果只能当【候选】** ——
 *      [Atlan](https://atlan.com/know/ai-agent/knowledge-graph/knowledge-graph-construction-for-ai/)：
 *      "Treat all output as **candidate only**, gated by the validation step ahead"；
 *      "LLMs ... **infer plausible-sounding, false relationships** when left unconstrained"。
 *      [PuppyGraph](https://www.puppygraph.com/blog/graphrag-architecture)：
 *      "**NER misses entities, relation extractors hallucinate connections, and entity linking picks wrong matches**"
 *      ⇒ 三类错误：**漏实体、编关系、连错实体**。
 *   ② **schema-guided 优于开放式抽取**（[arXiv 2507.03226](https://arxiv.org/html/2507.03226v2)）——
 *      而本项目的 `_schema.md` 正好是那样一份 schema ⇒ **不必重新设计格式**。
 *   ③ 成本结构：抽取阶段"**nearly all the money goes**"（同上外的成本分析）
 *      ⇒ 故本模块**只做"提示词 + 校验"**，**不自己调 LLM** —— 抽取由调用方（模型）执行。
 *
 * ══ ⚠️ 本模块的立足点：**证据必须可核** ═════════════════════════════
 *   防幻觉最可靠的手段**不是**"让模型更小心"，而是**让它的每条输出都带原文片段，
 *   然后由程序逐字核对那个片段是否真的在原文里**。这是**纯程序、零成本、不可辩驳**的：
 *     · 片段在原文中 → 至少**这条边有出处**
 *     · 片段不在原文中 → **就是编的**，直接丢弃（不是"可能有问题"，是"确凿不存在"）
 *   ⇒ 而且本项目的 `_schema.md` **本来就要求 `cooccur` 带 `evidence`**
 *     （"让每条边都能回到一手资料"）—— **设计与需求天然吻合**。
 *
 * ══ ⛔ 本模块不做什么 ═════════════════════════════════════════════
 *   · **不生成 `gate` 边** —— `_两套图.md` 定死："门要少而准、手写、慎重"，
 *     绝不由统计或 LLM 生成（那是把"检索的路"刻进"读者的门"）。
 *   · **不判断实体消歧**（"两个名字是不是同一个东西"）—— 那是语义判断，
 *     本系统在此已两次实测失败。只做**字面级**的核对与提示。
 */

/**
 * 抽取用的 schema（源自 `_schema.md`，此处只取**可程序校验**的部分）。
 * ⚠️ 故意不把 `layer` 的自由度开大：layer 是 enum，抽取时必须落在枚举内，否则分层统计失效。
 */
export const SCHEMA = {
  nodeLayers: ['作者', '宇宙', '世界', '国区', '城', '个体', '跨层'],
  nodeLines: ['旧线', '新线', '跨线', '不涉线', '未声明'],
  /** ⚠️ 允许 LLM 产出的边类型只有 cooccur —— gate 只手写 */
  edgeTypes: ['cooccur'],
  /** 共现入库阈值（`_schema.md`：低于 3 的多半是一次偶然提及） */
  minWeight: 3,
}

/**
 * 生成【抽取提示词】。调用方（模型）拿它去读文档并产出 JSON。
 *
 * 设计要点（都是为了可校验）：
 *   · **强制 evidence**：每条的 `evidence` 必须是原文里**逐字存在**的片段。
 *   · **要求给出实体在原文中的落点**（`quote`），便于程序核对。
 *   · **明确禁止 gate**（schema 定死）。
 */
export function extractPrompt({ docId = '', docTitle = '', text = '' } = {}) {
  const S = SCHEMA
  return `你在做**知识抽取**，输出会被**程序逐字校验**，因此**宁可少抽，不可编造**。

## 待处理文档
- id：${docId || '（未给）'}
- 标题：${docTitle || '（未给）'}

## 原文
"""
${text}
"""

## 只允许抽取这些（超出范围的输出会被程序丢弃）
- 节点 layer ∈ ${JSON.stringify(S.nodeLayers)}
- 节点 line ∈ ${JSON.stringify(S.nodeLines)}
- **边只允许「cooccur」（共现）**。⚠️ **不要产出「gate」（读者的门）**——那类边按项目规定**只能手写**。

## 输出格式（严格 JSON，不要任何解释文字）
{
  "nodes": [
    { "id": "路径/不带扩展名", "title": "档名", "layer": "…", "line": "…",
      "quote": "原文中能佐证该实体存在的**逐字片段**" }
  ],
  "edges": [
    { "from": "节点id", "to": "节点id", "type": "cooccur", "weight": 3,
      "evidence": "原文中**逐字出现**的、能证明两者被一起提到的片段" }
  ]
}

## ⚠️ 三条硬要求（不满足会被程序直接丢弃）
1. **evidence / quote 必须与原文逐字一致**（可截取，但不得改写、不得补字）。
   程序会做**子串比对**：对不上的一律视为编造。
2. 抽不出来就**留空数组**，不要为了凑数编内容。**空输出是合法结果。**
3. 不确定就不写。**宁可漏，不可编** —— 这个库的立库之本是「什么是不对的，只有谁的说法」。`
}

/** 归一化：去掉空白与标点差异，做**宽松但仍是字面**的比对 */
function normForMatch(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[「」『』""''（）()【】\[\]，,。.、；;：:!！?？—–\-…·]/g, '')
}

/**
 * ★★ 核心：**逐条核对 evidence/quote 是否真的存在于原文**。
 *
 * 这是整个知识抽取里**唯一可靠**的防幻觉环节：
 *   · 它不是"判断这条关系对不对"（那需要语义理解，做不到）
 *   · 它是"证明这段文字**有没有出现过**"（字面比对，100% 确定）
 *
 * @returns {{ok:[], fabricated:[], stats}}
 */
export function verifyExtraction(parsed, sourceText) {
  const src = normForMatch(sourceText)
  const okNodes = [], badNodes = [], okEdges = [], badEdges = []

  for (const n of parsed?.nodes || []) {
    const q = normForMatch(n.quote)
    // ⚠️ 片段太短（<6 字）不足以证明任何东西 ⇒ 视为未提供
    const pass = q.length >= 6 && src.includes(q)
    ;(pass ? okNodes : badNodes).push({ ...n, _reason: pass ? '原文可核' : (q.length < 6 ? '片段过短，不足以佐证' : '原文中找不到该片段') })
  }

  for (const e of parsed?.edges || []) {
    const ev = normForMatch(e.evidence)
    const pass = ev.length >= 6 && src.includes(ev)
    const inSchema = SCHEMA.edgeTypes.includes(String(e.type || ''))
    const weightOk = !e.weight || Number(e.weight) >= SCHEMA.minWeight
    const ok = pass && inSchema && weightOk
    const reason = !inSchema ? `边类型「${e.type}」不在允许范围（只允许 ${SCHEMA.edgeTypes.join('/')}）`
      : !weightOk ? `weight ${e.weight} 低于阈值 ${SCHEMA.minWeight}`
        : ev.length < 6 ? '证据片段过短，不足以佐证'
          : !pass ? '原文中找不到该证据片段' : '原文可核'
    ;(ok ? okEdges : badEdges).push({ ...e, _reason: reason })
  }

  return {
    ok: { nodes: okNodes, edges: okEdges },
    fabricated: { nodes: badNodes, edges: badEdges },
    stats: {
      nodesIn: (parsed?.nodes || []).length,
      edgesIn: (parsed?.edges || []).length,
      nodesOk: okNodes.length, edgesOk: okEdges.length,
      // ⚠️ 这个比率本身就是有价值的指标：模型在此任务上的"编造率"
      fabricatedRate: (() => {
        const tot = (parsed?.nodes || []).length + (parsed?.edges || []).length
        const bad = badNodes.length + badEdges.length
        return tot ? +(bad / tot).toFixed(3) : 0
      })(),
    },
  }
}

/**
 * 转成【待审候选】（供 `learning.js` 的待审记使用）。
 * ⚠️ 只有**通过原文核对**的才转；被判定为编造的直接丢弃并留痕（不静默）。
 */
export function toCandidates(verified, { source = '' } = {}) {
  const out = []
  for (const n of verified.ok.nodes) {
    out.push({
      kind: 'node', class: '知识',
      payload: { id: n.id, title: n.title, layer: n.layer, line: n.line },
      evidence: n.quote, source, checked: true,
    })
  }
  for (const e of verified.ok.edges) {
    out.push({
      kind: 'edge', class: '知识',
      payload: { from: e.from, to: e.to, type: 'cooccur', weight: e.weight },
      evidence: e.evidence, source, checked: true,
    })
  }
  return out
}

/**
 * 渲染抽取报告（给使用者/模型看）。
 * ⚠️ 不回显证据原文（那是被抽取的文本，回显有自我喂食风险）——只报计数与理由。
 * ⚠️ 本模板每个字都要过 leak-check。
 */
export function renderExtraction(verified) {
  if (!verified) return ''
  const s = verified.stats
  if (!s.nodesIn && !s.edgesIn) return '📥 【抽取】模型未产出任何条目（**空输出是合法结果**，不为凑数而编）。'
  const lines = [`📥 【抽取】候选 ${s.nodesIn + s.edgesIn} 条：原文可核 ${s.nodesOk + s.edgesOk} 条，未通过 ${(s.nodesIn + s.edgesIn) - (s.nodesOk + s.edgesOk)} 条`]
  if (s.fabricatedRate > 0) {
    lines.push(`- ⚠️ 未通过率 **${(s.fabricatedRate * 100).toFixed(0)}%** —— 这部分是程序判定的"原文中不存在"，已丢弃并留痕。`)
  }
  const reasons = {}
  for (const x of [...verified.fabricated.nodes, ...verified.fabricated.edges]) {
    reasons[x._reason] = (reasons[x._reason] || 0) + 1
  }
  for (const [r, n] of Object.entries(reasons)) lines.push(`  · ${r}：${n} 条`)
  if (s.nodesOk + s.edgesOk) lines.push('- ✅ 通过核对的已转入待审；**要生效仍需人工/模型复核**（抽取是自动的，采用不是）。')
  return lines.join('\n')
}
