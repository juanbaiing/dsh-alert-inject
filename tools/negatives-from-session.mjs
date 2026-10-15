/**
 * negatives-from-session.mjs — 从**真实会话**里挑「与设定不冲突」的负例候选
 *                              （**只输出预览，不写样本库**）
 *
 * ══ 任务 ══════════════════════════════════════════════════════════
 *   `user_correction` 是**二元**（noul）：「**这段内容与已有设定冲突吗？**」
 *   正例 = 作者纠正所对应的 AI 发言（183 条，已够）；**缺负例**。
 *
 * ══ 三条路，两条已被实测否掉 ═══════════════════════════════════════
 *   **A 组**（档文 → 让模型按 AI 口吻改写）：**实测失败**。
 *       小模型只会照抄、或只删掉 `【】`／`**`，**没起到"换文体"的作用**
 *       ⇒ 负例与档文原文无异 ⇒ 掉回"文体混用"的坑。（见 `tools/gen-negatives.mjs` 头部。）
 *
 *   **B 旧法**（任意 AI 发言 ∩ 命中设定术语）：**实测形态不匹配**（2026-10-16，见下表）。
 *       它筛掉了 1080 条"没谈设定"的，理由是"标签会跑偏"。
 *       但实测发现：**正例本身就是"干活/汇报"形态的**（66% 恰好 1000 字、62% 含表格、58% 含状态标记）。
 *       ⇒ 把这类全滤掉，恰恰**滤掉了正例的形态**。
 *
 *   **B 新法（本工具默认）**：**同源同形态** ——
 *       正例 = 纠正那条用户发言**之前**的 AI 痕迹；负例 = **没纠正**那条用户发言**之前**的 AI 痕迹。
 *       同一个 `precedingAiText`、同一个 1000 字截断、同一套 kind 分布。
 *
 * ══ 实测数字（2026-10-16，`tools/_probe-form.mjs` 在同一会话上跑出来的）══
 *   | 组                 | 条数 | 中位长度 | 恰好1000字 | 含表格 | 含✅⚠️ | kind 分布        |
 *   |--------------------|------|----------|-----------|--------|--------|------------------|
 *   | 正例               |  183 | **1000** |  **66%**  |  62%   |  54%   | 取最近一条 AI 痕迹 |
 *   | 旧法候选（术语筛） |  408 | **1575** |    0%     |  44%   |  41%   | **思考 296 / 正文 112** |
 *   | 被旧法剔掉的       | 1080 |    331   |    0%     |  25%   |  28%   | 思考 466 / 正文 614 |
 *
 *   ⇒ 旧法与正例在**长度／截断／来源**上系统性不同 ⇒ 模型最容易学的是
 *     「长 vs 短」「思考 vs 正文」，**而不是「冲突 vs 不冲突」**。
 *
 * ══ 纪律 ═══════════════════════════════════════════════════════════
 *   ① **默认只预览**，不写样本库（入库要走 `samples.js` 的标准路径）。
 *   ② **拿不到数据就说拿不到**，不静默用别的凑。
 *   ③ 每条都标出**来源 pos**，可回原文核对。
 *   ④ **形态对照表随预览一起打** —— 让你能自己核"两类像不像"，而不是只能信我。
 *
 * 用法：
 *   node tools/negatives-from-session.mjs --project D:/某项目 --n 6
 *   node tools/negatives-from-session.mjs --project D:/某项目 --n 6 --seed 3 --show-excluded
 *   node tools/negatives-from-session.mjs --project D:/某项目 --by-terms   # 旧法（⚠️ 实测不匹配）
 */

import path from 'node:path'
import { latestSessionFile, recentActivity } from '../lib/index.js'
import { loadSamples } from '../lib/samples.js'
import { extractCorrections, extractNonCorrections } from '../lib/learning.js'
import { buildTermIndex } from '../lib/verify-samples.js'

const argv = process.argv.slice(2)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }
const has = (k) => argv.includes(k)

const projectRoot = get('--project') || process.env.DSH_ALERT_PROJECT || undefined
const N = +(get('--n', 6))
const SEED = +(get('--seed', 1))
const MIN_LEN = +(get('--min-len', 20))
const BY_TERMS = has('--by-terms')

if (!projectRoot) {
  console.log('⚠️ 没给项目根（--project）⇒ 找不到会话文件。')
  process.exit(2)
}

let _s = SEED
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff }

console.log('══════════════════════════════════════════════════════════')
console.log('  从真实会话里挑「不冲突」负例候选 —— 【预览，不写样本库】')
if (BY_TERMS) console.log('  ⚠️ 旧法（--by-terms）——**实测形态与正例不匹配**，仅供对照')
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

// ── 正例（同源：这一段会话里作者纠正过的那条用户发言**之前**的 AI 痕迹）──
const pos = extractCorrections(acts)
const wrongs = pos.map((p) => String(p.wrong || '').trim()).filter((w) => w.length >= 8)
console.log(`本会话正例（作者纠正）：${pos.length} 条，其中可用 input ${wrongs.length} 条`)
console.log(`样本库里的正例：${loadSamples().filter((e) => e.kind === 'corr' && e.wrong).length} 条（供参照）`)

const overlap = (a, b) => {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a]
  if (s.length < 12) return false
  return l.includes(s)
}

// ── 形态对照这个小工具：把"两类像不像"变成可看的东西 ──
const kindOf = new Map()
for (const a of acts) {
  if (a.kind !== '思考' && a.kind !== '正文') continue
  const s = String(a.text || '').trim()
  if (s) kindOf.set(s.slice(0, 60), a.kind)
}
const kind = (t) => kindOf.get(String(t).slice(0, 60)) || '？'
const med = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const pct = (arr, f) => arr.length ? Math.round(arr.filter(f).length / arr.length * 100) + '%' : '—'
function formTable(rows) {
  console.log('组别                条数  中位长度  恰好1000字  含```  含表格  含✅⚠️  纯散文   正文/思考')
  for (const [name, texts] of rows) {
    const L = texts.map((t) => String(t).length)
    const kd = texts.reduce((a, t) => { const k = kind(t); a[k] = (a[k] || 0) + 1; return a }, {})
    console.log(
      name.padEnd(18) +
      String(texts.length).padStart(5) +
      String(med(L)).padStart(10) +
      pct(texts, (t) => String(t).length === 1000).padStart(12) +
      pct(texts, (t) => /```/.test(t)).padStart(8) +
      pct(texts, (t) => /\|/.test(t)).padStart(8) +
      pct(texts, (t) => /[✅⚠️]/.test(t)).padStart(9) +
      pct(texts, (t) => !/[`|#>*]/.test(t)).padStart(9) +
      `   ${kd['正文'] || 0}/${kd['思考'] || 0}`
    )
  }
}

let candidates = []      // [{pos, kind, text, why}]
let modeNote = ''

if (!BY_TERMS) {
  // ══ 默认：同源同形态 ══
  const { items, userTurns, noPrev } = extractNonCorrections(acts)
  console.log(`用户发言：${userTurns} 条；其中「没纠正」且能取到之前 AI 发言的：${items.length} 条`)
  if (noPrev) console.log(`  ⇒ 跳过 ${noPrev} 条（会话开头，**没有"之前的 AI 发言"**）—— 不用别的文本凑数`)
  const kept = []
  let dup = 0
  for (const it of items) {
    if (wrongs.some((w) => overlap(w, it.input))) { dup++; continue }   // ⚠️ 同一 input 不能两栖
    kept.push({ pos: it.pos, text: it.input, why: it.user })
  }
  console.log(`  ⇒ 排除 ${dup} 条（与正例的 input 重合 —— 相邻用户发言可能共享同一条"之前的 AI 发言"，同一 input 不能既是正例又是负例）`)
  console.log(`  ⇒ **候选负例 ${kept.length} 条**`)
  candidates = kept
  modeNote = '同源同形态（默认）'

  console.log('')
  formTable([['正例', wrongs], ['负例候选', kept.map((k) => k.text)]])
  console.log('  ⚠️ 判据：两列的**中位长度／恰好1000字／正文-思考比**越接近越好 ——')
  console.log('     差得远就说明模型可能学的是"长度"或"思考 vs 正文"，而不是"冲突"。')
  console.log('')
  console.log('  ⚠️⚠️ 本模式**仍未解决的两个问题**（照实说，不藏）：')
  console.log('    ① **覆盖不对等**：正例来自样本库（**多会话累积**），而负例只来自**本会话**')
  console.log('       ⇒ 会话/项目分布本身又是一个潜在伪特征（不同会话的文体、话题、档版本都不同）。')
  console.log('       要根治得**按会话配对**：哪个会话出了正例，就在**同一个会话**里取负例。')
  console.log(`    ② **类不平衡**：本会话 ${wrongs.length} 正 vs ${kept.length} 负`
    + `（约 1:${kept.length ? Math.round(kept.length / Math.max(wrongs.length, 1)) : '—'}）`)
  console.log('       ⇒ 训练时通常把负例**下采样**到与正例同量级，别直接全喂。')
} else {
  // ══ 旧法：任意 AI 发言 ∩ 命中设定术语 ══
  const { index: termIndex, nodeCount } = buildTermIndex(projectRoot)
  console.log(`设定术语索引：${termIndex.size} 词 / ${nodeCount} 节点`)
  if (!termIndex.size) {
    console.log('')
    console.log('⚠️ 术语索引是空的 ⇒ 旧法这一关过不了（不静默用全部凑数）。改用默认模式（去掉 --by-terms）。')
    process.exit(1)
  }
  const hitTerms = (t) => { const out = []; for (const [w] of termIndex) if (t.includes(w)) out.push(w); return out }
  const ai = []
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]
    if (a.kind !== '正文' && a.kind !== '思考') continue
    const t = String(a.text || '').trim()
    if (t.length < MIN_LEN) continue
    ai.push({ pos: i + 1, kind: a.kind, text: t })
  }
  console.log(`AI 发言（正文/思考，≥${MIN_LEN} 字）：${ai.length} 条`)
  const kept = []
  const off = []
  let excluded = 0
  for (const x of ai) {
    if (wrongs.some((w) => overlap(w, x.text))) { excluded++; continue }
    const hits = hitTerms(x.text)
    if (!hits.length) { off.push(x); continue }
    kept.push({ pos: x.pos, text: x.text, why: hits.slice(0, 4).join('、') })
  }
  console.log(`  ⇒ 排除 ${excluded} 条（与被纠正的说法重合）`)
  console.log(`  ⇒ 剔除 ${off.length} 条（**没命中设定术语**）`)
  console.log(`  ⇒ **候选负例 ${kept.length} 条**`)
  candidates = kept
  modeNote = '旧法（按设定术语筛）'

  console.log('')
  formTable([['正例', wrongs], ['负例候选', kept.map((k) => k.text)], ['被剔掉的', off.map((k) => k.text)]])
  console.log('  ⚠️ 见上表：旧法候选的中位长度、恰好1000字比例、正文/思考比与正例**明显不同** ⇒')
  console.log('     这正是 2026-10-16 判定它"形态不匹配"的依据。默认模式（同源同形态）已修掉这一点。')
}

if (has('--show-excluded') && candidates.length) {
  console.log('')
  console.log('── 候选的"它之前那条用户发言"（用于核对：这次确实没纠正）──')
  for (const c of candidates.slice(0, 4)) {
    console.log(`  [pos=${c.pos}] 用户当时说：${String(c.why).slice(0, 60).replace(/\n/g, ' ')}…`)
  }
}

if (!candidates.length) {
  console.log('')
  console.log('⚠️ 一条候选都没有。**不是"没有负例"** —— 可能是：会话为空 / 用户发言都被判成纠正 / 都与正例重合。')
  process.exit(1)
}

// ── 抽样预览 ──
const picked = []
const used = new Set()
while (picked.length < Math.min(N, candidates.length)) {
  const i = Math.floor(rnd() * candidates.length)
  if (used.has(i)) continue
  used.add(i)
  picked.push(candidates[i])
}

console.log('')
console.log(`── 抽样 ${picked.length} 条（${modeNote}，seed=${SEED}）──`)
for (const p of picked) {
  console.log(`  [pos=${p.pos}]`)
  console.log(`    ${String(p.text).slice(0, 100).replace(/\n/g, ' ')}${String(p.text).length > 100 ? '…' : ''}`)
  console.log('')
}

console.log('══════════════════════════════════════════════════════════')
console.log('【你要判的三件事】')
console.log('  1. 这些发言**真的没和设定冲突**吗？（"没被纠正"只是弱证据 —— 也可能你当时没看到）')
console.log('  2. 它们的**文体**是不是跟正例（你纠正的那些 AI 说法）一致？（看上面的形态对照表）')
console.log('  3. 拿 1 条正例 + 1 条这个负例摆在一起 —— **除了"对错"，还看得出别的差别吗？**')
console.log('     （若看得出"一个是错的、一个是对的"以外的差别，那模型学的就不是"冲突"了）')
console.log('  ⚠️ 第 3 问现在**已被程序部分回答**（表里的长度/截断/正文思考比）——')
console.log('     但"内容上像不像"只有你能判。')
console.log('')
console.log('⚠️ 本工具**没写任何数据**。')
console.log('   要入库：走 `samples.js` 的标准路径（recordPrediction + label），别旁路改文件。')
console.log('══════════════════════════════════════════════════════════')
