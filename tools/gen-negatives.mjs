/**
 * gen-negatives.mjs — 生成「**与设定不冲突**」的负例候选（**只输出预览，不写样本库**）
 *
 * ══ 为什么需要它 ═══════════════════════════════════════════════════
 *   `user_correction` 任务的形态是 **noul（二元）**：「**这段内容与已有设定冲突吗？**」
 *   正例来自**作者纠正**（182 条，已够）—— 但 `training.js` 早就指出：
 *   > 「正例已够一类，但**负例尚未生成** ⇒ 补齐即可训。**负例可由档文自动生成，不需要人工。**」
 *
 * ══ ⚠️ 为什么不能直接拿档文原文当负例 ═════════════════════════════
 *   正例是「**AI 说过的话**」，而档文是「**设定文档**」——
 *   直接混用 ⇒ 模型学到的是「**文体差别**」，不是「**冲突与否**」。
 *   （本项目已踩过一次同类坑：一份"人类样本"是**繁体经典文学**、AI 样本是**简体说明文**，
 *     字体＋文体两个变量同时不同 ⇒ 测出来的可能根本不是想测的东西。）
 *   ⇒ 所以本工具让模型**把设定陈述用 AI 的口吻说一遍**，从而**只改文体、不改事实**。
 *
 * ══ 三条硬约束 ═══════════════════════════════════════════════════
 *   ① **默认只预览** —— 不写样本库。要写必须显式给 `--write`（而这个开关**现在故意没实现**）。
 *   ② **拿不到模型就说拿不到** —— 不静默退化成"用原文凑数"。
 *   ③ **逐条给出"原文 vs 改写"对照** —— 让你能一眼看出它有没有**加原文没有的东西**（幻觉）。
 *
 * 用法：
 *   node tools/gen-negatives.mjs --docs D:/某项目/设定档案-JS --n 3
 *   node tools/gen-negatives.mjs --docs D:/某项目/设定档案-JS --n 10 --seed 7
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const argv = process.argv.slice(2)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }

const DOCS = get('--docs')
const N = +(get('--n', 3))
const SEED = +(get('--seed', 1))
const MODEL = get('--model', 'qwen2.5:3b')
const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434'

if (!DOCS || !fs.existsSync(DOCS)) {
  console.log('⚠️ 没给档文目录（--docs）或它不存在 ⇒ 拿不到设定材料。')
  console.log('   用法：node tools/gen-negatives.mjs --docs D:/某项目/设定档案-JS --n 3')
  process.exit(2)
}

// ── 简易可复现随机（同一个 seed 给同一批样本，便于复核）──
let _s = SEED
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff }

/** 递归收集一个 doc 对象里所有「像设定陈述」的字符串 */
function collectStrings(v, out = []) {
  if (typeof v === 'string') {
    const t = v.trim()
    // 只要够长、且不是纯标题/引用/标记的句子
    if (t.length >= 12 && !/^[（(]/.test(t) && !t.startsWith('[[') && !/^[※【]?\s*详见/.test(t)) out.push(t)
  } else if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out)
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) collectStrings(v[k], out)
  }
  return out
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.js') && !/\.min\.js$/.test(e.name)) out.push(p)
  }
  return out
}

// ── 收集候选设定陈述 ──
const docs = []
for (const f of walk(DOCS)) {
  try {
    const mod = require_(f)
    const doc = mod?.doc || mod
    for (const s of collectStrings(doc)) docs.push({ from: path.relative(DOCS, f).replace(/\\/g, '/'), text: s })
  } catch { /* 单个档读不动就跳过（下面会报总数对比） */ }
}

console.log('══════════════════════════════════════════════════════════')
console.log('  生成「与设定不冲突」的负例候选 —— 【预览，不写样本库】')
console.log('══════════════════════════════════════════════════════════')
console.log(`档文目录：${DOCS}`)
console.log(`档文文件：${walk(DOCS).length} 个   可用设定陈述：${docs.length} 条`)

if (!docs.length) {
  console.log('')
  console.log('⚠️ 一条可用的设定陈述都没收集到 —— 不是"没问题"，是"没找到材料"。')
  console.log('   检查：档文是否真的是 `module.exports = { doc }` 形式。')
  process.exit(1)
}

// ── 抽样 ──
const picked = []
const used = new Set()
while (picked.length < Math.min(N, docs.length)) {
  const i = Math.floor(rnd() * docs.length)
  if (used.has(i)) continue
  used.add(i)
  picked.push(docs[i])
}

// ── 探活：拿不到模型就明说，不静默退化 ──
let alive = false
try {
  const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(6000) })
  alive = r.ok
} catch { alive = false }

if (!alive) {
  console.log('')
  console.log(`⚠️ 连不上本机模型（${OLLAMA}）⇒ **这一步做不了**。`)
  console.log('   ⚠️ 我不会退化成"直接用档文原文当负例" —— 那会造成文体混用（见文件头说明）。')
  console.log('   先启动 Ollama，或换 --model / OLLAMA_HOST。')
  console.log('')
  console.log('（下面仍然把抽中的原始设定陈述列出来，供你看材料长什么样）')
  for (const p of picked) console.log(`  · [${p.from}] ${p.text.slice(0, 70)}`)
  process.exit(1)
}

const PROMPT = (s) =>
  '把下面这条设定，用「向项目作者汇报」的口吻自然地说一遍。\n' +
  '⚠️ 硬要求：**只使用给定信息，不得添加任何新内容，不得推测，不得润色出原文没有的事实**。\n' +
  '⚠️ 保持专有名词原样。只输出那句话本身，不要解释、不要加引号。\n\n' +
  '设定：' + s

console.log('')
console.log(`用模型：${MODEL}`)
console.log('')
for (let i = 0; i < picked.length; i++) {
  const p = picked[i]
  let out = ''
  let err = null
  try {
    const r = await fetch(OLLAMA + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: PROMPT(p.text), stream: false, options: { temperature: 0.4 } }),
      signal: AbortSignal.timeout(60000),
    })
    if (!r.ok) err = 'HTTP ' + r.status
    else out = String((await r.json()).response || '').trim()
  } catch (e) { err = e?.message || String(e) }

  console.log(`── #${i + 1}  源：[${p.from}]`)
  console.log(`   原文：${p.text}`)
  if (err) console.log(`   ⚠️ 生成失败：${err}（**这一条没有产出**，不是"产出了空的"）`)
  else console.log(`   改写：${out}`)
  console.log('')
}

console.log('══════════════════════════════════════════════════════════')
console.log('【你现在要判的事】逐条看「原文 vs 改写」——')
console.log('  · 改写有没有**加了原文没有的东西**？（幻觉）')
console.log('  · 专有名词有没有被改动？（改了就不能当"与设定一致"）')
console.log('  · 口吻像不像 AI 说话？（不像就说明没起到"同文体"的作用）')
console.log('')
console.log('⚠️ 本工具**没有写任何数据**。要入库得先过你这关，再走 `samples.js` 的标准路径。')
console.log('══════════════════════════════════════════════════════════')
