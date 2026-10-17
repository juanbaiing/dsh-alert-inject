/**
 * anchor.js — 上下文锚点：**提醒"你本来在干什么"**
 *
 * ══ 解决的问题（作者 2026-10-15 提出）═════════════════════════════
 *   > "AI 再读了长文本后，会忘了之前在干什么，即**没有长期目标，没有约束**"
 *   机制上很清楚：读进来的长文本占据注意力，**原本的目标被挤到上下文边缘**
 *   （即 "Lost in the Middle" —— 模型对上下文中部的注意力最低）。
 *   ⇒ 目标并没有消失，它**还在日志里**，只是不再"在眼前"。
 *
 * ══ 为什么它确实"简单"（作者判断正确）═══════════════════════════
 *   因为**所需信息全都已经存在**，不需要新机制：
 *     · 目标   → 会话日志的 `goal/change` 事件（`goal.phase === 'active'`）
 *     · 待办   → 会话日志的 `todo/write` 事件
 *     · 约束   → `AGENTS.md`（DSH 每轮注入的那份，天然是"长期规则")
 *   ⇒ 而且**纯程序、零成本、不用模型**：读日志 → 摆到眼前。
 *
 * ══ ⚠️ 它【不做】判断（这一点决定了它是"提醒"而非"监控"）═══════
 *   本模块**不判断"你是否偏离了目标"** —— 那是语义判断，
 *   而该能力在本项目已两次实测失败（NLI 三版全败；向量比对 −2.8pp 方向反）。
 *   ⇒ 它只做一件事：**把锚点重新摆到眼前，让模型自己确认。**
 *     这与"只给指针不给内容"是同一个纪律：**给信息，不下结论。**
 *
 * ══ 与 v1「注入」的区别（为什么不算重蹈覆辙）════════════════════
 *   v1 是**每轮注入到 system prompt** ⇒ 打断前缀缓存 + 读 reasoning 招来瘟疫。
 *   本模块**注入的是【从日志读出来的既有事实】**，且**走 alert_check 的工具返回**
 *   （v3 形态）⇒ 零常驻、不打断缓存、不碰 reasoning 通道。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readSessionText } from './inflate.js'

/**
 * ⚠️ 本地 `inflate()` 已移除（2026-10-17）—— 它和 `index.js` 里那份**完全相同**，
 *   而两处各自解压同一个文件。实测 20 MB / 43,798 帧：单次全量解压 **2,782 ms**，
 *   一次 `buildReport` 因此多花约 5 秒。现在统一走 `inflate.js` 的 `readSessionText()`。
 *
 * ⚠️ 缓存键从 `file:mtimeMs:size` 改成 `file:size`：
 *   会话文件**边写边读**，mtime 每轮都变 ⇒ 带 mtime 的缓存**永远不命中**，
 *   所以这个函数以前**其实没有起到缓存作用**。追加写只增长 size，用 size 足够。
 */
function inflateCached(sessionFile) {
  return readSessionText(sessionFile)
}

/**
 * 读当前【活跃目标】。
 * ⚠️ 取**最后一个** goal/change（不是第一个）—— 目标会被 create/complete/edit/pause 多次改动。
 * @returns {null | {objective, phase, revision, id, updatedAt}}
 */
export function readGoal(sessionFile) {
  if (!sessionFile) return null
  try {
    // ⚠️ 试过「先解尾部再退化」（2026-10-17），**无收益**，见 inflate.js 的 readSessionTail 注释。
    //    这里直接用共享解压：recentActivity 在前面已经全量解过，命中缓存后是 0 成本。
    const txt = inflateCached(sessionFile)
    if (!txt || !txt.includes('"goal/change"')) return null
    let last = null
    for (const line of txt.split('\n')) {
      if (!line.trim() || !line.includes('"goal/change"')) continue
      let r; try { r = JSON.parse(line) } catch { continue }
      if (r.type !== 'goal/change') continue
      const g = r.data?.goal
      if (g) last = { ...g, op: r.data.operation, updatedAt: r.data.updatedAt || r.data.createdAt }
    }
    return last
  } catch { return null }
}

/** 读最新一次 todo 写入（DSH 的 todo 工具会整表覆盖写） */
export function readTodos(sessionFile) {
  if (!sessionFile) return null
  try {
    // ⚠️ 试过「先解尾部再退化」（2026-10-17），**无收益**，见 inflate.js 的 readSessionTail 注释。
    //    这里直接用共享解压：recentActivity 在前面已经全量解过，命中缓存后是 0 成本。
    const txt = inflateCached(sessionFile)
    if (!txt || !txt.includes('"todo/write"')) return null
    let last = null
    for (const line of txt.split('\n')) {
      if (!line.trim() || !line.includes('"todo/write"')) continue
      let r; try { r = JSON.parse(line) } catch { continue }
      if (r.type !== 'todo/write') continue
      last = r.data
    }
    return last
  } catch { return null }
}

/**
 * 读【目标变更史】—— 供 BDI 式的"意图再考虑"提醒用。
 *
 * 理论依据（`Principles of Intention Reconsideration`, Wooldridge 2001）：
 *   > **Rational commitment** = maintaining intentions **until there's sufficient reason to reconsider**
 *   > An agent may reconsider its intentions **if it believes they are no longer possible to pursue**,
 *   > or **if an alternative set of intentions are more preferable**
 *   ⇒ 即：改变本身不是错，**但改变需要理由**（不可行 / 有更优）。
 *   ⇒ 本函数只**报告变更事实**（什么时候、从什么变成什么），**不判断理由是否充分** ——
 *     "理由是否成立"是语义判断，而该能力已两次实测失败（NLI 三版全败；向量比对方向反）。
 */
export function readGoalHistory(sessionFile) {
  if (!sessionFile) return []
  try {
    const txt = inflateCached(sessionFile)
    if (!txt || !txt.includes('"goal/change"')) return []
    const out = []
    for (const line of txt.split('\n')) {
      if (!line.trim() || !line.includes('"goal/change"')) continue
      let r; try { r = JSON.parse(line) } catch { continue }
      if (r.type !== 'goal/change') continue
      const g = r.data?.goal || {}
      out.push({
        op: r.data?.operation || '?',
        phase: g.phase || null,
        revision: g.revision ?? null,
        objective: g.objective || '',
        ts: r.data?.updatedAt || r.data?.createdAt || null,
      })
    }
    return out
  } catch { return [] }
}

/**
 * 读【子目标】—— 取自 `todo/write`。
 *
 * ⚠️ 概念提升（2026-10-15，据分层规划文献）：
 *   此前只把 todo 当"待办清单"读；但按分层规划（hierarchical decomposition），
 *   它其实是**子目标层**：`总目标 → 子目标 → 原子动作（工具调用）`。
 *   文献原话："hierarchical frameworks **separate concern across temporal scales**"
 *   以及 "subtasks ... **atomic**（可直接执行）or **composite**（仍需分解）"。
 *   ⇒ 故本模块把 todo 明确当作**子目标**呈现，而不是"还有几件事没做"。
 */
export function readSubgoal(sessionFile) {
  const todos = readTodos(sessionFile)
  if (!todos) return null
  const arr = Array.isArray(todos) ? todos : (todos.todos || todos.items || null)
  if (!Array.isArray(arr)) return null
  const norm = (t) => ({
    text: String(t?.content || t?.text || t?.title || '').trim(),
    status: String(t?.status || t?.state || '').toLowerCase(),
  })
  const items = arr.map(norm).filter((x) => x.text)
  const inProg = items.filter((x) => x.status.includes('progress'))
  const pending = items.filter((x) => !x.status.includes('complet') && !x.status.includes('progress'))
  return {
    current: (inProg[0] || pending[0] || null),        // 当前子目标
    inProgress: inProg.length,
    pending: pending.length,
    completed: items.filter((x) => x.status.includes('complet')).length,
    total: items.length,
    next: pending.slice(inProg.length ? 0 : 1, (inProg.length ? 0 : 1) + 3).map((x) => x.text),
  }
}

/**
 * 读【实际生效的 system prompt】。
 *
 * ⚠️ 实测定位（2026-10-15）：约束**不在 `user/message` 里**（当前会话 45 条用户发言全无），
 *   也不在 `AGENTS.md`（本机四个候选路径全不存在）。
 *   **它在 `request/header` 事件的 `data.header.system` 里** —— 那是 DSH 每轮真正
 *   发给模型的完整 system prompt（实测 ~44 KB）。
 *   ⇒ 这是**最准确的约束来源**：它就是"长期约束"本身，不是它的某种副本。
 */
export function readSystemPrompt(sessionFile) {
  if (!sessionFile) return null
  try {
    const txt = inflateCached(sessionFile)
    if (!txt || !txt.includes('"request/header"')) return null
    let last = null
    for (const line of txt.split('\n')) {
      if (!line.trim() || !line.includes('"request/header"')) continue
      let r; try { r = JSON.parse(line) } catch { continue }
      if (r.type !== 'request/header') continue
      const s = r.data?.header?.system
      if (s) last = s          // 取最后一个（最新一轮的 system prompt）
    }
    return last
  } catch { return null }
}

const RULE_LINE = /^\s*(?:[0-9]{1,2}[.、)）]|[①②③④⑤⑥⑦⑧⑨⑩]|[-*·•]\s)/

/**
 * 从 system prompt 里抽【规则块】。
 *
 * ⚠️ 为什么找"连续块"而不是逐行（首版教训）：
 *   system prompt 里有大量**列表**（工具清单、skill 列表），逐行抽会把
 *   `pro-flash-routing: Route planning and code execution…` 这种**描述**当成约束。
 *   ⇒ 而"作者加的长期约束"在 prompt 里是**连续若干行**出现的。
 *   ⇒ 故：只取【连续 ≥ minRun 行】都是规则行的块，并排除含冒号的描述行。
 */
export function readConstraints({ max = 8, file, acts, system } = {}) {
  // ① 首选：system prompt 里的连续规则块（最准确）
  const sys = system || null
  if (sys) {
    const lines = sys.split('\n')
    const blocks = []
    let cur = []
    const flush = () => { if (cur.length >= 3) blocks.push(cur.slice()); cur = [] }
    for (const raw of lines) {
      const s = raw.trim()
      const isRule = RULE_LINE.test(s) && !/[:：]\s*\S/.test(s.slice(0, 24))   // 排除"名称: 描述"
      if (isRule) cur.push(s)
      else flush()
    }
    flush()
    const rules = []
    for (const b of blocks) {
      for (const s of b) {
        const t = s.replace(/^\s*(?:[0-9]{1,2}[.、)）]\s*|[①②③④⑤⑥⑦⑧⑨⑩]\s*|[-*·•]\s+)/, '').trim()
        if (t.length >= 6 && t.length <= 160) rules.push(t)
        if (rules.length >= max) break
      }
      if (rules.length >= max) break
    }
    if (rules.length) return { file: null, rules, from: 'system prompt（连续规则块）' }
  }

  // ② 退路：用户痕迹 —— ⚠️ 同样要求【同一条消息内连续 ≥3 行规则】，
  //    否则会抓到零散的列表项（实测抓到过工具说明与 skill 描述）。
  if (Array.isArray(acts) && acts.length) {
    const rules = [], seen = new Set()
    for (const a of acts) {
      if (a.kind !== '用户') continue
      const lines = String(a.text || '').split('\n')
      const blocks = []
      let cur = []
      for (const raw of lines) {
        const s = raw.trim()
        if (RULE_LINE.test(s) && !/[:：]\s*\S/.test(s.slice(0, 24))) cur.push(s)
        else { if (cur.length >= 3) blocks.push(cur.slice()); cur = [] }
      }
      if (cur.length >= 3) blocks.push(cur.slice())
      for (const b of blocks) {
        for (const s of b) {
          const t = s.replace(/^\s*(?:[0-9]{1,2}[.、)）]\s*|[①②③④⑤⑥⑦⑧⑨⑩]\s*|[-*·•]\s+)/, '').trim()
          if (t.length >= 6 && t.length <= 160 && !seen.has(t)) { seen.add(t); rules.push(t) }
          if (rules.length >= max) break
        }
        if (rules.length >= max) break
      }
      if (rules.length >= max) break
    }
    if (rules.length) return { file: null, rules, from: '用户痕迹（连续规则块）' }
  }

  // ③ 末选：AGENTS.md（本机不存在，别的项目可能有）
  const candidates = [
    file,
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'AGENTS.md'),
    path.join(process.cwd(), 'AGENTS.md'),
  ].filter(Boolean)
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue
      const rules = []
      for (const raw of fs.readFileSync(f, 'utf8').split('\n')) {
        const s = raw.trim()
        if (!s || s.startsWith('#') || !RULE_LINE.test(s)) continue
        const t = s.replace(/^\s*(?:[0-9]{1,2}[.、)）]\s*|[①②③④⑤⑥⑦⑧⑨⑩]\s*|[-*·•]\s+)/, '').trim()
        if (t.length >= 6 && t.length <= 160) rules.push(t)
        if (rules.length >= max) break
      }
      if (rules.length) return { file: f, rules, from: 'AGENTS.md' }
    } catch { /* 下一个候选 */ }
  }
  return { file: null, rules: [], from: null }
}

/**
 * 组装锚点。**全部来自日志与文件，不含任何模型输出。**
 * @param acts 可选：已读的痕迹（用于附上"最近在做什么"）
 */
export function buildAnchor(sessionFile, acts = [], opts = {}) {
  const goalRaw = readGoal(sessionFile)
  const history = readGoalHistory(sessionFile)
  const subgoal = readSubgoal(sessionFile)
  const system = opts.system !== undefined ? opts.system : readSystemPrompt(sessionFile)
  const cons = readConstraints({ max: opts.maxConstraints ?? 8, file: opts.constraintsFile, acts, system })

  // ⚠️ **只把【活跃】目标当锚点**。实测教训：首版把 `phase: 'complete'` 的旧目标
  //    也当"你现在的目标"显示 —— 那是指鹿为马（目标早已完成）。
  const goal = goalRaw && goalRaw.phase === 'active'
    ? { objective: goalRaw.objective, phase: goalRaw.phase, revision: goalRaw.revision }
    : null

  // ── 目标变更史（BDI 式"意图再考虑"的输入）──
  // 只取**实质性变更**：edit / pause / resume / blocked 才算；create 与 complete 是正常生命周期。
  // ⚠️ 本模块**不判断变更理由是否成立** —— 只报告"什么时候、从什么变成了什么"。
  const changes = history.filter((h) => ['edit', 'pause', 'resume', 'blocked', 'update'].includes(String(h.op)))
  const lastChange = changes.length ? changes[changes.length - 1] : null
  // 被替换掉的那个目标（用于对照"改之前是什么"）
  let previousObjective = null
  if (lastChange) {
    const idx = history.lastIndexOf(lastChange)
    for (let i = idx - 1; i >= 0; i--) {
      if (history[i].objective && history[i].objective !== lastChange.objective) { previousObjective = history[i].objective; break }
    }
  }

  // 最近的动作序列（纯程序：工具名列表）
  const recentActions = []
  for (let i = Math.max(0, acts.length - (opts.recent ?? 12)); i < acts.length; i++) {
    const a = acts[i]
    if (a.kind !== '工具') continue
    const m = /^\[工具调用\]\s*(\S+)/.exec(a.text || '')
    if (m) recentActions.push(m[1])
  }

  return {
    goal,
    goalHistoryCount: history.length,
    goalChanges: changes.length,
    lastGoalChange: lastChange,
    previousObjective,
    subgoal,
    todos: subgoal ? { total: subgoal.total, pending: subgoal.pending, inProgress: subgoal.inProgress, completed: subgoal.completed } : null,
    constraints: cons,
    recentActions,
    // 锚点是否存在：总目标 / 子目标 / 约束 任一有，就算有锚点
    hasAnchor: !!(goal || (subgoal && subgoal.total) || cons.rules.length),
  }
}

/** todo/write 的形态不固定，这里只做稳健的计数与取样 */
function summarizeTodos(d) {
  const arr = Array.isArray(d) ? d : (Array.isArray(d?.todos) ? d.todos : (Array.isArray(d?.items) ? d.items : null))
  if (!arr) return null
  const by = { pending: 0, in_progress: 0, completed: 0 }
  const pendingList = []
  for (const t of arr) {
    const s = String(t?.status || t?.state || '').toLowerCase()
    if (s.includes('complet')) by.completed++
    else if (s.includes('progress')) by.in_progress++
    else by.pending++
    if (!s.includes('complet') && pendingList.length < 4) pendingList.push(String(t?.content || t?.text || t?.title || '').trim().slice(0, 80))
  }
  return { total: arr.length, ...by, pendingList }
}

/**
 * **简报模式**（2026-10-15 加，验收测试催生）。
 *
 * 实测问题：完整锚点里，**锚点+语境占了 608 字中的绝大多数**，且**76% 是列表项**，
 *   于是这份本该是"一个声音"的东西读起来**像一份结构化报告**。
 *   —— 验收测试的原话：「端上来的**是不是他点的那盘**」。
 *
 * 简报的做法：**常驻背景压成一行，只有"变了的东西"才展开。**
 *   · 总目标 / 子目标 → 一行
 *   · 长期约束 → **默认不列**（它们每轮都在 system prompt 里，重复列只是占位）
 *   · 目标变更 → **只有真被改过才提**（这才是 BDI 意义上值得出声的事）
 */
export function renderAnchorBrief(a, { maxObj = 90 } = {}) {
  if (!a?.hasAnchor) return ''
  const parts = []
  if (a.goal) {
    const obj = String(a.goal.objective || '').replace(/\s+/g, ' ')
    parts.push(`目标：${obj.length > maxObj ? obj.slice(0, maxObj) + '…' : obj}`)
  }
  if (a.subgoal?.current) parts.push(`子目标：${a.subgoal.current.text}`)
  if (!parts.length && !a.goalChanges) return ''
  const lines = [`⚓ ${parts.join('｜')}`]
  if (a.goalChanges > 0) {
    lines.push(`  ⚠️ 目标被改过 ${a.goalChanges} 次 —— 改目标需要理由（原目标不可行／有更优）；**理由是否成立由你判断**`)
  }
  return lines.join('\n')
}

/**
 * 渲染锚点（**verbose 版，供人工/调试**；模型看的是上面那个简报）。
 * ⚠️ 纪律：**只说"你原本在做什么"，不说"你偏离了"** —— 判断留给模型自己。
 * ⚠️ 目标原文**必须原样引用**（它是用户设定的，改写会失真）。
 */
export function renderAnchor(a, { maxObj = 300, maxPrev = 120 } = {}) {
  if (!a?.hasAnchor) return ''
  const lines = ['⚓ 【锚点】三层：总目标 → 子目标 → 动作（来自日志，非新信息）']

  // ── 第一层：总目标 ──
  if (a.goal) {
    const obj = a.goal.objective || ''
    const t = obj.length > maxObj ? obj.slice(0, maxObj) + '…' : obj
    lines.push(`- **总目标**（phase=${a.goal.phase}｜第 ${a.goal.revision ?? '?'} 版）：${t}`)
    // 目标变更史 —— BDI「意图再考虑」：改变需要理由（不可行 / 有更优），但**是否成立由模型判断**
    if (a.goalChanges > 0) {
      const prev = a.previousObjective
        ? (a.previousObjective.length > maxPrev ? a.previousObjective.slice(0, maxPrev) + '…' : a.previousObjective)
        : '（未记录到上一版）'
      lines.push(`  ⚠️ 此目标被修改过 **${a.goalChanges} 次**（最近 ${a.lastGoalChange?.ts || '时间未知'}）`)
      lines.push(`  改动前的目标是：${prev}`)
      lines.push('  按「合理承诺」，改目标需要理由（原目标不可行 / 有更优目标）—— **理由是否成立由你判断**。')
    }
  } else if (a.goalChanges > 0) {
    lines.push(`- **总目标**：当前无活跃目标（历史上被修改过 ${a.goalChanges} 次）`)
  }

  // ── 第二层：子目标（来自待办；概念提升见 readSubgoal 注释）──
  if (a.subgoal && a.subgoal.total) {
    lines.push(`- **当前子目标**（来自待办）：${a.subgoal.current ? a.subgoal.current.text : '（无未完成项）'}`)
    if (a.subgoal.next?.length) lines.push(`  其后：${a.subgoal.next.join(' ／ ')}`)
    lines.push(`  进度：进行中 ${a.subgoal.inProgress} ／ 未开始 ${a.subgoal.pending} ／ 已完成 ${a.subgoal.completed}`)
  }

  // ── 长期约束（跨块不变的那些）──
  if (a.constraints?.rules?.length) {
    lines.push('- **长期约束**：')
    for (const r of a.constraints.rules.slice(0, 6)) lines.push(`  · ${r}`)
  }

  // ── 原子动作（最近做了什么）──
  if (a.recentActions?.length) {
    lines.push(`- **最近的动作**：${a.recentActions.slice(-8).join(' → ')}`)
  }

  lines.push('以上只是把锚点摆回眼前 —— **是否还在主线上、子目标是否仍服务于总目标，由你自己判断**。')
  return lines.join('\n')
}
