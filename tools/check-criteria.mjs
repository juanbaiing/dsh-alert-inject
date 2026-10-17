#!/usr/bin/env node
/**
 * check-criteria.mjs —— 验证**判据池**的核心不变量。
 *
 * 为什么这个检查必须存在：
 *   判据池的唯一存在理由是「**只追加、不改**」（OWASP ASI01 的 goal immutability）。
 *   而这个性质**坏了不会有任何报错**——它只会表现为"判据被悄悄改了"，
 *   于是 AI 可以事后重写判据来让旧行为看起来合规。
 *   ⇒ 所以必须有可执行的判据来证明：**写不进去的、改不掉的、不会丢的**。
 *
 * 判据（缺一不可）：
 *   ① **无修改/删除接口** —— 导出里不能有 update / delete / remove / set 开头的函数
 *   ② **必填缺失 ⇒ 明确拒绝**，且 reason 说清缺哪几个
 *   ③ **权威只能来自用户** —— status=active 且 by≠user ⇒ 拒绝
 *   ④ **supersede 必须指向真实条目**，且旧条目自动转 superseded（**旧条目仍在文件里**）
 *   ⑤ **同状态不重复追加**（幂等）
 *   ⑥ **已 active 的不能被改回 proposed**（不可逆）
 *   ⑦ **文件行数只增不减** —— 任何操作之后，已有行必须是新文件的**前缀**
 *
 * 用法：`node tools/check-criteria.mjs`（退出码非 0 = 有未过项）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 隔离：必须在 import 之前（dbRoot 每次现读环境变量，但仍先设更稳）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-criteria-'))
process.env.DSH_ALERT_DATA_DIR = TMP
process.env.ALERT_NO_RETRIEVAL = '1'

const LIB = new URL('../lib/', import.meta.url).href
const C = await import(LIB + 'criteria.js')

let pass = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('  ❌ ' + name + (detail ? '\n       ' + detail : '')) }
}

console.log('══════ 判据池不变量检查 ══════')
console.log('隔离目录: ' + TMP)
console.log('')

// ══════════════ ① 接口面：不能有修改/删除 ══════════════
console.log('───── ① 接口面：只追加，无修改/删除 ─────')
const exported = Object.keys(C)
const forbidden = exported.filter((k) => /^(update|delete|remove|set|edit|patch|overwrite)/i.test(k))
ok('导出里没有 update/delete/remove/set/edit 之类（只有 append）', forbidden.length === 0, forbidden.join(', '))
ok('有 appendCriterion（唯一写入口）', typeof C.appendCriterion === 'function')
ok('有 loadCriteria / activeCriteria / criteriaStatus', [C.loadCriteria, C.activeCriteria, C.criteriaStatus].every((f) => typeof f === 'function'))

// ══════════════ ② 必填校验 ══════════════
console.log('')
console.log('───── ② 必填字段缺失 ⇒ 明确拒绝 ─────')
{
  const r = C.appendCriterion({ what: '只有 what' })
  ok('缺 kind/by/when ⇒ 被拒', r.ok === false)
  ok('reason 说清缺哪几个', !!(r.reason && ['kind', 'by', 'when'].filter((k) => r.reason.includes(k)).length >= 2), r.reason)
}

// ══════════════ ③ 白名单 ══════════════
console.log('')
console.log('───── ③ kind / status 白名单 ─────')
{
  const a = C.appendCriterion({ what: 'x1', kind: '随便写', by: 'llm', when: 'now' })
  ok('kind 不在白名单 ⇒ 被拒', a.ok === false, a.reason)
  const b = C.appendCriterion({ what: 'x2', kind: 'goal', by: 'llm', when: 'now', status: 'weird' })
  ok('status 不在白名单 ⇒ 被拒', b.ok === false, b.reason)
}

// ══════════════ ④ 权威只能来自用户 ══════════════
console.log('')
console.log('───── ④ 权威只能来自用户（防"裁判权落在受审者手里"）─────')
{
  const r = C.appendCriterion({ what: '让 LLM 遵守世界设定', kind: 'goal', by: 'llm', when: 'now', status: 'active' })
  ok('LLM 自己把判据置为 active ⇒ 被拒', r.ok === false, r.reason)
  ok('reason 提到 by=user', !!(r.reason && /user/.test(r.reason)), r.reason)
}

// ══════════════ ⑤ 正常流程：propose → confirm ══════════════
console.log('')
console.log('───── ⑤ 正常流程：LLM 提议 → 用户确认 ─────')
const WHAT = '让 LLM 在生成时遵守设定档里的世界条件'
{
  const p = C.appendCriterion({ what: WHAT, kind: 'goal', by: 'llm', when: 'now', quote: '' })
  ok('LLM 提议（proposed）⇒ 接受', p.ok === true && p.added === true, JSON.stringify(p))
  const dup = C.appendCriterion({ what: WHAT, kind: 'goal', by: 'llm', when: 'now' })
  ok('同状态重复追加 ⇒ 幂等（added=false 但 ok=true）', dup.ok === true && dup.added === false, JSON.stringify(dup))

  let st = C.criteriaStatus()
  ok('此时 active=0（提议不算权威）', st.active === 0, JSON.stringify(st))
  ok('此时 needsConfirmation=true（这是"该问一次"的信号）', st.needsConfirmation === true)

  const c = C.appendCriterion({ what: WHAT, kind: 'goal', by: 'user', when: 'now', status: 'active', quote: '我最初是在创作虚拟世界观，LLM 老是不能正确运行我给的世界条件' })
  ok('用户确认 ⇒ 接受', c.ok === true && c.added === true, JSON.stringify(c))

  st = C.criteriaStatus()
  ok('此时 active=1', st.active === 1, JSON.stringify(st))
  ok('activeCriteria() 只返回生效的', C.activeCriteria().length === 1)
  ok('renderCriteriaLine 输出一行且含判据', C.renderCriteriaLine().includes('生效判据'))
}

// ══════════════ ⑥ 不可逆：active 不能回退 ══════════════
console.log('')
console.log('───── ⑥ 不可逆：已 active 的不能被改回 proposed ─────')
{
  const r = C.appendCriterion({ what: WHAT, kind: 'goal', by: 'llm', when: 'now', status: 'proposed' })
  ok('active → proposed ⇒ 被拒', r.ok === false, r.reason)
}

// ══════════════ ⑦ supersede 链 ══════════════
console.log('')
console.log('───── ⑦ supersede：换目标时旧条目必须还在 ─────')
{
  const oldId = C.criterionId('goal', WHAT)
  const NEW = '让 LLM 在生成时遵守设定档，并指出违反了哪一条'
  const bad = C.appendCriterion({ what: '新目标', kind: 'goal', by: 'user', when: 'now', status: 'active', supersedes: 'c-不存在' })
  ok('supersede 指向不存在的判据 ⇒ 被拒', bad.ok === false, bad.reason)

  const r = C.appendCriterion({ what: NEW, kind: 'goal', by: 'user', when: 'now', status: 'active', supersedes: oldId, quote: '要指到具体哪一条' })
  ok('合法 supersede ⇒ 接受', r.ok === true, JSON.stringify(r))

  const after = C.loadCriteria()
  ok('旧条目**仍在**（只是状态变了）', after.byId.has(oldId), 'byId 里没有旧 id')
  ok('旧条目状态 = superseded', after.byId.get(oldId)?.status === 'superseded', after.byId.get(oldId)?.status)
  ok('旧条目的 supersededBy 指向新条目', after.byId.get(oldId)?.supersededBy === C.criterionId('goal', NEW))
  ok('activeCriteria 现在只有 1 条（新的那条）', C.activeCriteria().length === 1)
  ok('新条目的 what 正确', C.activeCriteria()[0].what === NEW)
}

// ══════════════ ⑧ 只追加：文件行数只增不减（最核心）══════════════
console.log('')
console.log('───── ⑧ 只追加：行数只增不减，且旧行必须是新行的前缀 ─────')
{
  const f = C.criteriaFile()
  const linesNow = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
  console.log(`  当前 ${linesNow.length} 行`)

  // 再跑一串操作（含被拒的）
  C.appendCriterion({ what: '约束：不许改我的设定档', kind: 'constraint', by: 'user', when: 'now', status: 'active' })
  C.appendCriterion({ what: '验收：能指到档名+行号', kind: 'acceptance', by: 'llm', when: 'now' })
  C.appendCriterion({ what: 'x', kind: 'goal', by: 'llm' })                      // 会被拒
  C.appendCriterion({ what: WHAT, kind: 'goal', by: 'llm', status: 'proposed' })  // 会被拒（不可逆）

  const linesAfter = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
  ok('行数只增不减', linesAfter.length >= linesNow.length, `${linesNow.length} → ${linesAfter.length}`)
  const prefixIntact = linesNow.every((l, i) => linesAfter[i] === l)
  ok('**已有行逐字节未变**（这就是"不改"的可核对证据）', prefixIntact)

  // 每行都是合法 JSON 且带 id/status
  let bad = 0
  for (const l of linesAfter) {
    try {
      const o = JSON.parse(l)
      if (!o.id || !o.status || !o.what) bad++
    } catch { bad++ }
  }
  ok('每行都是合法 JSON 且含 id/status/what', bad === 0, `坏行 ${bad}`)
}

// ══════════════ ⑨ 空池与渲染克制 ══════════════
console.log('')
console.log('───── ⑨ 空池不产生噪音；渲染最多 3 条 ─────')
{
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-empty-'))
  process.env.DSH_ALERT_DATA_DIR = emptyDir
  // ⚠️ 注意：dbRoot() 每次现读环境变量 ⇒ 这里能真正切到空目录
  const st = C.criteriaStatus()
  ok('空池时 isEmpty=true', st.isEmpty === true, JSON.stringify(st))
  ok('空池时 renderCriteriaLine 返回空串（不给噪音）', C.renderCriteriaLine() === '', JSON.stringify(C.renderCriteriaLine()))
  fs.rmSync(emptyDir, { recursive: true, force: true })
  process.env.DSH_ALERT_DATA_DIR = TMP
}

// ══════════════ ⑩ criteriaPrompt：三态（空池问 / 待确认问 / 有生效沉默）══════════════
console.log('')
console.log('───── ⑩ criteriaPrompt 三态：只在真需要时出声 ─────')
{
  /**
   * ⚠️ 这一节是本功能**最容易被做错**的地方：一旦每轮都说，它就变成噪音，
   *   而噪音会被忽略 ⇒ "目标对齐"等于没有。
   *   依据：[ECLAIR (Adobe, AAAI)](https://ojs.aaai.org/index.php/AAAI/article/view/35152/37307)
   *   明确说 precision 比 recall 重要，「不必要的澄清问题会显著破坏体验」。
   */
  const D2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cp-'))
  process.env.DSH_ALERT_DATA_DIR = D2

  // 状态 1：空池 ⇒ 必须问
  const p1 = C.criteriaPrompt()
  ok('空池 ⇒ 输出质问', p1.length > 0)
  ok('空池 ⇒ 问「你要做什么」', /你要做什么/.test(p1), p1)
  ok('空池 ⇒ 问「怎么算做成了」（验收标准）', /做成了|验收/.test(p1), p1)
  ok('空池 ⇒ 说明判据只增不改', /只增不改/.test(p1), p1)

  // 状态 2：有 proposed ⇒ 问确认，不再说"空池"
  C.appendCriterion({ what: '让 LLM 遵守设定档里的世界条件', kind: 'goal', by: 'llm', when: 'now' })
  const p2 = C.criteriaPrompt()
  ok('待确认 ⇒ 说「待你确认」', /待你确认/.test(p2), p2)
  ok('待确认 ⇒ 列出那条判据', /遵守设定档/.test(p2), p2)
  ok('待确认 ⇒ **不再说「是空的」**', !/是空的/.test(p2), p2)
  ok('待确认 ⇒ 强调「确认了我才按它判」', /确认了我才按它判/.test(p2), p2)

  // 状态 3：全部 active ⇒ **一个字都不说**
  C.appendCriterion({ what: '让 LLM 遵守设定档里的世界条件', kind: 'goal', by: 'user', when: 'now', status: 'active' })
  ok('**有生效判据 ⇒ 返回空串（平时不打扰）**', C.criteriaPrompt() === '', JSON.stringify(C.criteriaPrompt()))

  // 状态 4：坏行 ⇒ 要说
  fs.appendFileSync(C.criteriaFile(), '这不是 JSON\nnull\n', 'utf8')
  const p4 = C.criteriaPrompt()
  ok('坏行 ⇒ 报出来（不假装判据少）', /行坏了/.test(p4), p4)
  ok('坏行 ⇒ badLines 计数 ≥2', C.criteriaStatus().badLines >= 2, String(C.criteriaStatus().badLines))

  // 状态 5：读不动 ⇒ 出声，且**不伪装成空池**
  fs.rmSync(C.criteriaFile(), { force: true })
  fs.mkdirSync(C.criteriaFile(), { recursive: true })
  const p5 = C.criteriaPrompt()
  ok('读不动 ⇒ 说「读不动」', /读不动/.test(p5), p5)
  ok('读不动 ⇒ 说「本次无法做目标对齐」', /无法做目标对齐/.test(p5), p5)
  ok('读不动 ⇒ **没有伪装成「池是空的」**', !/池是空的/.test(p5), p5)

  fs.rmSync(D2, { recursive: true, force: true })
  process.env.DSH_ALERT_DATA_DIR = TMP
}

// ── 收尾 ──
fs.rmSync(TMP, { recursive: true, force: true })
console.log('')
console.log('══════ 结论 ══════')
console.log(`  通过 ${pass} 项 · 失败 ${fails.length} 项`)
if (fails.length) {
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
console.log('  ✅ 判据池成立：只追加、权威仅来自用户、换目标不丢旧条目。')
