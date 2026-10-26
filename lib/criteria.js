/**
 * criteria.js —— **判据池**（目标 / 约束 / 验收标准的唯一权威来源）
 *
 * ══ 为什么需要它（2026-10-17，作者的设计）══════════════════════════════
 *
 * 本插件原本只有两类东西：
 *   · **设定档**（世界是什么）—— 档案检索在读
 *   · **判据表**（输出哪里不对）—— 5 条语气判据
 * 但缺了中间那一层：**「我要做什么」**。
 *
 * 缺了它的后果是实测到的：一次长会话里 AI 连做四轮都不是作者要的，
 * 直到作者说出「我最初是在创作虚拟世界观，LLM 老是不能正确运行我给的世界条件」才找到正题。
 * ⇒ 见教训 §267（主线漂移）。**根因不是能力不足，是没有人问过"你在干什么"。**
 *
 * ══ 三个不可动摇的设计（都有外部依据，见 DESIGN-evidence.md）════════════
 *
 * **① 只追加（append-only）**
 *   本模块**不提供修改 / 删除接口**。要改判据，只能追加一条带 `supersedes` 的新条目，
 *   旧条目**永远留着**。
 *   ⇒ 依据：OWASP **ASI01 Agent Goal Hijack** 的最有效防御是 **goal immutability**
 *     ——「agent 可以对内容做推理，**但不能修改它**」（Snyk Learn）。
 *
 * **② 权威只能来自「用户确认」**
 *   `status: 'proposed'` 的记录（LLM 提议的）**不是权威**，不进检索、不参与对齐。
 *   只有 `status: 'active'` 且 `by: 'user'` 的才算。
 *   ⇒ 否则就是把裁判权交给受审者：LLM 自己写判据给自己看，等于没有判据。
 *
 * **③ 判据由「问清楚」产生，不由「猜」产生**
 *   文献实测：**LLM 能认出歧义，但很少主动问**（Knowing but Not Showing, 2026）
 *   ⇒ 所以本模块只负责**存**与**算**；「什么时候该问」由 report.js 的触发点决定。
 *   ⇒ 且这些系统共识是「问要**极少**」（ECLAIR：precision 比 recall 重要）——
 *     故不做"每轮都问"，只在三个时刻问（见 report.js）。
 *
 * ══ 存储形态 ══════════════════════════════════════════════════════
 * `~/.dsh/memory/db/criteria/criteria.jsonl`，**一个事件一行**：
 *
 *   {"id":"c-3f2a1b","status":"proposed","what":"…","kind":"goal",
 *    "by":"llm","quote":"","when":"2026-10-17T…","supersedes":null}
 *
 * 同一个 `id` 可以出现多次（提议 → 确认），读取时**取最后一条**。
 * ⇒ 这就是"内容不可变、状态可演进"的做法：判据本身没被改过，改的只是它被确认到哪一步。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dbRoot } from './db.js'

/** 库的相对路径（在 `<dbRoot>/memory/db/` 下，与 knowledge/cases/lessons 同级） */
export const CRITERIA_REL = 'criteria/criteria.jsonl'

/**
 * 必填字段 —— 与 db.js 的 REQUIRED 同构（溯源 + 内容），外加权威来源。
 *
 * ⚠️ `when` **故意不列在这里**（2026-10-17）：本模块会**自动填当前时间**。
 *   理由：调用方是 LLM，而它**通常不知道"现在几点"**——
 *   这正是作者提过的「你总是没有时间概念」那条需求（见 TODO 的"时间戳"一节）。
 *   ⇒ 让它传时间只会催生编造的时间戳；不如由系统填，且**写在文件里可核对**。
 */
export const CRITERIA_REQUIRED = ['what', 'kind', 'by']

/** 允许的 kind。⚠️ 不做"自由文本"：判据要能被对齐，就得有明确类型 */
export const CRITERIA_KINDS = ['goal', 'constraint', 'acceptance']

/** 状态机：proposed → active → superseded（**不可逆**；要回退就再追加一条并给理由） */
export const CRITERIA_STATES = ['proposed', 'active', 'superseded']

/** 文件绝对路径（**现算**，不缓存 —— `DSH_ALERT_DATA_DIR` 可能在测试里改） */
export function criteriaFile() {
  return path.join(dbRoot(), CRITERIA_REL)
}

/** 判据 id：由内容算（同一条内容 ⇒ 同一个 id ⇒ 可以"确认"同一条，而不是又记一条） */
export function criterionId(kind, what) {
  return 'c-' + crypto.createHash('sha1').update(String(kind) + '\u0000' + String(what)).digest('hex').slice(0, 6)
}

/**
 * 追加一条事件（**唯一的写入口**）。
 *
 * ⚠️ 只追加、不修改、不删除 —— 这个函数**没有对应的 update/delete**，是有意的。
 * @returns {{ok:boolean, added:boolean, id?:string, reason?:string, status?:string}}
 *   ⚠️ 被拒时 `reason` **一定**有值 —— 绝不返回"成功但什么都没做"。
 */
export function appendCriterion(input = {}) {
  const { what, kind, by, quote = '', supersedes = null, status = 'proposed', when, scope = null } = input

  // ① 必填
  const missing = CRITERIA_REQUIRED.filter((k) => input[k] === undefined || input[k] === null || String(input[k]).trim() === '')
  if (missing.length) {
    return { ok: false, added: false, reason: `缺必填字段：${missing.join('、')}（判据必须有 what／kind／by／when）` }
  }
  // ② 类型/状态白名单（否则对齐时无从判断）
  if (!CRITERIA_KINDS.includes(kind)) {
    return { ok: false, added: false, reason: `kind 只能是 ${CRITERIA_KINDS.join(' / ')}，收到：${kind}` }
  }
  if (!CRITERIA_STATES.includes(status)) {
    return { ok: false, added: false, reason: `status 只能是 ${CRITERIA_STATES.join(' / ')}，收到：${status}` }
  }
  // ③ ⚠️ **权威只能来自用户** —— 这条是防"裁判权落在受审者手里"
  if (status === 'active' && by !== 'user') {
    return { ok: false, added: false, reason: '只有 by=user 才能把判据置为 active —— LLM 自己确认的判据不算权威（否则等于没有判据）' }
  }
  /**
   * ③b **作用域校验**（2026-10-26 加，作者原话：「这个算特有场景吧」）。
   *
   *   为什么需要：判据池原先**没有"属于哪个项目/工作区"这个维度** ⇒
   *     一条「让 LLM 遵守设定档里的世界条件」的判据（创作世界观项目的目标），
   *     会在**每一个工作区**的每轮自查里被问一遍 —— 包括插件开发。
   *   ⇒ scope 就是那条"特有场景"的载体。
   *
   *   ⚠️ 规则：**无 scope = 全局**（保持向后兼容，旧判据不受影响）。
   *   ⚠️ 格式必须严：`{ workspace: ["某工作区"] }` —— 自由文本会让匹配变成猜。
   */
  if (scope !== null && scope !== undefined) {
    if (typeof scope !== 'object' || Array.isArray(scope)) {
      return { ok: false, added: false, reason: `scope 必须是对象（如 { workspace: ["某工作区"] }），收到：${typeof scope}` }
    }
    if (scope.workspace !== undefined
      && !(Array.isArray(scope.workspace) && scope.workspace.length > 0
        && scope.workspace.every((w) => typeof w === 'string' && w.trim()))) {
      return { ok: false, added: false, reason: 'scope.workspace 必须是非空的字符串数组（如 ["你的工作区名"]）' }
    }
  }
  // ④ supersede 必须指向真实存在且非自己的判据
  const all = loadCriteria()
  const id = criterionId(kind, what)
  if (supersedes) {
    if (supersedes === id) return { ok: false, added: false, reason: '不能 supersede 自己' }
    if (!all.byId.has(supersedes)) return { ok: false, added: false, reason: `supersedes 指向的判据不存在：${supersedes}` }
  }
  // ⑤ 同一条"状态迁移"不重复记（proposed→proposed 是空操作）
  //
  // ⚠️ 2026-10-26 改：去重键从「status」改成「status + scope」。
  //   否则「给已有判据补一个 scope」会被当成 proposed→proposed 空操作**静默拒绝**，
  //   而那是本次要做的**唯一**一件事（又是一次"看起来成功了"）。
  const cur = all.byId.get(id)
  const scopeSig = (o) => JSON.stringify(o?.scope ?? null)
  if (cur && cur.status === status && scopeSig(cur) === scopeSig({ scope })) {
    return { ok: true, added: false, id, status, reason: `这条已是 ${status}（scope 未变），无需重复追加` }
  }
  // ⑥ 不可逆：active 不能被 proposed 覆盖回去
  if (cur && cur.status === 'active' && status === 'proposed') {
    return { ok: false, added: false, reason: '已 active 的判据不能被改回 proposed —— 要回退请显式给出理由并追加 superseded' }
  }

  const rec = {
    id,
    status,
    what: String(what).trim(),
    kind,
    by,
    quote: String(quote).slice(0, 300),
    supersedes: supersedes || null,
    // ⚠️ 空对象也归一成 null —— 否则 `{}` 与 `null` 在去重时会被当成两个不同的 scope
    scope: scope && Object.keys(scope).length ? scope : null,
    when: when || new Date().toISOString(),
  }

  try {
    const f = criteriaFile()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, JSON.stringify(rec) + '\n', 'utf8')
    return { ok: true, added: true, id, status }
  } catch (e) {
    // ⚠️ §239：降级可以，**降级必须留痕**
    console.warn('[alert-inject/criteria] ⚠️ 判据写入失败（这条没记上）：', e?.message || e)
    return { ok: false, added: false, reason: `写入失败：${e?.message || e}` }
  }
}

/**
 * 读全部判据，按 id 聚合到**最后一条**（= 当前状态）。
 * ⚠️ 坏行要计数并回报，不静默吞掉（与 db.readEntries 同一纪律）。
 * @returns {{ok:boolean, byId:Map<string,object>, list:object[], badLines:number, reason:string}}
 */
export function loadCriteria() {
  const f = criteriaFile()
  const empty = { ok: true, byId: new Map(), list: [], badLines: 0, reason: '' }
  if (!fs.existsSync(f)) return { ...empty, reason: '判据池还不存在（还没确立过任何判据）' }
  let raw = ''
  try { raw = fs.readFileSync(f, 'utf8') } catch (e) {
    return { ok: false, byId: new Map(), list: [], badLines: 0, reason: `读不动：${e?.message || e}` }
  }
  const byId = new Map()
  let badLines = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { badLines++; continue }
    // ⚠️ JSON.parse 对 null/0/"str"/true 都不报错（§263）—— 形状守卫不能省
    if (!o || typeof o !== 'object' || !o.id) { badLines++; continue }
    byId.set(o.id, o)          // 后写的覆盖先写的 = 状态演进
  }
  // superseded 的链接状态：被别的判据 supersede 掉的，即使自己还是 active 也要让位
  for (const o of byId.values()) {
    if (o.supersedes && byId.has(o.supersedes)) {
      const old = byId.get(o.supersedes)
      if (old.status !== 'superseded') {
        byId.set(o.supersedes, { ...old, status: 'superseded', supersededBy: o.id })
      }
    }
  }
  return { ok: true, byId, list: [...byId.values()], badLines, reason: '' }
}

/**
 * **当前生效的判据** —— 只有 `status==='active'`（⇒ 必然是用户确认过的）。
 * 这是唯一应该被拿来"对齐"的集合。
 */
export function activeCriteria() {
  const r = loadCriteria()
  return r.list.filter((c) => c.status === 'active')
}

/**
 * 汇总（供 alert_check 的返回与体检使用）。
 * ⚠️ 数量少是**特性**不是缺陷：文献共识是"问要极少、判据要明确"。
 */
export function criteriaStatus() {
  const r = loadCriteria()
  const by = { active: 0, proposed: 0, superseded: 0, other: 0 }
  for (const c of r.list) {
    if (by[c.status] === undefined) by.other++
    else by[c.status]++
  }
  return {
    ok: r.ok,
    total: r.list.length,
    ...by,
    badLines: r.badLines,
    reason: r.reason,
    file: criteriaFile(),
    /** 有提议但没确认 ⇒ 这就是"该问一次"的信号 */
    needsConfirmation: by.proposed > 0,
    /** 一条生效判据都没有 ⇒ 这就是"该问一次"的另一个信号 */
    isEmpty: by.active === 0,
  }
}

/**
 * 渲染成给模型看的一行（**极简**）。
 *
 * ⚠️ 为什么克制：`renderAnchorBrief` 的实测教训是
 *   「锚点+语境占了 608 字，76% 是列表项 ⇒ 读起来像结构化报告」，
 *   而超长上下文本身会退化（DESIGN-evidence 第二条）。
 *   ⇒ 这里**最多 3 条**，超出只报数量；没有 active 判据时**整段不输出**（不给噪音）。
 */
export function renderCriteriaLine({ max = 3, maxLen = 46 } = {}) {
  const act = activeCriteria()
  if (!act.length) return ''
  const shown = act.slice(0, max).map((c) => {
    const w = String(c.what).replace(/\s+/g, ' ')
    return w.length > maxLen ? w.slice(0, maxLen) + '…' : w
  })
  const more = act.length > max ? ` 等 ${act.length} 条` : ''
  return `🎯 生效判据（${act.length}）：${shown.join('｜')}${more}`
}

/**
 * **作用域匹配**（2026-10-26 加）。
 *
 * 规则（宁可多问、不可漏问）：
 *   · 判据**没有** scope ⇒ **全局**，任何工作区都问（兼容所有旧判据）
 *   · 判据有 scope，但调用方**不知道当前工作区** ⇒ 仍然问（"不知道"不能当"不匹配"）
 *   · 判据有 scope.workspace ⇒ 当前工作区路径**包含**其中任一项才问
 *
 * @param {{workspace?:string[]}|null} scope
 * @param {string|null} workspace 当前工作区（通常是 cwd）
 */
export function scopeMatches(scope, workspace) {
  if (!scope) return true
  if (!workspace) return true
  const list = Array.isArray(scope.workspace) ? scope.workspace : []
  if (!list.length) return true
  const w = String(workspace).toLowerCase()
  return list.some((x) => w.includes(String(x).toLowerCase()))
}

/**
 * ★ **「该问一次吗」—— 只在真需要时出声**（2026-10-17，作者定的口径）
 *
 * ══ 为什么必须"少问"（有外部依据）════════════════════════════════
 *   · 文献实测：**LLM 能认出歧义，但很少主动问**（Knowing but Not Showing, 2026）
 *     ⇒ 所以不能指望它自己想到问，必须由机制触发。
 *   · 但同时，[ECLAIR (Adobe, AAAI)](https://ojs.aaai.org/index.php/AAAI/article/view/35152/37307)
 *     明确说 **precision 比 recall 重要**：「不必要的澄清问题会显著破坏体验」。
 *   ⇒ 结论：**平时一个字都不问；只在状态本身不健康时问。**
 *
 * ══ 三种状态，只有两种该问 ══════════════════════════════════════
 *   | 状态 | 该问吗 | 为什么 |
 *   |---|---|---|
 *   | 空池（一条 active 都没有） | ✅ 问目标 | AI 正在**无目标**状态下工作 ⇒ §267 那个错就是从这里来的 |
 *   | 有 proposed 未确认 | ✅ 问确认 | 提议不算权威；不确认就等于没有判据 |
 *   | 全是 active | ❌ **不问** | 正常状态，问就是噪音 |
 *
 * ⚠️ 空池期间会**每轮**问 —— 这是**有意**的：空池是危险状态，
 *   直到作者说出目标为止都该被提醒。一旦确立，这两行**自动消失**。
 *
 * ⚠️ 2026-10-26 加 `workspace`：**"有 proposed"不等于"该问你"** ——
 *   一条只属于创作世界观项目的判据，不该在插件开发的工作区里每轮被问。
 *   作者原话：「这个算特有场景吧」⇒ scope 不匹配的 proposed **不展示**，
 *   而且不算"空池"（池子不空，只是**不属于这里**）。
 */
export function criteriaPrompt({ max = 3, maxLen = 60, workspace = null } = {}) {
  const st = criteriaStatus()
  const lines = []

  if (!st.ok) {
    // 读不动 ⇒ 必须出声（硬规则 2/3：降级要留痕，别假装"没有判据"）
    lines.push(`🎯 判据池读不动：${st.reason}`)
    lines.push('   ⇒ **本次无法做目标对齐** —— 这不代表你没有目标。')
    return lines.join('\n')
  }

  // 有坏行也要说（否则"判据少"会被误读成"你没定过"）
  if (st.badLines > 0) {
    lines.push(`🎯 判据池有 ${st.badLines} 行坏了（已跳过）—— 其中的判据这次不生效`)
  }

  // ⚠️ 先按 scope 过滤：**只有"本工作区适用的"proposed 才值得问**
  const propsAll = loadCriteria().list.filter((c) => c.status === 'proposed')
  const props = propsAll.filter((c) => scopeMatches(c.scope, workspace))
  const outOfScope = propsAll.length - props.length

  if (st.active === 0 && props.length === 0 && st.proposed === 0) {
    lines.push('🎯 **判据池是空的** —— 动手前先问清一件：')
    lines.push('   你要做什么？**怎么算做成了**？')
    lines.push('   （说清后才落判据；判据只增不改，以后每轮拿它对齐。没有它，我只能靠猜。）')
  } else if (props.length > 0) {
    lines.push(`🎯 有 ${props.length} 条**待你确认**的判据：`)
    for (const p of props.slice(0, max)) {
      const w = String(p.what).replace(/\s+/g, ' ')
      const tag = p.scope?.workspace?.length ? `（限 ${p.scope.workspace.join('、')}）` : ''
      lines.push(`   · 「${w.length > maxLen ? w.slice(0, maxLen) + '…' : w}」${tag}`)
    }
    lines.push('   ⇒ 对吗？**确认了我才按它判**（LLM 自己确认的不算权威）。')
  }
  // ⚠️ 有 proposed 但**都不属于本工作区** ⇒ 什么都不说。
  //   这不是"静默"：`st.proposed` 与 `outOfScope` 仍然在体检/统计里可查。

  return lines.join('\n')
}
