/**
 * fok.js — Feeling of Knowing 闸门 · 潜意识功能之一 · **架构枢纽**
 *
 * ══ 它是什么 ══════════════════════════════════════════════════════
 * 潜意识的声音：「**我好像知道这个**」——话到嘴边、有模糊印象、但取不出来。
 *
 * 认知科学的定义（[Oxford: On Dual Process Theory and Metacognition in Embodied AI](https://ora.ox.ac.uk/objects/uuid:c0e5e364-e03c-489c-b584-2d5ae0b51d6f/files/s6969z1320)）：
 *   > The Feeling of Knowing process enables humans to effectively
 *   > **choose a cognitive strategy likely to succeed**
 *   ⇒ **它的作用不是"想起内容"，而是"决定要不要费力去找"。**
 *
 * ══ 为什么它是架构枢纽（而不是又一个检索器）══════════════════════
 *   参考 SOFAI（[npj AI 2025](https://www.nature.com/articles/s44387-025-00027-5)）：
 *     S1（快，自动）→ 元认知模块 → **决定要不要叫醒 S2（慢）**
 *     S2 【只有被元认知显式调用时才会启动】。
 *   **本模块就是那个元认知判断。** 对应本项目的说法：
 *     「潜意识先响 → **闸门决定要不要叫醒模型组** → 模型组分析」
 *
 * ══ ⚠️ 与既有实现的分工（作者 2026-10-15 问"是不是做过了"）═══════
 *   **做过的部分**：检索侧。`_court.js`（查表）、`librarian`（向量）、
 *     `.疑惑库.json` + `_疑惑链接.md`（"还有 N 个相关问题"，**只给数字**）。
 *   **没做的部分**：决策侧 —— **"我有多大把握""该不该深入查"**。
 *   ⇒ 本模块【不新建索引】，只对已有检索结果做**另一种解读**。
 *     这正是"引擎"与"解读器"的区分：同一个检索引擎，可有多个解读器。
 *
 * ══ 判断依据：为什么看"分布形态"而不是单一分数 ═══════════════════
 *   FOK 的典型场景恰恰是【有多个中等相似度的候选、但没有一个突出】——
 *   那正是"我记得有，但说不清在哪"的形态。
 *   反之，一个突出高分 = "我确定知道"；全是低分 = "我确实不知道"。
 */

import { query as librarianQuery, OPTS as LIB_OPTS } from './librarian.js'

/**
 * 阈值 —— ⚠️ **用真实检索结果标定**，实测过程如下（2026-10-15）：
 *
 *   场景 A【有对应】：用索引内条目当查询，`anchor=` 该条目下标 ⇒ **只查它的历史**
 *     （自身必被排除）—— 模拟"我正在写一段与经历有关的内容"。
 *     实测 top1：65% / 77% / 79% / 70% / 72% / 70%  →  min 65%  p50 70%  max 79%
 *
 *   场景 B【没对应】：用与项目完全无关的日常文字查询。
 *     实测 top1：47% / 46% / 43% / 53%  →  min 43%  p50 46%  max 53%
 *
 *   ⇒ **两组完全分离**（有对应最低 65% > 没对应最高 53%），**分离点 ≈ 59%**。
 *
 *   ★ 关键发现：**真实场景下 top1 只有 65~79%，从来达不到 85%。**
 *     初版照"自匹配 100%"设了 certain=0.85 ⇒ **该档永不触发**（那是错误校准的产物）。
 *     ⇒ 含义：**「确定知道」在真实对话中很少见，绝大多数是「好像知道」。**
 *       这恰恰是 FOK 值得存在的原因 —— 它捕捉的正是那个模糊中间态。
 *
 * ⚠️ 「确定知道」（certain）不靠 FOK 单独实现 —— 若当前内容与历史几乎逐字重合，
 *    那是**重复**问题，应由 `repetition.js` 报（它实测零误报）。两者分工不同。
 */
export const FOK_OPTS = {
  certain: +(process.env.FOK_CERTAIN || 0.75),   // ≥ 此值 = 有明确对应（实测有对应组 3/6 落此档）
  fuzzy: +(process.env.FOK_FUZZY || 0.58),       // ≥ 此值 = 好像知道（分离点 59% 略下）
  gapMin: +(process.env.FOK_GAP || 0.06),        // top1 领先 top2 多少才叫"指向明确"（实测 gap 多在 1~9pp）
  maxDeep: +(process.env.FOK_MAX_DEEP || 3),     // fuzzy 时建议回看几处
}

/**
 * 对一个检索结果做 FOK 判断。
 * @param result librarian.query() 的返回值 {top:[{pos,kind,sim}], ...}
 * @returns {{level, confidence, advice, pointers, metrics}}
 *   level: 'certain' | 'fuzzy' | 'unknown'
 *   advice: 给使用者的一句话（**只陈述，不判决**）
 */
export function assess(result, opts = {}) {
  const T = { ...FOK_OPTS, ...opts }
  const top = (result?.top || []).slice().sort((a, b) => b.sim - a.sim)

  if (!top.length) {
    return {
      level: 'unknown', confidence: 0,
      advice: '本次痕迹里没有与当前内容相近的位置。',
      pointers: [], metrics: { top1: 0, top2: 0, gap: 0, near: 0 },
    }
  }

  const s1 = top[0].sim
  const s2 = top[1]?.sim ?? 0
  const gap = s1 - s2
  // "中高档候选"的个数 —— FOK 场景的特征是有好几个"都有点像"
  const near = top.filter((t) => t.sim >= T.fuzzy).length

  let level
  if (s1 >= T.certain) level = 'certain'
  else if (s1 >= T.fuzzy) level = 'fuzzy'
  else level = 'unknown'

  // 指南（advice）—— 这是闸门真正的产出：**决定要不要叫醒慢速分析**
  let advice
  if (level === 'certain' && gap >= T.gapMin) {
    advice = '有一处明确对应，可直接按指针回看，通常无需再展开检索。'
  } else if (level === 'certain') {
    advice = '有高分对应，但另有多处分数接近；若要定案，建议一并比对。'
  } else if (level === 'fuzzy') {
    advice = `未出现明确对应，但有 ${near} 处分数接近。`
      + (near >= 2 ? '这正是"记得有、却说不准在哪"的形态——建议回看确认后再下结论。' : '建议回看确认。')
  } else {
    // ⚠️ 措辞纪律：只陈述"未找到"，**不判决"你在编"**。
    //    因为基于自身知识作答是正当的；本模块只提供"库里有没有"这个事实。
    advice = '本次痕迹里未找到明显相近的位置。若正要给出结论，请注意核对来源。'
  }

  return {
    level,
    confidence: s1,
    advice,
    pointers: top.slice(0, level === 'fuzzy' ? T.maxDeep : 1).map((t) => ({ pos: t.pos, kind: t.kind, sim: t.sim })),
    metrics: { top1: s1, top2: s2, gap: +gap.toFixed(4), near },
  }
}

/**
 * 端到端：给一段当前内容，先检索、再判断。
 * ⚠️ 不新建索引 —— 复用 librarian 的索引与缓存。
 */
export async function assessText(index, text, opts = {}) {
  const r = await librarianQuery(index, text, opts.query || {})
  return { ...assess(r, opts), scanned: r.scanned, total: r.total, minDist: r.minDist }
}

/**
 * 渲染给模型看。
 * ⚠️ 铁律同 alertText：**不回显原文**，只给等级/指针/建议。
 * ⚠️ 本模板每个字都要过 leak-check。
 */
export function renderFok(result) {
  if (!result) return ''
  const icon = result.level === 'certain' ? '✅' : result.level === 'fuzzy' ? '🤔' : '⚪'
  const line = result.level === 'certain' ? '有明确对应'
    : result.level === 'fuzzy' ? '好像知道（有几分像，但不确定）'
      : '没找到相近记录'
  const lines = [`${icon} 【知晓感】${line}`]
  if (result.pointers?.length) {
    lines.push('可回看的位置：' + result.pointers.map((p) => `pos=${p.pos}(${(p.sim * 100).toFixed(0)}%)`).join('、'))
  }
  lines.push(result.advice)
  return lines.join('\n')
}
