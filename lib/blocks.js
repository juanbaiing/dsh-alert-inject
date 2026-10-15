/**
 * blocks.js — 语境分块：**解决"这个语境对，但另一个语境没必要报"**
 *
 * ══ 解决的问题（作者 2026-10-15 指出两次，第一次我漏了）══════════════
 *   作者原话：「**基于上下文的知识分块参考召回**，这个是解决不同语境下的误报，
 *   即，**这个语境对，但另外一个语境没必要报的情况**。」
 *   以及：「**目标是会在局部改变和扭曲的**」。
 *   ⇒ 这两句其实是同一件事的两面：**语境块就是局部目标**。
 *
 * ══ 实测数据（2026-10-15，真实会话 1116 条痕迹）═════════════════════
 *   按用户发言分块 → 58 块（平均 19.2 条/块，中位 10）。
 *   判据命中的分布：
 *     「我的老毛病」12 处 → 分布在 **7 个不同块**
 *     「疑惑」      33 处 → 分布在 **10 个不同块**
 *     ★ **当前块内命中 0 处** ⇒ 全库报 45 处、当前语境 0 处
 *       **= 100% 是跨语境的误报**。
 *   ⇒ 这解释了为什么"插件一直在报、但大多无用"：**它报的是别的语境的事。**
 *
 * ══ 为什么用【用户发言】作分块边界（而不是向量聚类）═══════════════
 *   · **免费**：不用 embed（会话全量 1116 条 embed 要 8 分钟；向量聚类实测阈值也难定：
 *     45%→3 块（太粗）、55%→33 块、65%→69 块（太细））。
 *   · **有语义**：用户说话 = 新指令 = 新语境。这是人给的自然边界，不是统计巧合。
 *   · **可解释**：每块都能用"用户说了什么"来命名，便于向使用者交代。
 *
 * ══ ⚠️ 块过滤的边界（不要过度过滤）═══════════════════════════════
 *   有些问题是**【跨语境通用】的**（如"引用了不存在的文件"）——
 *   它们在任何语境下都该报。故本模块**只提供分块与过滤能力**，
 *   由调用方决定用多严的策略：
 *     · `'current'` —— 只报当前块（最严，误报最低，可能漏）
 *     · `'recent'`  —— 当前块 + 最近 N 块（折中）
 *     · `'all'`     —— 不过滤（旧行为）
 *   ⇒ 默认取 `'current' + 摘要其他块`：**既不淹没，也不隐藏**（告诉使用者"另有 N 处在别的语境"）。
 */

/** 一块的形态：从一次用户发言起，到下次用户发言前 */
export function splitBlocks(acts) {
  const blocks = []
  let cur = { index: 0, start: 0, items: [], head: null }
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]
    // ⚠️ 遇到用户发言且当前块非空 ⇒ 开新块。用户发言本身归入新块（它是新语境的起点）。
    if (a.kind === '用户' && cur.items.length > 0) {
      blocks.push(cur)
      cur = { index: blocks.length, start: i, items: [], head: null }
    }
    if (!cur.head && (a.kind === '用户' || a.kind === '思考' || a.kind === '正文')) {
      cur.head = String(a.text || '').replace(/\s+/g, ' ').slice(0, 80)
    }
    cur.items.push(i)
  }
  if (cur.items.length) blocks.push(cur)
  return blocks
}

/** 痕迹下标 → 块号 */
export function indexBlockMap(blocks) {
  const m = new Map()
  for (const b of blocks) for (const i of b.items) m.set(i, b.index)
  return m
}

/** 当前块号 = 最后一块（模型正在写的这一块） */
export const currentBlock = (blocks) => blocks.length ? blocks[blocks.length - 1].index : -1

/**
 * 判定某个块算不算"在范围内"。
 * @param mode 'current'（默认）| 'recent' | 'all'
 */
export function inScope(blockIdx, blocks, mode = 'current', { recent = 2 } = {}) {
  if (mode === 'all') return true
  const last = currentBlock(blocks)
  if (blockIdx === last) return true
  if (mode === 'recent') return blockIdx >= last - recent
  return false
}

/**
 * 给判据命中做语境过滤与分组。
 * @param hits [{block, ...}] 每处命中需带 block 字段
 * @returns {{inScope:[], other:[], otherBlocks:number}}
 */
export function filterByScope(hits, blocks, mode = 'current', opts = {}) {
  const inS = [], other = []
  for (const h of hits) (inScope(h.block, blocks, mode, opts) ? inS : other).push(h)
  return { inScope: inS, other, otherBlocks: new Set(other.map((h) => h.block)).size }
}

/**
 * 打码：把文本里的【判据词】替换掉。
 *
 * ⚠️ 为什么必须做（2026-10-15 实测踩坑）：语境块摘要要引用"这一块在谈什么"，
 *   而它取自**用户发言原文** —— 而用户说话里天然会有「不要」「不是」「其实」这类词，
 *   **它们正是判据的信号词**。摘要一旦回显，就等于把用户源样本植入上下文，
 *   **下一轮「落档纪律」又会匹配到它** ⇒ 自我喂食（REPORT.md §二·v4 的病因）。
 *   ⇒ 故：摘要保留形态，但把判据词打码为 `〔…〕`。
 *   ⚠️ 词表由调用方传入（本模块不依赖判据表，避免耦合）。
 */
export function maskWords(text, words) {
  if (!text || !Array.isArray(words) || !words.length) return text
  let out = String(text)
  // 长词优先，避免短词先替换后把长词切碎
  for (const w of [...words].filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (out.includes(w)) out = out.split(w).join('〔…〕')
  }
  return out
}

/**
 * **语境简报**（2026-10-15 加，经两轮验收测试后定型）。
 *
 * ⚠️ 两轮教训：
 *   ① 完整版（列历史块）→ **76% 是列表项、608 字** ⇒ **像仪表盘，不像声音**。
 *   ② 简报初版（永远报"当前在谈什么"）→ 62 字，但**那条信息是冗余的**：
 *      "现在在谈什么"——**模型自己正在谈，它当然知道**。
 *   ⇒ 定稿：**默认不出声**。只有两种情况才说话：
 *     · 话题漂移过多次（`drifted`）—— 提醒"你这一路换了 N 段话题，回头看看主线"
 *     · 当前块极长（`longBlock`）—— 提醒"这一段已经很长了"
 *   ⇒ 这与 tokensaver 的 **never-worse 门控** 同源：
 *     **不值得占位的东西，就不要发出去。**
 */
export function renderBlocksBrief(blocks, { mask = [], driftThreshold = 8, longBlock = 60 } = {}) {
  if (!blocks?.length) return ''
  const cur = currentBlock(blocks)
  const block = blocks[cur]
  const drifted = blocks.length >= driftThreshold
  const tooLong = block.items.length >= longBlock
  if (!drifted && !tooLong) return ''                 // ← 默认沉默
  const cut = (s) => maskWords(String(s || '').slice(0, 24), mask)
  const why = [drifted ? `已换过 ${blocks.length} 段话题` : null, tooLong ? `当前这段已 ${block.items.length} 条` : null]
    .filter(Boolean).join('；')
  return `🧩 ${why} —— 主线目标值得回头确认一次（当前在谈：${cut(block.head)}）`
}

/** 渲染块的摘要（**verbose 版，供人工/调试**；模型看的是 renderBlocksBrief） */
export function renderBlocks(blocks, { max = 8, headLen = 44, mask = [] } = {}) {
  if (!blocks?.length) return ''
  const last = currentBlock(blocks)
  const cut = (s) => maskWords(String(s || '').slice(0, headLen), mask)
  const lines = [`🧩 【语境】本次对话分 ${blocks.length} 块（按你的每次发言切分）`]
  lines.push(`- **当前块**（块${last}，${blocks[last].items.length} 条）：${cut(blocks[last].head)}`)
  if (blocks.length > 1) {
    const others = blocks.slice(0, last).slice(-max)
    lines.push(`- 之前的块（最近 ${others.length} 个）：`)
    for (const b of others) lines.push(`  · 块${b.index}（${b.items.length} 条）：${cut(b.head)}`)
  }
  return lines.join('\n')
}
