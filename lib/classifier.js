/**
 * classifier.js — **给一句人话打标签**（可换模型 · 支持互证）
 *
 * ══ 作者 2026-10-16 的定稿（逐条）═══════════════════════════════════
 *   「给话打标签（也可以分类）**但不是实时的**（这个功能要留着，还要允许用户改模型），
 *     然后抓取数据的准确度和速度就快了不少，**还能互证**」
 *
 * ══ 三条设计（都是上面那句话的直接落地）══════════════════════════════
 *   ① **可换模型**：后端写成 `名字:地址`，改配置不改代码
 *        `ollama:qwen2.5:3b` · `laya:http://127.0.0.1:8123` · `none`
 *   ② **非实时**：不在 `alert_check` 热路径上。实测（本机 CPU）：
 *        Laya multilingual 端到端 **794 ms/条**（525ms 是纯前向）
 *        而 `alert_check` 的预算是 0.6~0.9s ⇒ **放热路径上会吃掉全部预算**，
 *        所以作者定的用法是对的：**攒着批量跑**。
 *   ③ **互证**：同一批话跑**两个以上**分类器，比较它们给出的标签。
 *        · 一致 ⇒ 可信
 *        · 不一致 或 **任一置信度低** ⇒ 标 `uncertain`，**不自动替谁做主**
 *          （硬规则 3：判据必须能表达「我不知道」）
 *
 * ⚠️ **本模块只判断、不写盘**（纯函数 + 一次 HTTP 调用）。
 *    写盘由调用方决定 —— 这样"能不能写、写到哪"永远只有一个地方说了算。
 */

import { providerInfo } from './provider.js'

// ══════════════════════════════════════════════════════════════════
// 标签定义（**分类表只有这一处**，改这里就改了全部）
// ══════════════════════════════════════════════════════════════════
/**
 * 一级分类：这句话**是干什么用的**。
 * ⚠️ 只放四个 —— 多了模型会犹豫（实测：4 类时正确答案概率 0.91~0.95，
 *    错误答案挤在 0.5 附近 ⇒ **置信度本身就能当"可疑"的判据**）。
 */
export const LABELS = {
  纠错: '用户在指出 AI 说错了、做错了、理解错了，或方向不对',
  指令: '用户在给新的任务、要求做事、说继续',
  提问: '用户在问一个问题（含反问、追问）',
  陈述: '用户在补充信息、陈述事实，没有要求也没纠错',
}

export const LABEL_NAMES = Object.keys(LABELS)

/** 置信度低于这个值 ⇒ 标 `uncertain`（不猜）。0.6 是实测取的：正确答案 ≥0.66，错误答案 ≤0.54 */
export const MIN_CONFIDENCE = +(process.env.DSH_ALERT_CLASSIFY_MIN_CONF || 0.6)

const QUESTION = {
  kind: {
    type: 'choice',
    instructions: '这句话属于哪一类？',
    criteria: LABELS,
  },
}

/**
 * 从模型自由文本里抠出标签（Ollama 那种"生成一句话"的后端用）。
 *
 * ⚠️⚠️ 必须**先精确匹配、再按长度降序包含匹配**（2026-10-16 实测抓到的真 bug）：
 *   第一版写成"按 `LABEL_NAMES` 声明顺序 `includes`"⇒ 模型明明**正确回了「陈述」**，
 *   却被判成「纠错」—— 因为**我自己的 prompt 里列出了全部四个标签名**，
 *   `includes('纠错')` 先命中 prompt 的回声，于是拿到一个**看起来合理但完全错误**的标签。
 *   ⇒ 它不报错、可判率也正常，只是标签**全是错的那一个**。
 *   ⇒ 两条对策：① 先整串精确比对；② 仍要包含匹配时**按名字长度降序**（长名更具体、更不容易误命中）。
 */
function pickLabel(rawText) {
  const s = String(rawText || '').trim()
  if (!s) return { label: null, confidence: null, why: '模型返回了空' }
  // ① 整串（或去掉首尾标点后）就是某个标签 ⇒ 最可靠
  const bare = s.replace(/^[\s"'`【\[（(]+|[\s"'`】\]）)。，,.!！?？]+$/g, '')
  if (LABEL_NAMES.includes(bare)) return { label: bare, confidence: null }
  // ② 退一步：取**最长**的标签名做包含匹配
  const hit = [...LABEL_NAMES].sort((a, b) => b.length - a.length).find((n) => s.includes(n))
  if (hit) return { label: hit, confidence: null }
  return { label: null, confidence: null, why: `模型输出里找不到任何已知标签：${s.slice(0, 60)}` }
}

// ══════════════════════════════════════════════════════════════════
// 后端 ①：Ollama（生成式，慢；但在多数机器上是现成的）
// ══════════════════════════════════════════════════════════════════
async function classifyWithOllama(text, { spec, timeoutMs }) {
  const model = spec.model || providerInfo().llmModel
  const base = spec.baseUrl || providerInfo().baseUrl
  // ⚠️ prompt 里**不列举全部标签名**（2026-10-16 实测）：列了之后模型的回复里
  //    可能带上别的标签名当回声，而解析器会先命中那个 ⇒ **标签错得看不出来**。
  //    标签的**定义**仍然给（不然它判不准），但只给定义、不给"可选清单"的样式。
  const prompt = '你在给一句话归类。四个类，各有各的意思：\n'
    + LABEL_NAMES.map((n) => `· 若${LABELS[n]}，就回：${n}`).join('\n')
    + `\n判断下面这句话符合哪一条，把该条的那个词回给我，别的什么都不说。\n`
    + `\n句子：${text}\n`
  const r = await fetch(base + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0 } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`)
  const out = pickLabel((await r.json()).response)
  return { ...out, model: `ollama:${model}` }
}

// ══════════════════════════════════════════════════════════════════
// 后端 ②：Laya（System One 决策模型，**自带置信度**）
// ══════════════════════════════════════════════════════════════════
async function classifyWithLaya(text, { spec, timeoutMs }) {
  const base = spec.baseUrl || 'http://127.0.0.1:8123'
  const body = { state: text, questions: QUESTION }
  if (spec.model) body.model = spec.model
  const r = await fetch(base + '/v1/systemone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) throw new Error(`Laya HTTP ${r.status}`)
  const j = await r.json()
  const ans = (j.answers || {}).kind || {}
  const probs = ans.probabilities || {}
  const label = ans.choice || null
  // ⚠️ 置信度**必须来自模型自己的概率**，不能自己编一个
  const confidence = label && typeof probs[label] === 'number'
    ? probs[label]
    : (typeof ans.confidence === 'number' ? ans.confidence : null)
  return { label, confidence, probs, model: `laya:${spec.model || 'default'}` }
}

/** 后端表 —— 加一个新的模型 = 往这里加一行 */
const BACKENDS = { ollama: classifyWithOllama, laya: classifyWithLaya }

// ══════════════════════════════════════════════════════════════════
// 对外
// ══════════════════════════════════════════════════════════════════
/**
 * 解析 `名字:地址` 形式的后端标识。
 *   `laya` / `laya:multilingual` / `laya:http://127.0.0.1:8123`
 *   `ollama` / `ollama:qwen2.5:3b` / `ollama:http://localhost:11434#qwen3:4b`
 * ⚠️ 解析失败**要说出来**（返回 why），不静默退回某个默认后端 —— 那会让"换模型没生效"无从察觉。
 */
export function parseBackend(str) {
  const s = String(str || '').trim()
  if (!s) return { ok: false, why: '后端标识为空' }
  const i = s.indexOf(':')
  if (i === -1) {
    const name = s.toLowerCase()
    return BACKENDS[name] ? { ok: true, kind: name, spec: {} } : { ok: false, why: `不认识的后端：${s}（只有 ${Object.keys(BACKENDS).join(' / ')}）` }
  }
  const kind = s.slice(0, i).toLowerCase()
  const rest = s.slice(i + 1)
  if (!BACKENDS[kind]) return { ok: false, why: `不认识的后端：${kind}` }
  // http 开头 ⇒ 地址；否则 ⇒ 模型名
  const spec = /^https?:\/\//i.test(rest) ? { baseUrl: rest.replace(/\/+$/, '') } : { model: rest }
  return { ok: true, kind, spec }
}

/**
 * 判一句话。
 * @returns {{ok:boolean, label:string|null, confidence:number|null, model:string, ms:number, probs?:object, why?:string}}
 *   ⚠️ 失败时 `ok:false` 且带 `why` —— **绝不返回一个编出来的标签**（硬规则 2）。
 */
export async function classifyOne(text, backendStr, { timeoutMs = 180000 } = {}) {
  const b = parseBackend(backendStr)
  if (!b.ok) return { ok: false, label: null, confidence: null, model: backendStr, ms: 0, why: b.why }
  const t0 = Date.now()
  try {
    const r = await BACKENDS[b.kind](String(text || ''), { spec: b.spec, timeoutMs })
    const ms = Date.now() - t0
    if (!r.label) return { ok: false, label: null, confidence: r.confidence ?? null, model: r.model, ms, probs: r.probs, why: r.why || '模型没给出可识别的标签' }
    if (!LABEL_NAMES.includes(r.label)) {
      return { ok: false, label: null, confidence: r.confidence ?? null, model: r.model, ms, probs: r.probs, why: `模型给了表外的标签：${r.label}` }
    }
    return { ok: true, label: r.label, confidence: r.confidence, model: r.model, ms, probs: r.probs }
  } catch (e) {
    return { ok: false, label: null, confidence: null, model: backendStr, ms: Date.now() - t0, why: e?.message || String(e) }
  }
}

/**
 * **互证**：同一句话跑多个后端，比较结果。
 *
 * @returns {{agreement:'一致'|'不一致'|'样本不足', label:string|null, confidence:number|null, uncertain:boolean, votes:Array, why:string}}
 *
 * ⚠️ 三条硬规矩：
 *   ① **只有一个后端成功时，谈不上"一致"** ⇒ `agreement: '样本不足'`（不假装互证过）
 *   ② **不一致时 `label` 取 `null`** —— 不替使用者选一个（硬规则 3）
 *   ③ 置信度低于 `MIN_CONFIDENCE` ⇒ `uncertain: true`，即使只有它一个后端
 */
export async function classifyWithConsensus(text, backendStrs, opts = {}) {
  const votes = []
  for (const b of backendStrs) votes.push(await classifyOne(text, b, opts))

  const good = votes.filter((v) => v.ok)
  const labels = good.map((v) => v.label)
  const uniq = [...new Set(labels)]

  // 置信度：取**成功票里最低的**那个 —— 保守（宁可标可疑，不可放过）
  const confs = good.map((v) => v.confidence).filter((c) => typeof c === 'number')
  const minConf = confs.length ? Math.min(...confs) : null

  let agreement, label, why
  if (good.length < 2) {
    agreement = '样本不足'
    label = good.length === 1 ? good[0].label : null
    why = good.length === 0
      ? `全部后端失败：${votes.map((v) => `${v.model}(${v.why || '未知'})`).join('；')}`
      : `只有 1 个后端成功（${good[0].model}）⇒ **谈不上互证**`
  } else if (uniq.length === 1) {
    agreement = '一致'
    label = uniq[0]
    why = `${good.length} 个后端都判「${label}」`
  } else {
    agreement = '不一致'
    label = null                                   // ← 不替使用者选
    why = `后端给出的标签不同：${good.map((v) => `${v.model}=${v.label}`).join('，')}`
  }

  // ⚠️⚠️ `uncertain` 只看**我们对这个结论有多信**，**不看"有几个后端参与"**。
  //    第一版把 `agreement !== '一致'`（含"样本不足"）也算进来 ⇒ 只跑一个后端时
  //    **10/10 全被标成 uncertain**，"不确定率 100%" 这个数字**毫无信息量**
  //    —— 那是把"无法互证"当成了"结论不可信"（两件不同的事，混一起就两个都失效）。
  //    正确判据：① 后端之间**有分歧** ⇒ 可疑；② 成功的票里**最低置信度**低于门槛 ⇒ 可疑。
  const uncertain = agreement === '不一致' || (minConf !== null && minConf < MIN_CONFIDENCE)
  if (uncertain && agreement === '一致' && minConf !== null) why += `；但最低置信度 ${minConf.toFixed(2)} < ${MIN_CONFIDENCE} ⇒ 标可疑`

  return { agreement, label, confidence: minConf, uncertain, votes, why, text }
}
