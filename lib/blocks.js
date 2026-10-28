/**
 * blocks.js — 语境分块：**解决"这个语境对，但另一个语境没必要报"**
 *
 * ⚠️ 2026-10-27 加了两层：
 *   · `splitBlocks()`（旧的）—— 按**发言边界**切，粒度最细（研究里叫 over-segmentation）
 *   · `semanticBlocks()`（新）—— 按**语义相似度骤降**切，这才是"话题边界"
 *   ⇒ 调用方：有向量就用语义版，没向量就降级到发言版，**且文案要分别说清**。
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
import { cosine } from './librarian.js'

/** 一块的形态：从一次用户发言起，到下次用户发言前 */
/**
 * ⚠️⚠️ 2026-10-27 承认一个真实缺陷：**本函数切的是「发言边界」，不是「话题边界」**。
 *
 *   症状（作者实测：「话题切换检测的效果不太好」）：会话里用户说 61 句话，
 *   它就报「已换过 60 段话题」——**它数的是轮数**。
 *
 *   根因：`用户说话 = 新指令 = 新语境` 这个假设是错的 —— 人可以连续说 5 句同一件事。
 *   ⇒ 「发言边界」只是**粒度最细**的切法（研究里叫 over-segmentation）。
 *
 *   ⇒ 真正的语义分块见本文件末尾的 `semanticBlocks()`（滑动窗口 + 余弦骤降），
 *     本函数保留为**降级路径**（没有向量索引时用它，且文案要说清是"轮数"不是"话题"）。
 */
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
export function renderBlocksBrief(blocks, { mask = [], driftThreshold = 8, longBlock = 60, topicSwitches = null, currentTurns = null } = {}) {
  if (!blocks?.length) return ''
  const cur = currentBlock(blocks)
  const block = blocks[cur]
  /**
   * ⚠️ 2026-10-27 改：`topicSwitches` 由调用方给出（语义分块算出的**真实**切换次数）。
   *   给了就用它判定「话题漂移」，否则回退到「块数」（= 轮数，粒度最细的近似）。
   *   ⇒ 两者的报文言辞**必须不同** —— "已聊 N 轮" 与 "换了 N 次话题" 不是一回事。
   *
   *   ⚠️ `currentTurns` 同理：语义块里**当前段有几条用户发言**。
   *     不用 `block.items.length` 的原因：按发言切块时每块只有几条痕迹，**几乎永不触发**。
   */
  const hasSemantic = typeof topicSwitches === 'number' && topicSwitches >= 0
  const drifted = hasSemantic ? topicSwitches >= 3 : blocks.length >= driftThreshold
  const segLen = typeof currentTurns === 'number' && currentTurns > 0 ? currentTurns : block.items.length
  const tooLong = segLen >= longBlock
  if (!drifted && !tooLong) return ''                 // ← 默认沉默
  const cut = (s) => maskWords(String(s || '').slice(0, 24), mask)
  const driftText = hasSemantic
    ? (topicSwitches > 0 ? `最近换了 ${topicSwitches} 次话题` : null)
    : `已聊了 ${blocks.length} 轮`
  const why = [drifted ? driftText : null, tooLong ? `当前这一段已经 ${segLen} 轮` : null]
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

/**
 * ★ **语义分块**（2026-10-27 加）—— 用「相邻窗口的向量余弦骤降」找**真正的话题边界**
 *
 * ══ 为什么要有它（作者实测：「话题切换检测的效果不太好，是不是？」）════════
 *   `splitBlocks()` 按「用户每次发言」切块 ⇒ 60 句话 = 60 段"话题"。
 *   而**「发言边界」不是「话题边界」**：人可以连续说 5 句同一件事。
 *
 * ══ 研究共识（三件套，缺一不可）═══════════════════════════════════
 *   ① **滑动窗口**（左 k 条 vs 右 k 条）——单句对单句噪声太大（TextTiling / BERT-TT）
 *   ② **动态阈值**（本会话相似度中位数 × factor）——写死阈值实测调不出来
 *      （历史实测：45%→3 块、55%→33 块、65%→69 块，全不可用）
 *   ③ **minGap**（两次边界至少隔 N 条）——纯语义切割的通病是**过分割**
 *      （实测警告：LLaMA 系 splitter「找到了所有真实边界，也产生了大量错误边界」）
 *
 * ⚠️ **样本 < 4 条时返回 threshold=null** —— 那是「判不了」，不是「没有切换」。
 * @param {Array<{i:number, vec:number[]}>} userTurns 用户发言（i=痕迹下标，vec=该条向量）
 * @returns {{blocks:Array<{start:number,end:number,count:number}>, boundaries:number[], sims:number[], threshold:number|null}}
 */
export function semanticBlocks(userTurns, { k = 2, minGap = 2, factor = 0.8 } = {}) {
  const n = userTurns?.length || 0
  const single = (arr) => ({ blocks: arr.length ? [{ start: arr[0].i, end: arr[arr.length - 1].i, count: arr.length }] : [], boundaries: [], sims: [], threshold: null })
  if (n < 4) return single(userTurns || [])
  const meanVec = (arr) => {
    const dim = arr[0]?.vec?.length || 0
    if (!dim) return null
    const out = new Array(dim).fill(0)
    for (const it of arr) for (let d = 0; d < dim; d++) out[d] += it.vec[d] || 0
    for (let d = 0; d < dim; d++) out[d] /= arr.length
    return out
  }
  const sims = []
  for (let t = 0; t < n - 1; t++) {
    const l = meanVec(userTurns.slice(Math.max(0, t - k + 1), t + 1))
    const r = meanVec(userTurns.slice(t + 1, Math.min(n, t + 1 + k)))
    sims.push(l && r ? cosine(l, r) : 0)
  }
  const sorted = [...sims].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const threshold = +(median * factor).toFixed(4)
  /**
   * ⚠️ 边界检测两步（2026-10-27 实测修正）：
   *   第一版直接「低于阈值就切」⇒ 双话题构造上切出 **[4, 6] 两个边界**（实际只有一个话题转换）。
   *   根因：窗口跨边界时，边界两侧会各出一个低点。
   *   ⇒ ① 只留**局部极小**（比左右都低）② 相邻边界距离 < minGap 时**合并**（保留更低那个）。
   */
  const rawBounds = []
  for (let t = 0; t < sims.length; t++) {
    if (sims[t] >= threshold) continue
    const left = t === 0 ? Infinity : sims[t - 1]
    const right = t === sims.length - 1 ? Infinity : sims[t + 1]
    if (sims[t] > left || sims[t] > right) continue      // 只要局部极小
    rawBounds.push(t)
  }
  const boundaries = []
  for (const t of rawBounds) {
    const last = boundaries[boundaries.length - 1]
    if (last !== undefined && t - last < minGap) {
      if (sims[t] < sims[last]) boundaries[boundaries.length - 1] = t   // 合并：留更低的
      continue
    }
    boundaries.push(t)
  }
  const blocks = []
  let start = 0
  for (const b of boundaries) {
    blocks.push({ start: userTurns[start].i, end: userTurns[b].i, count: b - start + 1 })
    start = b + 1
  }
  blocks.push({ start: userTurns[start].i, end: userTurns[n - 1].i, count: n - start })
  return { blocks, boundaries, sims, threshold }
}
