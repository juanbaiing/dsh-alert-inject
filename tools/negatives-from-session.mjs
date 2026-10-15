/**
 * negatives-from-session.mjs — 从**真实会话**里挑「与设定不冲突」的负例候选
 *                              （**只输出预览，不写样本库**）
 *
 * ══ 为什么走这条路（A 组已被实测否掉）══════════════════════════════
 *   `user_correction` 任务的形态是 **noul（二元）**：「**这段内容与已有设定冲突吗？**」
 *   正例 = 作者纠正（182 条，已够）；**缺负例**。
 *
 *   A 组（拿档文原文 → 让模型按 AI 口吻改写）**实测失败**：
 *   小模型只会照抄或只删掉 `【】`／`**`，**没起到"换文体"的作用**
 *   ⇒ 那样得到的负例与档文原文无异 ⇒ **又掉回"文体混用"的坑**（模型会去学文体，不是学冲突）。
 *
 *   B 组：**直接用真实的 AI 发言**当负例。
 *   > 强：**同文体**（天然）／**零幻觉**（不是造的）／**立刻可试**
 *   > 弱：「作者没纠正」只是**弱证据**（也可能是他没看到）
 *
 * ══ 怎么判「没被纠正过」════════════════════════════════════════
 *   `user_correction` 的 `wrong` 字段 = **被作者否定的那句 AI 说法**。
 *   ⇒ 若一条 AI 发言与任何 `wrong` **互相包含**（或长重合），就把它**排除**。
 *   ⚠️ 这是**启发式**，不是严格判定 —— 所以本工具会把"排除了什么"也列出来，供你复核。
 *
 * ══ 纪律 ═══════════════════════════════════════════════════════
 *   ① **默认只预览**，不写样本库（要写必须另走 `samples.js` 的标准路径）。
 *   ② **拿不到数据就说拿不到**，不静默用别的凑。
 *   ③ 每条都标出**来源 pos**，可回原文核对。
 *
 * 用法：
 *   node tools/negatives-from-session.mjs --project D:/某项目 --n 6
 *   node tools/negatives-from-session.mjs --project D:/某项目 --n 6 --seed 3 --show-excluded
 */

import path from 'node:path'
import os from 'node:os'
import { latestSessionFile, recentActivity } from '../lib/index.js'
import { loadSamples } from '../lib/samples.js'
import { buildTermIndex } from '../lib/verify-samples.js'

const argv = process.argv.slice(2)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }
const has = (k) => argv.includes(k)

const projectRoot = get('--project') || process.env.DSH_ALERT_PROJECT || undefined
const N = +(get('--n', 6))
const SEED = +(get('--seed', 1))
const MIN_LEN = +(get('--min-len', 20))

if (!projectRoot) {
  console.log('⚠️ 没给项目根（--project）⇒ 找不到会话文件。')
  process.exit(2)
}

let _s = SEED
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff }

console.log('══════════════════════════════════════════════════════════')
console.log('  从真实会话里挑「不冲突」负例候选 —— 【预览，不写样本库】')
console.log('══════════════════════════════════════════════════════════')
console.log(`项目根：${projectRoot}`)

const sess = latestSessionFile(projectRoot)
if (!sess) {
  console.log('')
  console.log('⚠️ 找不到这个项目下的会话文件 ⇒ 拿不到材料（**这不是"没有负例"，是"没找到数据"**）。')
  process.exit(1)
}
console.log(`会话文件：${path.basename(path.dirname(sess))}`)

const acts = recentActivity(sess, 0)
console.log(`痕迹总数：${acts.length}`)

// ── 取"被作者否定的说法"（corr 事件的 wrong）──
const wrongs = loadSamples()
  .filter((e) => e.kind === 'corr' && e.wrong)
  .map((e) => String(e.wrong).trim())
  .filter((w) => w.length >= 8)
console.log(`作者纠正过（被否定的 AI 说法）：${wrongs.length} 条`)

// ── 只取 AI 发言（正文/思考），且足够长 ──
const ai = []
for (let i = 0; i < acts.length; i++) {
  const a = acts[i]
  if (a.kind !== '正文' && a.kind !== '思考') continue
  const t = String(a.text || '').trim()
  if (t.length < MIN_LEN) continue
  ai.push({ pos: i + 1, kind: a.kind, text: t })
}
console.log(`AI 发言（正文/思考，≥${MIN_LEN} 字）：${ai.length} 条`)

// ── ⚠️⚠️ 关键过滤：**只保留"在谈设定"的发言** ──
//   实测教训（2026-10-16）：第一版没做这一步，抽出来的 6 条**全是"干活/汇报/调试"**
//   （"别名扩展生效 ✓"、"本机只有两个模型"、"登记完簿子"…）—— **没有一条在谈设定**。
//   ⇒ 拿这些当负例，模型学到的是「**谈设定的 vs 不谈设定的**」，
//     而**不是**「**与设定冲突 vs 不冲突**」—— 标签完全跑偏。
//   ⇒ 复用 `verify-samples.js` 的术语索引：**命中了设定术语 = 这条确实在谈设定**。
const { index: termIndex, nodeCount } = buildTermIndex(projectRoot)
console.log(`设定术语索引：${termIndex.size} 词 / ${nodeCount} 节点`)
if (!termIndex.size) {
  console.log('')
  console.log('⚠️ 术语索引是空的 ⇒ **「在不在谈设定」这一关过不了**，本工具做不了（不静默用全部凑数）。')
  process.exit(1)
}
const hitTerms = (t) => { const out = []; for (const [w] of termIndex) if (t.includes(w)) out.push(w); return out }

// ── 排除"与任何被纠正说法互相包含"的 ──
const overlap = (a, b) => {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a]
  if (s.length < 12) return false
  return l.includes(s)
}
const kept = []
const excluded = []
let offTopic = 0
for (const x of ai) {
  const hit = wrongs.find((w) => overlap(w, x.text))
  if (hit) { excluded.push({ ...x, why: hit }); continue }
  const hits = hitTerms(x.text)
  if (!hits.length) { offTopic++; continue }          // ⚠️ 没谈设定 ⇒ 不适合当这个任务的负例
  kept.push({ ...x, hits })
}
console.log(`  ⇒ 排除 ${excluded.length} 条（与被纠正的说法重合）`)
console.log(`  ⇒ 剔除 ${offTopic} 条（**没谈设定** —— 干活/汇报类，标签会跑偏）`)
console.log(`  ⇒ **剩下 ${kept.length} 条**是"在谈设定 且 没被纠正"的负例候选`)

if (has('--show-excluded') && excluded.length) {
  console.log('')
  console.log('── 被排除的（前 4 条，供你复核这个启发式准不准）──')
  for (const e of excluded.slice(0, 4)) {
    console.log(`  [pos=${e.pos}] 发言：${e.text.slice(0, 58)}…`)
    console.log(`            判为重复于：${e.why.slice(0, 58)}…`)
  }
}

if (!kept.length) {
  console.log('')
  console.log('⚠️ 一条候选都没有。**不是"没有负例"** —— 可能是：会话为空 / 痕迹都被排除了 / min-len 设太高。')
  process.exit(1)
}

// ── 抽样预览 ──
const picked = []
const used = new Set()
while (picked.length < Math.min(N, kept.length)) {
  const i = Math.floor(rnd() * kept.length)
  if (used.has(i)) continue
  used.add(i)
  picked.push(kept[i])
}

console.log('')
console.log(`── 抽样 ${picked.length} 条（seed=${SEED}）──`)
for (const p of picked) {
  console.log(`  [pos=${p.pos} · ${p.kind}]`)
  console.log(`    ${p.text.slice(0, 100).replace(/\n/g, ' ')}${p.text.length > 100 ? '…' : ''}`)
  console.log('')
}

console.log('══════════════════════════════════════════════════════════')
console.log('【你要判的三件事】')
console.log('  1. 这些发言**真的没和设定冲突**吗？（"没被纠正"只是弱证据 —— 也可能你当时没看到）')
console.log('  2. 它们的**文体**是不是跟正例（你纠正的那些 AI 说法）一致？')
console.log('  3. 拿 1 条正例 + 1 条这个负例摆在一起 —— **除了"对错"，还看得出别的差别吗？**')
console.log('     （若看得出"一个是错的、一个是对的"以外的差别，那模型学的就不是"冲突"了）')
console.log('')
console.log('⚠️ 本工具**没写任何数据**。')
console.log('   要入库：走 `samples.js` 的标准路径（recordPrediction + label），别旁路改文件。')
console.log('══════════════════════════════════════════════════════════')
