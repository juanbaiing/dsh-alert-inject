/**
 * learning.js — 学习循环：发现 → 求证 → 结论
 *
 * ══ 这是什么 ══════════════════════════════════════════════════════
 * 作者 2026-10-15 定的方向：「**常识提炼，也就是学习过程，要有【发现、求证、得出结论】**」
 * 并指出起点应是**疑惑**（「这不对吧」）——
 *   这正对应项目里早已写下的原设计（`_recall-watch.js` 文件头）：
 *     **你怀疑 → 工具联想 → 你验证**
 *   也对应行业里的闭环命名（药物发现领域的 Nature 综述）：
 *     **hypothesis – experiment – analysis – hypothesis update**
 *
 * ══ 三阶段的实现分工（实测决定，见各段注释）════════════════════
 *   **① 发现**：程序提取【疑惑句 → 结论句】配对。免费。
 *   **② 求证**：程序做能做的（存在性/有据性/重复性）。免费。
 *   **③ 结论**：形成【待审记】条目，**交给模型或人审**。
 *
 * ══ ⚠️ 为什么不把判断交给本地小模型（实测数据）══════════════════
 *   测过「知识性 vs 操作性」分类（10 条，答案人工标注）：
 *     · qwen2.5:3b  → **5/10 = 50%**（且强偏向全判"操作"；理由常比结论准）
 *     · 本文件的**规则分类** → **11/14 = 79%**
 *   ⇒ **规则更好，且零成本、零延迟。** 与项目既有结论一致：
 *     "能用的那两样（查表、双向检索）恰好都不需要模型。"
 *   ⇒ 而「待审记」的存在让这个分类**不关键**：有人审，误报只是"队列多一条"。
 *
 * ══ ⚠️ 安全闸：为什么必须有"待审" ════════════════════════════════
 *   若让学习单元**自动落档并生效**，等于**让模型自己给自己写教材且不校对** ——
 *   REPORT.md 里"描述即传播"的机制会在知识层重现（错误知识被固化后反复引用）。
 *   ⇒ 故：**提炼可以自动，生效必须经审。**
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { detectMissingRefs } from './reference-check.js'
import { recordPrediction, recordCorrection } from './samples.js'

/** 疑惑标记（含问号与疑问句式） */
const Q_MARK = [/[？?]/, /是不是/, /会不会/, /到底/, /对吗/, /对不上/, /讲不通/, /说不通/, /难道/, /为什么/]
/** 结论标记 */
const R_MARK = [/确认了?|确认[:：]/, /发现[:：!！]/, /证明了?/, /原来/, /根因(是|[:：])/, /所以/, /因此/, /这就(是|说明)/, /！/]

/**
 * 规则分类：**操作性 = 结论描述「我要做什么」；知识性 = 结论描述「外部世界是什么」**
 *
 * ⚠️ 判据取"主语是人还是物"，因为有实测对照：
 *    本地模型判这个任务只有 50%（且偏向全判操作），而本规则 79%。
 * 实测的两处漏网（已知，靠待审兜底）：
 *   · "还是先跑 node --check 比较稳妥"（缺主语"我"，只有"先"）⇒ 已补入 SELF_ACT
 *   · "如果知识库未命中…所以写未命中"（真值操作，但句式像知识）⇒ 边界模糊，不硬修
 */
const SELF_ACT = /(^|[，。；：、\s])(我|我们)(要|应该|需要|会|打算|准备|得|把|来|去|先)|接下来|下一步|先用|还是先|改用|试试|考虑(把|用|做)|追加到|写进|更新(索引|表|文档)|report|汇报|稳妥|开始|继续|接着/i

/**
 * 外部事实标记 —— 描述"世界是什么样"
 * ⚠️ 实测漏了一处："确认了 cordis.patch.yml 在 profile 目录下"（真值=知识）被判"?"
 *    ⇒ 已把「确认了/发现了」补进来。
 */
const EXTERNAL = /(是|不是|有|没有|导致|来自|因为|原因|机制|说明|表明|确实|实际|极可能|允许|意味着|默认|确认了|发现了|等于|存在于)/

/** @returns {'知识'|'操作'|'?'} */
export function classifyRule(text) {
  const t = String(text || '')
  if (SELF_ACT.test(t)) return '操作'                 // 自我动作优先：宁可漏知识，不污染待审记
  if (EXTERNAL.test(t)) return '知识'
  return '?'
}

/**
 * ⚠️ **计划句**的排除（2026-10-15 第二处实测教训）：
 *   模型的思考链条是「**疑问 → 计划 → 行动（工具）→ 结果 → 结论**」，中间隔着工具调用。
 *   首版窗口只有 3 条痕迹，于是大量配到了"计划"而非"结论"：
 *     · 疑惑 "Loader 的 entries 是什么？" → 结论 "让我再仔细看看 client-modules 的实现"
 *     · 疑惑 "exports 是什么？"          → 结论 "1. 查 exports 确认 ./client 存在"
 *   ⇒ 这些是【待办动作】，不是答案。故：带计划口吻的句子一律不算疑惑、也不算结论。
 */
const PLAN_MARK = /让我(再|先)?(看|查|读|确认|试)|我需要(查|看|读|确认)|要(查|看|读|确认)一下?|先(看|查|读|跑|试|执行)|确认一下|看看|试试|检查一下|再查|进一步查|还需要|^[\d.、)）\s]*(确认|查|读|看|执行|运行|跑|试|检查|更新|写|改|加|删|先|再|然后|接着|同时)/

const isDoubt = (t) => Q_MARK.some((re) => re.test(t)) && !PLAN_MARK.test(t)
const isConcl = (t) => R_MARK.some((re) => re.test(t)) && !PLAN_MARK.test(t)

/** 拆句：按句末标点与换行，过滤过短/过长 */
function sentences(text, { min = 8, max = 200 } = {}) {
  return String(text || '')
    .split(/[。\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= min && s.length <= max)
}

/** 实词提取（中文按连续汉字/英文数字取 ≥2 的片段），用于判断"疑惑与结论是否同一话题" */
function keywords(s) {
  return new Set((String(s || '').match(/[\u4e00-\u9fa5]{2,}|[A-Za-z_][A-Za-z0-9_.]{1,}/g) || []))
}

/**
 * ⚠️ 操作性疑惑的排除（2026-10-15 实测教训）：
 *   首版只过滤了"操作性的【结论】"，结果 72 条候选里绝大多数是垃圾 ——
 *   因为**疑惑本身也大多是操作性的**：
 *     · "用户问'在干什么？'"        ← 转述用户，不是疑惑
 *     · "update_goal 是否 armed？"  ← 下一步该怎么做
 *     · "哪个 file: 目录？"          ← 待查的即时事实（非复用知识）
 *   ⇒ 故疑惑也要过滤：排除【转述用户】与【自我动作/工具选择】类。
 */
const DOUBT_NOISE = /用户(问|说|要求|希望|想|反馈)|我已经|上一轮|该用|要不要|是否需|哪个(工具|命令|file|目录)|先用|下一步|接下来/

/**
 * ① 发现：从痕迹里提取【疑惑 → 结论】配对。
 *
 * 为什么要配对而不是只找"疑惑"（实测教训）：
 *   判据「疑惑」的命中样本**大多是结论句而非疑问句**（信号词里的"为什么"在结论里也用）。
 *   实测句式分布：疑问句 5.7%、结论句 6.9%、**两者重叠仅 0.44%** ⇒ 可用句式分开。
 *
 * ⚠️ 为什么必须要求"关键词重叠"（实测教训）：
 *   首版只要"后面有结论句"就算配对，于是 pos=272 的"用户问在干什么"配上了 pos=273
 *   的状态汇报 —— **两者毫无关系**。加"共享实词"这道闸后才有意义。
 */
export function extractUnits(acts, opts = {}) {
  // ⚠️ 窗口默认 10：思考链条是「疑问→计划→行动(工具)→结果→结论」，
  //    窗口太小（首版=3）会配到"计划"而非"结论"。10 条足以跨过一轮工具调用。
  const window = opts.window ?? 10
  const out = []
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]
    if (a.kind !== '思考') continue                 // 疑惑只从"思考"里找（对齐判据「疑惑」的 sources）
    const sents = sentences(a.text)
    const qi = sents.findIndex(isDoubt)
    if (qi === -1) continue
    const doubt = sents[qi]
    if (DOUBT_NOISE.test(doubt)) continue           // 剔除转述/操作性疑惑
    const dkw = keywords(doubt)
    if (dkw.size < 2) continue                      // 太短的疑惑没有可配对的关键词

    // 结论：同一段内其后，或后续 window 条痕迹内的第一句；**且必须与疑惑共享实词**
    let concl = null, conclPos = null
    const trySent = (s, pos) => {
      if (!isConcl(s)) return false
      const ckw = keywords(s)
      for (const w of dkw) if (ckw.has(w) && w.length >= 2) { concl = s; conclPos = pos; return true }
      return false
    }
    for (const s of sents.slice(qi + 1)) if (trySent(s, i + 1)) break
    if (!concl) {
      for (let j = i + 1; j <= Math.min(i + window, acts.length - 1); j++) {
        const b = acts[j]
        if (b.kind !== '思考' && b.kind !== '正文') continue
        let done = false
        for (const f of sentences(b.text)) if (trySent(f, j + 1)) { done = true; break }
        if (done) break
      }
    }
    if (!concl) continue

    out.push({
      doubt: { text: doubt, pos: i + 1 },
      conclusion: { text: concl, pos: conclPos },
      class: classifyRule(concl),
    })
  }
  return out
}

/**
 * ② 求证：对学习单元做【程序能做的】核查。
 *
 * ⛔ 明确不做：语义矛盾检测 —— 已两次实测失败
 *    （NLI 三版全败；向量无法判别"预期是否实现"，差异 −2.8pp 且方向还反）。
 *
 * ✅ 做的是两件【外部可查】的事：
 *   ① **指针可信**：按 pos 能真的取回原文（首版只查"范围" ⇒ 全部 true、无区分度）
 *   ② **实体存在**：结论里提到的文件/路径是否真存在（交给 reference-check）
 *
 * ⚠️⚠️ 首版的逻辑错误（已修）：用 acts 提取配对、又用 acts 校验"能否取回" ⇒ **循环论证**，
 *    实测 71/71 全 pass，毫无信息量。② 才是真正的外部事实源。
 * ⚠️ 即便如此，"有据"**仍不等于"结论正确"** —— 只说明"所引用的东西是真的"。
 */
export function verifyUnit(unit, ctx = {}) {
  const acts = ctx.acts || []
  const bases = ctx.bases || []
  const at = (p) => (Number.isInteger(p) && p >= 1 && p <= acts.length ? acts[p - 1].text : null)
  const norm = (s) => String(s || '').replace(/\s+/g, '')

  const dHit = at(unit.doubt.pos)
  const cHit = at(unit.conclusion.pos)
  const dOk = dHit !== null && norm(dHit).includes(norm(unit.doubt.text).slice(0, 20))
  const cOk = cHit !== null && norm(cHit).includes(norm(unit.conclusion.text).slice(0, 20))

  const checks = [
    { name: '疑惑可按指针取回', pass: dOk, note: `pos=${unit.doubt.pos}` },
    { name: '结论可按指针取回', pass: cOk, note: `pos=${unit.conclusion.pos}` },
  ]

  // ② 外部事实源：结论里提到的项目内路径是否存在（这才是"有据"的实质）
  let refs = { checked: 0, missing: [], found: 0 }
  if (bases.length) {
    try { refs = detectMissingRefs(unit.conclusion.text, { bases }) } catch { /* 静默 */ }
    if (refs.checked) {
      checks.push({
        name: '结论引用的路径均存在',
        pass: refs.missing.length === 0,
        note: `查 ${refs.checked} 个，未找到 ${refs.missing.length} 个`,
      })
    }
  }

  return {
    ...unit,
    verification: {
      checks,
      refs: { checked: refs.checked, found: refs.found, missing: refs.missing.map((m) => m.ref) },
      evidenced: checks.every((c) => c.pass),
      note: '仅验证"可回取＋引用真实"，不代表结论正确',
    },
  }
}

// ── 待审记（存储）────────────────────────────────────────────────
export const REVIEW_OPTS = {
  file: process.env.LEARNING_STORE || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'learning-pending.json'),
  max: +(process.env.LEARNING_MAX || 500),
}

export function createUnit(sessionFile, unit, extra = {}) {
  return {
    id: crypto.randomUUID(),
    foundAt: new Date().toISOString(),
    session: path.basename(path.dirname(sessionFile || '')),
    ...unit,
    ...extra,
    status: '待审',                       // ⚠️ 唯一的合法初始状态：提炼自动，生效必经审
  }
}

export function loadPending() {
  try { return JSON.parse(fs.readFileSync(REVIEW_OPTS.file, 'utf8')) } catch { return { units: [] } }
}

/**
 * ⚠️⚠️ 容量纪律（2026-10-15 修，作者提出的风险审计）⚠️⚠️
 *
 * 原实现：`cur.units = cur.units.slice(-REVIEW_OPTS.max)` —— 超过 500 条就**静默丢弃最早的**。
 *   问题不只是丢数据，而是**违反本项目自己定的第一条原则**：
 *     > **一切结果留痕** —— 不留痕的结果等于没发生
 *   而 `REPORT.md` 里对那次事故的痕迹处理方式是"**就地替换为带日期的留痕标记（不静默删）**"。
 *   ⇒ 同一作者在同一天写的两个模块，纪律相反：
 *     · `samples.js` 超限 → **轮转**（改名保留，✅ 对）
 *     · `learning.js` 超限 → **截断**（直接丢，❌ 错）
 *
 * **统一纪律**：**任何有界容器，超限时的行为必须是【轮转/归档】，绝不是【静默丢弃】。**
 */

/** 归档溢出条目到带日期的文件（**不删**） */
function archiveOverflow(units) {
  if (!units?.length) return null
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const p = REVIEW_OPTS.file.replace(/\.json$/, `.archive-${stamp}.json`)
    let prev = []
    try { prev = JSON.parse(fs.readFileSync(p, 'utf8')).units || [] } catch { /* 新文件 */ }
    fs.writeFileSync(p, JSON.stringify({ archivedAt: new Date().toISOString(), units: [...prev, ...units] }, null, 1), 'utf8')
    console.warn(`[alert-inject] 待审记超出 ${REVIEW_OPTS.max} 条 ⇒ 已**归档** ${units.length} 条到 ${p}（未丢弃）`)
    return p
  } catch (e) {
    // ⚠️ 归档失败时**绝不截断** —— 宁可文件变大，也不丢数据
    console.warn('[alert-inject] 待审记归档失败，本次不截断：', e instanceof Error ? e.message : String(e))
    return null
  }
}

export function appendPending(units) {
  try {
    const cur = loadPending()
    cur.units.push(...units)
    // ⚠️ 超限时先归档、**且仅在归档成功后才裁剪**
    if (cur.units.length > REVIEW_OPTS.max) {
      const cut = cur.units.length - REVIEW_OPTS.max
      const archived = archiveOverflow(cur.units.slice(0, cut))
      if (archived) cur.units = cur.units.slice(-REVIEW_OPTS.max)
      // 归档失败 ⇒ 保持原样（文件会变大，但数据不丢）
    }
    fs.mkdirSync(path.dirname(REVIEW_OPTS.file), { recursive: true })
    fs.writeFileSync(REVIEW_OPTS.file, JSON.stringify(cur, null, 1), 'utf8')
    return cur.units.length
  } catch { return -1 }
}

/**
 * 渲染。
 * ⚠️ 铁律同前：**不回显疑惑/结论原文**（它们是判据扫描范围内的内容，回显 = 自我喂食）。
 *    只报【类别、指针、验证状态】，要原文按指针取。
 * ⚠️ 本模板每字都要过 leak-check。
 */
export function renderUnits(units) {
  if (!units?.length) return ''
  const byClass = {}
  for (const u of units) byClass[u.class] = (byClass[u.class] || 0) + 1
  const parts = Object.entries(byClass).map(([k, v]) => `${k} ${v}`)
  const lines = [`📚 【待审记】新增 ${units.length} 条候选（${parts.join('｜')}）`]
  for (const u of units.slice(0, 5)) {
    const ev = u.verification?.evidenced ? '有据' : '证据待补'
    lines.push(`- ${u.class} · 疑惑 pos=${u.doubt.pos} → 结论 pos=${u.conclusion.pos} · ${ev}`)
  }
  if (units.length > 5) lines.push(`- （另有 ${units.length - 5} 条未列出）`)
  lines.push('这些**尚未生效**；要原文按 pos 回取，是否收录由审阅决定。')
  return lines.join('\n')
}

/**
 * ③ 结论（端到端）：发现 → 求证 → 入待审记
 *
 * 附带**样本记录**（2026-10-15 加）：每次分类判断都落一条样本 ——
 *   这是"规则 93% → 训练后模型 76.6%+"的唯一通路。**不记样本，规则永远是规则。**
 *   ⚠️ 只记"生产路径"（本函数），不记纯函数 classifyRule —— 否则测试调用会污染样本。
 *
 * @returns {units, rendered, storedTotal, stats}
 */
export function runLearning(acts, sessionFile, opts = {}) {
  const raw = extractUnits(acts, opts)
  // 只收"知识"与"不确定"；操作性决策当下已被自己的行为解决，无复用价值（实测约占 1/3）
  const kept = raw.filter((u) => u.class !== '操作')
  const verified = kept.map((u) => verifyUnit(u, { acts }))

  // ── 样本记录：每条配对的分类判断（含被丢弃的，负例同样有价值）──
  if (!opts.noSamples) {
    const sess = path.basename(path.dirname(sessionFile || ''))
    for (const u of raw) {
      recordPrediction({
        task: 'unit_classify',
        input: u.conclusion.text,
        prediction: u.class,
        confidence: null,
        by: 'rule',
        ref: { session: sess, doubtPos: u.doubt.pos, conclPos: u.conclusion.pos },
        extra: { doubt: u.doubt.text },
      })
    }
  }

  if (!verified.length) return { units: [], rendered: '', storedTotal: 0, stats: { raw: raw.length, kept: 0 } }

  const withMeta = verified.map((u) => createUnit(sessionFile, u))
  const storedTotal = opts.dryRun ? -1 : appendPending(withMeta)
  return {
    units: withMeta,
    rendered: renderUnits(withMeta),
    storedTotal,
    stats: { raw: raw.length, kept: kept.length, dropped: raw.length - kept.length },
  }
}

/**
 * ④ 从痕迹里采收【用户纠正】——**自带标签的最高质量样本**。
 *
 * 作者 2026-10-15 指出：**每一次纠正就是一条免费的高质量标注。**
 * 而判据「落档纪律」抓的正是它（sources: ["用户"]），
 * 该判据此前因一个提取 bug **从未触发**（同日修复）⇒ 现在才有得收。
 *
 * ⚠️ 只收"含纠正信号的用户发言"，**且排除插件注入的系统消息与任务指令**
 *    （实测：把「不要修改任何文件」这种任务指令当纠正，会污染样本）。
 */
/**
 * ⚠️ 正则陷阱（2026-10-15 实测）：`不是` 会匹配到 `是不是`（疑问语气），
 *   于是把"你在阅读记忆时是不是要花费额外 token?"这种**提问**当成了纠正。
 *   ⇒ 用负向后顾 `(?<!是)不是` 排除；同类还有 `不至于`（已单独列出）。
 */
const CORRECT_SIG = /(?<!是)不是|不对|不该|别这样|不用|其实|错了|搞错|我的意思是|你理解错|应该先|不至于|没必要/
const TASK_INSTR = /^(你是|请你|帮我|请帮|需要你|调研|返回|输出格式|严禁|不要修改)/

export function harvestUserCorrections(acts, sessionFile, opts = {}) {
  const sess = path.basename(path.dirname(sessionFile || ''))
  let n = 0
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]
    if (a.kind !== '用户') continue
    const t = a.text.trim()
    if (t.length < 6 || t.length > 600) continue
    if (TASK_INSTR.test(t)) continue                    // 任务指令不是纠正
    if (!CORRECT_SIG.test(t)) continue
    if (opts.dryRun) { n++; continue }
    recordCorrection({ wrong: null, right: t, task: 'user_correction', ref: { session: sess, pos: i + 1 } })
    n++
  }
  return n
}
