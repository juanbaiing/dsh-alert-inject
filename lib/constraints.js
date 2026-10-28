/**
 * constraints.js — 「约束区」：**用户中途提的要求，单独挂一个区，压缩动不到它**
 *
 * ══ 为什么要有它（2026-10-27 · 作者原话 + 研究数据）═══════════════════════
 *   作者比喻：「我去了学校，写了试卷，现在开始吃饭（老师在写试卷时要求我用英语交流）」
 *   ⇒ 压缩会把「过程」收成「状态」，而**「要求」一旦被摘要丢掉，整件事就变味了**。
 *
 *   研究（两篇，结论一致）：
 *     · [Lost in Context Compaction](https://arxiv.org/html/2608.11242)：用户中途的侧约束（SC），
 *       压缩后平均**只保留 17%**——因为压缩器为"任务连续性"设计，SC 不是主任务。
 *     · [Governance Decay](https://arxiv.org/pdf/2606.22528.pdf)：压缩后治理约束违反率 0% → **30%**；
 *       用「约束固定（Constraint Pinning）」后回到 **0%**，代价仅 **47 tokens**。
 *
 *   ⇒ 解法：**独立存储 + 每轮重建**（不依赖上下文历史，压缩自然动不到）。
 *
 * ══ 为什么每轮都「重建」而不是常驻 system prompt ═══════════════════════
 *   system prompt 每轮变会**打断前缀缓存**（项目踩过：v1/v2 的瘟疫）。
 *   而 `alert_check` 的输出**每一轮重新生成**——它不进历史，压缩也动不到它。
 *   ⇒ 所以约束区挂在 **alert_check 的输出**里，而不是系统提示词里。
 *
 * ══ 三条纪律（与项目三态一致）═════════════════════════════════════
 *   ① **被提取不等于生效**：`by: 'llm'` 提取的约束是 `proposed`；用户原话（`by: 'user'`）才算 active
 *   ② **可撤销**：用户说「不用了」→ 追加 `revoked` 事件（append-only，不删历史）
 *   ③ **不静默**：文件读不动/坏行要报出来
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dbRoot } from './db.js'

/** 库的相对路径（与 criteria 同级） */
export const CONSTRAINTS_REL = 'constraints/constraints.jsonl'

/** 约束的状态 */
export const CONSTRAINT_STATES = ['proposed', 'active', 'revoked']

/** 文件绝对路径（现算，测试里 DSH_ALERT_DATA_DIR 会变） */
export function constraintsFile() {
  return path.join(dbRoot(), CONSTRAINTS_REL)
}

/** 内容指纹（同一条约束不重复记） */
function cid(text) {
  return 'k-' + crypto.createHash('sha1').update(String(text).trim()).digest('hex').slice(0, 8)
}

/** 读全部约束事件（坏行计数并回报） */
export function loadConstraints({ file = constraintsFile() } = {}) {
  if (!fs.existsSync(file)) return { ok: true, list: [], badLines: 0, reason: '约束区还是空的（还没记过）' }
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) {
    return { ok: false, list: [], badLines: 0, reason: `读不动：${e?.message || e}` }
  }
  const list = []
  let badLines = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { badLines++; continue }
    if (!o || typeof o !== 'object') { badLines++; continue }
    list.push(o)
  }
  return { ok: true, list, badLines, reason: '' }
}

/** 按 id 折叠到最新一条（= 当前状态） */
export function activeConstraints({ file = constraintsFile() } = {}) {
  const { ok, list, badLines, reason } = loadConstraints({ file })
  if (!ok) return { ok: false, list: [], badLines, reason }
  const byId = new Map()
  for (const e of list) if (e && e.id) byId.set(e.id, e)
  const act = [...byId.values()].filter((e) => e.status === 'active')
  return { ok: true, list: act, badLines, reason: '' }
}

/**
 * 追加一条约束事件（**唯一写入口**，append-only）。
 * @param {{text:string, by:'user'|'llm', source?:string, status?:string}} input
 */
export function appendConstraint(input = {}) {
  const text = String(input.text || '').trim()
  if (!text) return { ok: false, added: false, reason: '空约束不记（理由：没有内容可执行）' }
  const by = input.by === 'user' ? 'user' : 'llm'
  const status = input.status || (by === 'user' ? 'active' : 'proposed')
  if (!CONSTRAINT_STATES.includes(status)) {
    return { ok: false, added: false, reason: `status 只能是 ${CONSTRAINT_STATES.join(' / ')}` }
  }
  // 用户原话 = 权威；LLM 提取只能是 proposed（防"再确认一遍"变成卡点）
  if (status === 'active' && by !== 'user') {
    return { ok: false, added: false, reason: '只有 by=user 的直接要求才能 active —— LLM 提取的先进 proposed' }
  }
  const id = cid(text)
  const cur = loadConstraints().list
  const last = [...cur].reverse().find((e) => e.id === id)
  // 同一条"状态迁移"不重复记（active→active / proposed→proposed 是空操作）
  if (last && last.status === status) return { ok: true, added: false, id, reason: `这条已是 ${status}` }
  const rec = {
    id,
    text: text.slice(0, 300),
    by,
    status,
    source: input.source ? String(input.source).slice(0, 120) : null,
    when: input.when || new Date().toISOString(),
  }
  try {
    const f = constraintsFile()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, JSON.stringify(rec) + '\n', 'utf8')
    return { ok: true, added: true, id, status }
  } catch (e) {
    console.warn('[alert-inject/constraints] ⚠️ 约束写入失败（这条没记上）：', e?.message || e)
    return { ok: false, added: false, reason: `写入失败：${e?.message || e}` }
  }
}

/** 撤销一条约束（append 一个 revoked 事件，不删历史） */
export function revokeConstraint(text, { by = 'user', when } = {}) {
  return appendConstraint({ text, by, status: 'revoked', when })
}

/**
 * 从一段用户发言里**提取**候选约束（规则，免费；不调 LLM）。
 *
 * ⚠️ 规则只是"候选生成器"——提取出来的进 `proposed`；
 *    用户直接说的话（含「以后/必须/不要」等）才算 active。
 *
 * 判据（实测收紧版）：
 *   · 含要求词：以后/之后/都/必须/不要/别/记得/请/只能/不能/禁止/用
 *   · 不是提问（？结尾 / 是不是 / 吗）
 *   · 长度 4~120
 *   · 不是任务指令（帮我/请你/给我/下载/跑一下…——那是任务，不是约束）
 */
export function extractConstraintsFrom(text) {
  const t = String(text || '').trim()
  if (!t) return []
  const RULES = [
    /(以后|之后|今后).{0,80}(都|要|用|说|写|做)/,
    /(必须|务必|一定).{1,80}/,
    /(不要|别|禁止|不能|不可以).{1,80}/,
    /记得.{1,80}/,
    /(请|要求|规定|规则).{0,80}(用|使用|遵守|保持)/,
    /(用中文|用英文|用英语|用中文交流|说中文|说英文)/,
    /(先|永远).{1,40}(再|然后|别|不要)/,
  ]
  const isQuestion = /[？?]\s*$|是不是|吗\s*$|\?{2,}/
  const isTask = /^(帮我|请你|请帮|给我|帮我|下载|跑一下|试一下|改一下|查一下|搜一下)/
  if (isQuestion.test(t) || isTask.test(t)) return []
  if (t.length < 4 || t.length > 120) return []
  const hit = RULES.some((re) => re.test(t))
  return hit ? [t] : []
}

/**
 * 渲染约束区（给模型看的一行段；无约束返回空串）。
 * ⚠️ 有约束就**每轮都出**（它就是要常驻提醒的东西）——但控制在 3 条内，其余只报数字。
 */
export function renderConstraints({ max = 3, maxLen = 50 } = {}) {
  const r = activeConstraints()
  if (!r.ok) return `📌 约束区读不动：${r.reason}`
  if (!r.list.length) return ''
  const lines = [`📌 约束区（你之前提的要求，压缩不会丢）：`]
  for (const c of r.list.slice(0, max)) {
    const w = String(c.text).replace(/\s+/g, ' ')
    lines.push(`   · ${w.length > maxLen ? w.slice(0, maxLen) + '…' : w}`)
  }
  if (r.list.length > max) lines.push(`   · …另有 ${r.list.length - max} 条（说「撤销约束」可退役）`)
  return lines.join('\n')
}
