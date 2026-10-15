/**
 * novelty.js — 新颖性检测器 · 潜意识功能之一
 * 潜意识的声音：「**这是新东西**」——本会话里第一次出现的模式。
 *
 * ══ 与 FOK 的关系（先说清，否则会做出重复的东西）═════════════════
 *   两者都是【解读器】，共用同一个向量检索（见 librarian）。判据必然部分重叠
 *   （同一份数据、同一个分离点 ≈59%）。**若只做成"低分即新颖"，它就是 FOK 的镜像，没有独立价值。**
 *
 *   真正的区别在**时间朝向**：
 *     · `fok.js`     面向**过去** ——「我之前知道吗？」→ 决定**要不要深入查**（闸门）
 *     · `novelty.js` 面向**未来** ——「这值得固化吗？」→ 决定**要不要记录/落档**（巩固）
 *   神经学对应：**新颖性正是记忆巩固（consolidation）的触发器** ——
 *   新奇刺激驱动海马体的记忆写入；旧信息则不重复固化。这不是比喻，是机制。
 *
 * ══ 因此它有一个【FOK 没有的】独立信号：术语覆盖率 ════════════════
 *   向量相似度只看"像不像过去的某段话"。但还有一类新，是**用旧词构成新话题**，
 *   以及**全新领域的出现**。故本模块额外测：
 *     · 术语命中数（对照 `_术语表.md`）——命中 0 ⇒ 可能是全新领域
 *   ⇒ 综合判据 = 向量最高分 ＋ 术语覆盖率。这是 FOK 不具备的角度。
 *
 * ══ ⚠️ 误报的代价不对称（决定了该偏保守还是偏激进）═══════════════
 *   · 误报"这是新的" ⇒ 使用者可能以为遇到新话题而放松核对 —— **代价较高**
 *   · 漏报"旧的"     ⇒ 少一次提示 —— 代价较低
 *   ⇒ 故本模块**偏保守**：只有在两个信号都指向"新"时才判 novel。
 */

import { query as librarianQuery } from './librarian.js'

/**
 * 阈值 —— 沿用 fok.js 标定的分离点（两组实测完全分离，分离点 ≈59%）：
 *   有对应 top1：65~79%（p50 70）｜没对应 top1：43~53%（p50 46）
 * ⚠️ 但新颖性的下界要比 FOK 更靠下（偏保守），故 novel 档取 <0.50：
 *   没对应组实测最高 53%，取 0.50 可把该组全部纳入；有对应组最低 65%，不会被误判。
 */
export const NOVELTY_OPTS = {
  knownAbove: +(process.env.NOVELTY_KNOWN || 0.60),  // ≥ 此值 = 不新（≥ 有对应组下沿附近）
  novelBelow: +(process.env.NOVELTY_NOVEL || 0.50),  // < 此值 = 全新（没对应组实测最高 53%）
  termColdMax: +(process.env.NOVELTY_TERM_COLD || 0), // 术语命中数 ≤ 此值算"冷"（全新领域）
  termWarmMin: +(process.env.NOVELTY_TERM_WARM || 3), // 术语命中数 ≥ 此值算"热"（已知领域）
}

/** 术语覆盖率：文本命中了多少个已知术语（对照 `_术语表.md`） */
export function termCoverage(text, termWords) {
  const hits = []
  for (const w of termWords || []) {
    if (w && text.includes(w)) hits.push(w)
  }
  return { count: hits.length, sample: hits.slice(0, 5) }
}

/**
 * 判断新颖性。
 * @param result   librarian.query() 的返回值
 * @param text     当前内容（用于术语覆盖）
 * @param termWords 术语表词表（`loadTermWords()` 的结果）
 * @returns {{level, novelty, advice, metrics}}
 *   level: 'novel'（全新）| 'partly'（已知领域内的新内容）| 'known'（已知）
 */
export function assess(result, text, termWords = [], opts = {}) {
  const T = { ...NOVELTY_OPTS, ...opts }
  const top = (result?.top || []).slice().sort((a, b) => b.sim - a.sim)
  const maxSim = top[0]?.sim ?? 0
  const tc = termCoverage(text || '', termWords)

  // 新颖度分数：1 - 最高相似度（直观且可解释）
  const novelty = +(1 - maxSim).toFixed(4)

  let level
  if (maxSim >= T.knownAbove) {
    level = 'known'
  } else if (maxSim < T.novelBelow) {
    // 保守：向量说"新"还不够，**术语也冷**才算全新
    level = tc.count <= T.termColdMax ? 'novel' : 'partly'
  } else {
    level = 'partly'
  }

  // 建议 —— 面向未来：**要不要记录/固化**
  let advice
  if (level === 'novel') {
    advice = '本会话中未出现相近内容，且几乎未触及已知术语 —— 可能是一个新话题或新概念，值得留意（是否需要落档由你判断）。'
  } else if (level === 'partly') {
    const why = tc.count > T.termColdMax
      ? `属于已知领域（命中 ${tc.count} 个已知术语），但具体内容是新出现的。`
      : '与既有内容只有弱关联，具体表述是新出现的。'
    advice = `${why}通常无需特别处理；若认为它是个新说法，可考虑记录。`
  } else {
    advice = '与本次对话中既有内容高度相近，不算新。'
  }

  return {
    level,
    novelty,
    advice,
    metrics: { maxSim, termHits: tc.count, termSample: tc.sample, top1Pos: top[0]?.pos ?? null },
  }
}

/** 端到端：给一段内容，先检索、再判新颖性。⚠️ 不新建索引。 */
export async function assessText(index, text, termWords = [], opts = {}) {
  const r = await librarianQuery(index, text, opts.query || {})
  return { ...assess(r, text, termWords, opts), scanned: r.scanned, total: r.total }
}

/**
 * renderNovelty 的强化版：**把"疑似新知识"这句话直接说出来**。
 *
 * 作者 2026-10-15 的要求：「**回忆同时返回一个"这个疑似新知识"**」——
 * 即：检索出位置的同时，顺带告知"这里可能有一条值得记录的东西"。
 * 这样"发现"不必等专门的扫描任务，**日常回忆本身就是发现的入口**。
 *
 * ⚠️ 仍然只给【指针 + 等级】，不回显原文（回显 = 自我喂食）。
 * ⚠️ 措辞纪律：说"疑似值得记录"，**不判"这是一条知识"** —— 是否收录由待审决定。
 */
export function renderNoveltyHint(result) {
  if (!result) return ''
  if (result.level === 'known') return ''
  const m = result.metrics
  if (result.level === 'novel') {
    return `🆕 【疑似新知识】当前内容在本会话中未出现相近记录（最高相似 ${(m.maxSim * 100).toFixed(0)}%，已知术语命中 ${m.termHits} 个）——若你认为其中含可复用的结论，可考虑记入待审。`
  }
  return `🔹 【可能是新说法】属于已知领域，但具体表述是新出现的（最高相似 ${(m.maxSim * 100).toFixed(0)}%）。`
}

/**
 * 回忆的组合渲染：**位置 + 新颖性提示**一次返回。
 * @param queryResult  librarian.query() 的结果
 * @param noveltyResult novelty.assess() 的结果（可省略）
 */
export function renderRecall(queryResult, noveltyResult, librarianRender) {
  const parts = []
  if (librarianRender) parts.push(librarianRender(queryResult))
  if (noveltyResult) parts.push(renderNoveltyHint(noveltyResult))
  return parts.filter(Boolean).join('\n\n')
}

/**
 * 渲染。
 * ⚠️ 铁律同 alertText：不回显原文；本模板每字都要过 leak-check。
 * ⚠️ 措辞纪律：报"未出现相近内容"，**不判"这是创新/这是错的"**。
 */
export function renderNovelty(result) {
  if (!result) return ''
  const icon = result.level === 'novel' ? '🆕' : result.level === 'partly' ? '🔹' : '⚪'
  const line = result.level === 'novel' ? '本会话首次出现的模式'
    : result.level === 'partly' ? '已知领域内的新内容'
      : '已有相近内容'
  const m = result.metrics
  const lines = [`${icon} 【新颖性】${line}（最高相似 ${(m.maxSim * 100).toFixed(0)}%｜已知术语命中 ${m.termHits} 个）`]
  lines.push(result.advice)
  return lines.join('\n')
}
