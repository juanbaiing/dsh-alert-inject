/**
 * samples.js — 样本记录：**这个体系能不能"长起来"的唯一前提**
 *
 * ══ 为什么这是当前最关键的一环 ══════════════════════════════════
 * 本项目文档里已经两次写到同一个结论（`_警觉与检索.md` §四④）：
 *   > **路由器要从表长成模型，靠的是样本**；臣子要微调，也靠样本。
 *   > **⇒ 缺的只是"皇帝每次派活存一条"这个动作。目前没有任何地方在存。**
 * 作者 2026-10-15 再次指出：「**规则太死，无法长起来**」。
 *   ⇒ 规则今天 93%，明天还是 93%；而 Laya 零样本 36% → 校准后 76.6% → 样本越多越准。
 *   ⇒ **不存样本，前面所有工作都是死的。** 故本模块优先于任何进一步的功能开发。
 *
 * ══ 两种样本，后者比前者贵得多 ═══════════════════════════════════
 *   ① **判断样本**：程序做了一个判断 + 它的置信度 —— **没有标签**，需要事后标注。
 *   ② **纠正样本**：作者指出「不是 A，是 B」 —— **自带标签**，是免费的、最高质量的标注。
 *   ⇒ 而 ② 正好是判据「落档纪律」抓的东西（`sources: ["用户"]`）。
 *     它此前因为一个提取 bug **从未触发过**（2026-10-15 修复），现在是可用的样本源。
 *
 * ══ 格式设计：为"任何特化模型"预留，不为某一种绑定 ═══════════════
 *   调研结论（2026-10-15）：值得训练的特化模型至少有三种形态 ——
 *     · **Laya**（System 1 决策）：要 (input, question, answer, 概率)
 *     · **Reranker**（bge-reranker-v2-m3 等 cross-encoder）：要 (query, passage, label)
 *     · **分类器**（SetFit/NLI 微调）：要 (text, label)
 *   ⇒ 故统一记 `{task, input, extra, prediction, confidence, label, labelSource}`，
 *     训练时按 task 过滤、再投影成各自需要的形态。**不要为某一种模型定死字段。**
 *
 * ══ ⚠️ 存储纪律 ═════════════════════════════════════════════════
 *   · 用 **JSONL 追加**（不重写整个文件）—— 训练脚本逐行读，且写入永不丢历史。
 *   · **只追加、不改写**：历史样本是资产，判错了也留着（将来可能正是需要的负例）。
 *   · 标注通过**追加一条 label 事件**表达，而不是回头改原行（保持 append-only）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const SAMPLE_OPTS = {
  file: process.env.SAMPLES_FILE || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'learning-samples.jsonl'),
  maxBytes: +(process.env.SAMPLES_MAX_MB || 64) * 1024 * 1024,   // 超过就轮转，防无限增长
}

/**
 * 内容指纹 —— **决定"这条样本是否已经记过"**。
 *
 * ══ 为什么必须有它（2026-10-15 实测暴露）══════════════════════════
 *   `alert_check` 每次被调用都会**重扫当前会话的全部痕迹**。
 *   而「作者纠正」的采集是"扫痕迹找纠正句"——**同一句话会在每一轮被重新找到**。
 *   ⇒ 没有指纹，接上采集线就等于**每轮往样本库灌一遍历史**，
 *     样本数会随轮数**平方增长**，且全是重复。
 *
 * ⚠️ 指纹**不含 ts**（时间戳必然不同），只取"这条判断的内容身份"。
 *    ⇒ 同一判断无论何时调用，只落一条。
 *
 * ⚠️ **`right` 必须单独计入**（2026-10-15 自测抓到的真 bug）：
 *    初版写的是 `obj.input ?? obj.wrong ?? obj.right` —— **取到 `wrong` 就停了**，
 *    于是「同一句错话 → 两种不同的正确说法」会算出**同一个指纹**，第二条被静默丢弃。
 *    ⇒ 现改为**各字段各占一位**（null 与空串都记为空），避免"短路取一个"的语义。
 */
export function fingerprint(obj) {
  const key = [
    obj.kind ?? '',
    obj.task ?? '',
    obj.input ?? '',        // pred 的输入
    obj.wrong ?? '',        // corr 的输入（被纠正的说法）
    obj.right ?? '',        // corr 的标签（正确说法）—— **不可省**
    typeof obj.prediction === 'string' ? obj.prediction : JSON.stringify(obj.prediction ?? ''),
    /**
     * ⚠️⚠️ `inputPrefix` **必须进指纹**（2026-10-16 实测抓到的真 bug）。
     *
     *   `label()` 事件**只有** `{kind:'label', task, inputPrefix, label, labelSource}` ——
     *   上面六个字段它**一个都不带**（`input`/`wrong`/`right`/`prediction` 全是 undefined）。
     *   ⇒ 少了这一项，**所有 label 事件的指纹完全相同** ⇒ `append` 判为"已经记过了"
     *   ⇒ **从第二条起全部被静默跳过**。
     *
     *   实测后果：批量补标 557 条负例，只落下 **1 条** label ⇒
     *   `buildDataset` 里 556 条标签为 `null` ⇒ **负例等于一条没采到**，
     *   而输出显示的是"记了 557 条 pred" —— **看不出标签丢了**。
     *   （同 §240「有数据、有逻辑、有测试，产出 0 条」那一族。）
     */
    obj.inputPrefix ?? '',
  ].join('\u0000')
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)
}

/**
 * 已见指纹集合。**按 mtime 缓存**，避免每次 append 都全文件重读。
 * ⚠️ 轮转（rename）时**保留内存中的集合** —— 否则轮转后旧指纹全丢，历史样本会被重新记录一遍。
 */
let seenCache = { file: null, mtime: 0, set: null }
function seen(file) {
  try {
    const st = fs.statSync(file)
    if (seenCache.file === file && seenCache.mtime === st.mtimeMs && seenCache.set) return seenCache.set
    const set = seenCache.file === file && seenCache.set ? seenCache.set : new Set()
    for (const e of loadSamples({ file })) if (e.h) set.add(e.h)
    seenCache = { file, mtime: st.mtimeMs, set }
    return set
  } catch {
    // 文件不存在（首次运行 / 刚轮转）—— 保留已有集合，不清空
    return seenCache.file === file && seenCache.set ? seenCache.set : new Set()
  }
}

/**
 * 追加一行（永不抛：样本记录绝不能影响主流程）。**幂等**：指纹已见则跳过。
 *
 * ⚠️ 2026-10-16 导出给 `tools/classify-labels.mjs` 用。
 * ⚠️ 它**只写 `SAMPLE_OPTS.file`**（不接 file 参数）——
 *    调用方要换文件，必须**在 import 本模块之前**设好 `SAMPLES_FILE` / `DSH_ALERT_DATA_DIR`，
 *    而不是把路径传进来（传了会被忽略，于是"以为写到 A、其实写到 B"）。
 */
export function append(obj) {
  try {
    const h = fingerprint(obj)
    const s = seen(SAMPLE_OPTS.file)
    if (s.has(h)) return false          // 已记过 —— append-only 语义下"再记一次"没有意义
    // 体积保护：轮转而不是截断（保留全部历史）
    try {
      const st = fs.statSync(SAMPLE_OPTS.file)
      if (st.size > SAMPLE_OPTS.maxBytes) {
        fs.renameSync(SAMPLE_OPTS.file, SAMPLE_OPTS.file.replace(/\.jsonl$/, `.${Date.now()}.jsonl`))
      }
    } catch { /* 文件不存在则无需轮转 */ }
    s.add(h)                             // 先占位，防同进程内连续两次写入重复
    const line = JSON.stringify({ ts: new Date().toISOString(), h, ...obj }) + '\n'
    fs.mkdirSync(path.dirname(SAMPLE_OPTS.file), { recursive: true })
    fs.appendFileSync(SAMPLE_OPTS.file, line, 'utf8')
    return true
  } catch (e) {
    // ⚠️ §239：降级可以，**降级必须留痕** ——
    //   样本写入若静默失败，样本库会**悄悄停长**而没人知道（那正是 §238 的形状：
    //   一条功能半年没跑过，而所有指标看起来都正常）。
    console.warn('[alert-inject/samples] ⚠️ 样本写入失败（样本库可能没在增长）：',
      e instanceof Error ? e.message : String(e))
    return false
  }
}

/**
 * ① 记录一次【程序判断】——待标注。
 *
 * @param task        任务名（**训练时按它过滤**）。约定命名见下方 TASKS
 * @param input       模型要看的输入（原文）
 * @param prediction  程序给出的判断（字符串或对象）
 * @param confidence  置信度 0~1（有则记；Laya 的概率可直接放这里）
 * @param extra       任务特有的附加字段（如 reranker 需要的 passage / Laya 需要的 question）
 * @param ref         证据指针（pos / 文件路径等），便于事后回查与标注
 */
export function recordPrediction({ task, input, prediction, confidence = null, extra = {}, ref = null, by = 'rule' }) {
  if (!task || !input) return false
  return append({ kind: 'pred', task, by, input: String(input).slice(0, 4000),
    prediction, confidence, extra, ref, label: null, labelSource: null })
}

/**
 * ② 记录一次【纠正】——自带标签，最宝贵。
 *
 * ⚠️ 作者 2026-10-15 指出：**每一次纠正就是一条免费的高质量标注。**
 * @param wrong  被否定的说法
 * @param right  正确的说法
 * @param task   它属于哪个任务（可推断时填；推断不出就写 'unknown'）
 */
export function recordCorrection({ wrong, right, task = 'unknown', ref = null, context = '' }) {
  return append({ kind: 'corr', task, wrong: String(wrong || '').slice(0, 2000),
    right: String(right || '').slice(0, 2000), context: String(context).slice(0, 1000),
    ref, label: right ?? null, labelSource: 'user_correction' })
}

/**
 * ③ 给某次判断补标注（**追加一条事件**，不改原行）。
 * @param id  recordPrediction 返回不了 id（append-only 无自增），故用 (task, input 前缀) 定位
 */
export function label({ task, inputPrefix, label: lab, source = 'review' }) {
  if (!task || !inputPrefix) return false
  return append({ kind: 'label', task, inputPrefix: String(inputPrefix).slice(0, 200), label: lab, labelSource: source })
}

/** 读全部样本（原始事件流） */
export function loadSamples({ file = SAMPLE_OPTS.file } = {}) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

/**
 * 把事件流折叠成可训练数据集：
 *   · 取所有 pred 事件；
 *   · 用后续 label 事件（同 task + inputPrefix 匹配）覆盖其 label；
 *   · corr 事件**自成一类样本**（它的 label 就在事件里）。
 */
export function buildDataset(task, { file = SAMPLE_OPTS.file } = {}) {
  const evs = loadSamples({ file }).filter((e) => !task || e.task === task)
  const preds = evs.filter((e) => e.kind === 'pred')
  const labels = evs.filter((e) => e.kind === 'label')
  const corrs = evs.filter((e) => e.kind === 'corr')

  const out = []
  for (const p of preds) {
    let lab = p.label, src = p.labelSource
    for (const l of labels) {
      if (String(p.input).startsWith(l.inputPrefix)) { lab = l.label; src = l.labelSource }
    }
    out.push({ task: p.task, input: p.input, extra: p.extra || {}, prediction: p.prediction, confidence: p.confidence, label: lab, labelSource: src, ref: p.ref })
  }
  for (const c of corrs) {
    // ⚠️ 无输入的纠正样本必须剔除（2026-10-15 修）：`wrong` 同时是这条样本的 **input**。
    //    它为 null 时若照旧产出，会得到 `input: null, label: "…"` —— **没有输入、只有答案**，
    //    任何训练器都读不了，却会静默混进数据集充数。剔除条数由 `stats().unusableCorr` 报告。
    if (!c.wrong) continue
    out.push({ task: c.task, input: c.wrong, extra: { correction: true }, prediction: null, confidence: null, label: c.right, labelSource: 'user_correction', ref: c.ref })
  }
  return out
}

/** 统计：各任务的样本数、已标注数、纠正数 —— 用来判断"距能训练还有多远" */
export function stats({ file = SAMPLE_OPTS.file } = {}) {
  const evs = loadSamples({ file })
  const byTask = {}
  for (const e of evs) {
    const t = (byTask[e.task] ||= { pred: 0, labeled: 0, corr: 0 })
    if (e.kind === 'pred') t.pred++
    else if (e.kind === 'label') t.labeled++
    else if (e.kind === 'corr') t.corr++
  }
  const ds = {}
  for (const t of Object.keys(byTask)) {
    const d = buildDataset(t, { file })
    ds[t] = { total: d.length, labeled: d.filter((x) => x.label != null).length }
  }
  // ⚠️ 单独报告"有标签但无输入、因而训不了"的纠正样本 —— **不静默**
  const unusableCorr = evs.filter((e) => e.kind === 'corr' && !e.wrong).length
  return { file, events: evs.length, byTask, dataset: ds, unusableCorr }
}

/**
 * ⚠️ 报告"够不够训练"—— **不要凭感觉说"攒够了"**。
 * 门槛依据（项目文档已记）：**SetFit 公开门槛为「每类 8 条」**。
 *
 * ══ ⚠️⚠️ 2026-10-16 更正（实测，不是推演）════════════════════════════════
 *   本函数此前按 **「已标注总数 ≥ 8 × 类别数」** 判"可试训"。实测它**说了假话**：
 *
 *     user_correction: labeled 183, ready: **true**, note: "可试训"
 *     而实情：183 条 label **全是自由文本**（＝作者的纠正原话），**不是类别**；
 *             布尔标签 **0 条**；**负例 0 条**。
 *
 *   一个二元任务**只有一类样本**，却被报成"可试训" ——
 *   这正是 AGENTS.md §六 那条：**不是功能写错了，是"把关的东西自己坏了，而没人知道"**。
 *   （同类：§239「工具在跑但空转，还返回 ✅ 无异常」。）
 *
 *   ⇒ 改为**按类统计**，并且：
 *     · 类数不足 / 某一类不足 8 条 ⇒ 一律 `ready: false`，**写明缺哪一类、还差几条**；
 *     · 标签是自由文本（不同值多到不像类别）⇒ **不静默当成多类**，
 *       而是明说"标签不是类别，**判不了**"（硬规则 3：判据必须能表达「我不知道」）。
 */
export function readiness({ numClasses = 2, file = SAMPLE_OPTS.file } = {}) {
  const s = stats({ file })
  const need = 8 * numClasses
  /** 不同标签值超过这个数 ⇒ 认为"标签是自由文本，不是类别" */
  const FREE_TEXT_CLASSES = 20
  const rows = Object.entries(s.dataset).map(([task, d]) => {
    const ds = buildDataset(task, { file })
    const dist = {}
    for (const x of ds) {
      if (x.label == null) continue
      // ⚠️ 纠正样本的 label 是作者的原话 ⇒ 它是**正类**，不是"类别名"
      const c = x.labelSource === 'user_correction' ? '作者纠正（正类）' : String(x.label)
      dist[c] = (dist[c] || 0) + 1
    }
    const classes = Object.keys(dist)
    let ready, note
    if (!classes.length) {
      ready = false
      note = '一条已标注样本都没有'
    } else if (classes.length > FREE_TEXT_CLASSES) {
      ready = false
      note = `标签是**自由文本**（${classes.length} 个不同值）⇒ 它不是类别，**判不了能不能训**（要先定类别）`
    } else if (classes.length < numClasses) {
      ready = false
      const has = classes.map((c) => `${c} ${dist[c]} 条`).join('；')
      note = `只有 ${classes.length} 类（${has}）—— ${numClasses} 类任务至少要有 ${numClasses} 类 ⇒ **缺的那一类一条都没有**`
    } else {
      const short = classes.filter((c) => dist[c] < 8)
      ready = short.length === 0
      note = ready
        ? `每类都够：${classes.map((c) => `${c} ${dist[c]} 条`).join('；')}`
        : `这几类不够 8 条：${short.map((c) => `${c} 还差 ${8 - dist[c]} 条`).join('；')}`
    }
    return { task, labeled: d.labeled, total: d.total, need, classes: dist, ready, note }
  })
  return { need, rows }
}
