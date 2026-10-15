/**
 * repetition.js — 持续言语检测器（perseveration detector）· 潜意识功能之一
 *
 * ══ 它是什么 ══════════════════════════════════════════════════════
 * 潜意识的声音：「**我正在重复自己**」。
 * 对应生物学：perseveration（持续言语）—— 同一内容不受控地反复产生。
 * 对应本项目：`REPORT.md` 记录的"推理循环"事故。
 *   ⚠️ **具体形态与占比数据不在本文件重复** —— `REPORT.md` §五「描述即传播」已定这条纪律：
 *     描述症状的文本本身可能成为传播介质。**要了解机制，读 `REPORT.md` 的推理部分。**
 *
 * ══ 为什么它是【纯程序】而不是模型 ══════════════════════════════════
 * 作者 2026-10-15 定的方向：潜意识"**不要智力，只要准确提醒**"。
 * 而重复检测的特征是【字符级/句子级的统计显著】，不是语义理解 ——
 *   · 不需要 embedding（省掉 118ms/条的 embed）
 *   · 不可能产生幻觉（它只数数，不生成）
 *   · 结果可解释、可复核（"这个片段出现了 N 次"是硬事实）
 * ⇒ 这正是"广义模型"（最小可处理单元）的正确形态：
 *   **一个功能 = 一个专用检测器，能不用生成式模型就不用。**
 *
 * ══ 神经学对照（设计的依据，非装饰）════════════════════════════════
 *   ACC（前扣带皮层）的"冲突监测"：检测到冲突 → 发 ERN 信号（错误后 50~100ms，
 *   **比意识察觉更早**）→ 交给前额叶控制。**ACC 不解决问题，只报警。**
 *   本检测器同构：不解释、不建议、只报"哪一段在重复、重复了多少"。
 *
 * ══ ⚠️ 关于症状样本 ═══════════════════════════════════════════════
 *   `REPORT.md` §五 立过规矩：**不要把症状词抄进对话或文档**（描述即传播）。
 *   故本文件的注释与测试用例**一律使用中性构造样本**，不引用事故中的真实片段。
 */

/** 把一个片段规整成可比较的形式（去空白，避免换行/空格干扰计数） */
const norm = (s) => s.replace(/\s+/g, '')

/**
 * ① 句子级重复率：按标点断句后，重复句占全部句子的比例。
 *    对应事故特征「同一短句出现 N 次」（实测那类块里单句出现上百次）。
 */
export function segRepeat(text, { minSegLen = 2 } = {}) {
  const segs = text
    .split(/[。！？；\n.!?;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= minSegLen)
  if (!segs.length) return { n: 0, uniq: 0, ratio: 0, top: null, topCount: 0 }

  const counts = new Map()
  for (const s of segs) counts.set(s, (counts.get(s) || 0) + 1)

  let top = null, topCount = 0
  for (const [k, v] of counts) if (v > topCount) { topCount = v; top = k }

  const uniq = counts.size
  // 重复率 = 多出来的重复次数 / 总句数（1 个句子出现 146 次 ⇒ 145/146 = 99%）
  return { n: segs.length, uniq, ratio: segs.length ? (segs.length - uniq) / segs.length : 0, top, topCount }
}

/**
 * ② 字符级 n-gram 重复率：滑动窗口取 n 字片段，算"非唯一片段"的比例。
 *    对正常中文文本通常在低位；循环文本会显著升高。
 *    ⚠️ 阈值必须用【本项目的真实文本】标定，不能照搬别的语料 —— 见 calibrate()。
 */
export function ngramRepeat(text, { n = 6 } = {}) {
  const s = norm(text)
  if (s.length < n * 2) return { n, total: 0, uniq: 0, ratio: 0 }
  const seen = new Set()
  let total = 0
  for (let i = 0; i + n <= s.length; i++) { seen.add(s.slice(i, i + n)); total++ }
  return { n, total, uniq: seen.size, ratio: total ? 1 - seen.size / total : 0 }
}

/**
 * ③ 最长连续重复：形如 X X X … 的直接重复。
 *    这是【最硬】的循环特征 —— 正常写作几乎不会连续重复同一句三遍以上。
 *    返回重复次数最多的那个片段与其次数。
 */
export function longestRun(text, { minUnit = 2, minRepeat = 3, maxUnit = 40 } = {}) {
  const s = norm(text)
  let best = { unit: '', count: 0, chars: 0 }
  // 逐个单元长度试：命中即记录，取"覆盖字符最多"的那个
  for (let u = minUnit; u <= maxUnit; u++) {
    // 该单元长度下的最大连续重复次数
    let i = 0
    while (i + u * minRepeat <= s.length) {
      const unit = s.slice(i, i + u)
      let k = 1
      while (s.slice(i + k * u, i + (k + 1) * u) === unit) k++
      if (k >= minRepeat) {
        const chars = u * k
        if (chars > best.chars) best = { unit, count: k, chars }
        i += k * u
      } else {
        i++
      }
    }
  }
  return best
}

/**
 * 综合判定。返回一个【只答问题、不作解释】的最小结果 —— 符合"潜意识只报警"的定位。
 *
 * @returns {{
 *   level: 'ok'|'watch'|'stuck',   // ok=正常, watch=有点重复, stuck=判定为循环
 *   reasons: string[],             // 命中了哪几条特征（给调试/日志用，不含原文）
 *   metrics: object
 * }}
 */
export function detectRepetition(text, opts = {}) {
  const seg = segRepeat(text, opts)
  const ng = ngramRepeat(text, opts)
  const run = longestRun(text, opts)

  // ⚠️ 阈值【用 271 段真实正常思考标定】，不是凭感觉取的。实测基线：
  //     句子重复率   P50=4.0%   P95=15.5%  Max=28.3%
  //     6-gram重复率 P50=18.0%  P95=33.1%  Max=46.2%   ← 中文天然就高，噪声大
  //     最长连续重复 P95=0 次    Max=5 次                ← ★ 唯一能干净分离的指标
  //   循环样本实测：连续重复 8~80 次；stuck 误报 0（正常文本无一达到 6 次）。
  //   ⇒ 设计原则：**主力靠「连续重复」**（本质特征，干净）；
  //     另两个阈值抬到正常 Max 之上，只作"极端情况"的补充，避免淹没式误报。
  const T = {
    segRatio: opts.segRatio ?? 0.55,   // 正常 Max 28.3% ⇒ 抬到 55%
    ngRatio: opts.ngRatio ?? 0.50,     // 正常 Max 46.2% ⇒ 抬到 50%（原设 0.25 是错的，误报 20.7%）
    minSegs: opts.minSegs ?? 8,        // 句数太少时比例不稳，不判
    runRepeat: opts.runRepeat ?? 6,    // 正常 Max 5 次 ⇒ 6 次即分离
    ...(opts.T || {}),
  }

  const reasons = []
  if (seg.ratio >= T.segRatio && seg.n >= T.minSegs) reasons.push(`句子重复率 ${(seg.ratio * 100).toFixed(0)}%（最高单句出现 ${seg.topCount} 次）`)
  if (ng.ratio >= T.ngRatio) reasons.push(`字符片段重复率 ${(ng.ratio * 100).toFixed(0)}%`)
  if (run.count >= T.runRepeat) reasons.push(`连续重复同一片段 ${run.count} 次（共 ${run.chars} 字）`)

  // 连续重复是最硬的特征：单独命中即判 stuck
  const hard = run.count >= T.runRepeat
  const level = hard ? 'stuck' : reasons.length ? 'watch' : 'ok'

  return { level, reasons, metrics: { seg, ng, run } }
}

/**
 * 阈值标定辅助：对一批【正常文本】跑一遍，看看基线分布在哪。
 * 用法：calibrate(正常文本数组) → 建议阈值
 * ⚠️ 别用事故样本做标定 —— 那会把阈值定偏，且违反 REPORT.md §五 的规矩。
 */
export function calibrate(texts) {
  const rows = texts.map((t) => ({
    seg: segRepeat(t).ratio,
    ng: ngramRepeat(t).ratio,
    run: longestRun(t).count,
  }))
  const pick = (key, q) => {
    const v = rows.map((r) => r[key]).sort((a, b) => a - b)
    return v.length ? v[Math.floor((v.length - 1) * q)] : 0
  }
  return {
    n: rows.length,
    segP50: pick('seg', 0.5), segP95: pick('seg', 0.95), segMax: pick('seg', 1),
    ngP50: pick('ng', 0.5), ngP95: pick('ng', 0.95), ngMax: pick('ng', 1),
    runP95: pick('run', 0.95), runMax: pick('run', 1),
  }
}

/**
 * 渲染成给模型看的文本。
 * ⚠️ 铁律（同 alertText）：**不回报原文片段** —— 回报就等于把重复样本注回上下文。
 *    只说"哪一段、重复了多少"，让模型自己回去看。
 *    ⚠️ 注意用词：本模板的每个字都要过 leak-check（曾经把判据触发词写进模板过）。
 */
export function renderRepetition(pos, result) {
  if (!result || result.level === 'ok') return ''
  const where = pos ? `第 ${pos} 处` : '当前这段'
  const head = result.level === 'stuck'
    ? `⚠️ ${where} 的痕迹【高度疑似在自我重复】`
    : `${where} 的痕迹有重复倾向`
  const lines = [head]
  for (const r of result.reasons) lines.push(`- ${r}`)
  lines.push('- 这只是统计特征，不代表内容一定有问题；需要时回看那一处自行判断。')
  return lines.join('\n')
}
