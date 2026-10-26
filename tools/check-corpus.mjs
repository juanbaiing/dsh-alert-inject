/**
 * check-corpus.mjs — 语料体检（无监督 + 规则重判）**只读，不写任何数据**
 *
 * 为什么要它（2026-10-26）：
 *   作者说「这个语料已经测试过一遍了，看起来是有些问题——缺什么，还有一些识别不出来」。
 *   而「语料好不好」此前**没有任何可复现的度量** —— 那正是本项目 `AGENTS.md` §六 说的
 *   「用来做判断的东西，它自己也要被检查」。
 *
 * 三件事，全部**不需要人工标注**：
 *   ① **规则重判**：拿当前判据把历史 corr 重过一遍，看多少会被拒（= 历史污染率）
 *   ② **形态检查**：看 wrong 侧（AI 输入）与 right 侧（用户标签）是否「同源」
 *      ⚠️ 若输入是长表格/带 emoji、标签是短人话 ⇒ 模型学到的是**文体**，不是错因
 *   ③ **无监督离群**：TF-IDF 相似度，找「与其余语料都不像」的条目 ⇒ 误收的最可能候选
 *
 * 用法：
 *   node tools/check-corpus.mjs                 # 默认读 ~/.dsh/learning-samples.jsonl
 *   node tools/check-corpus.mjs --file <路径>
 *   node tools/check-corpus.mjs --outliers 8    # 看更多离群点
 *
 * ⚠️ 退出码：读不动 ⇒ 1；能读 ⇒ 0（即使结果不好，也不该让脚本"失败"——它只是体检）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }
const file = get('--file') || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'learning-samples.jsonl')
const outlierN = +(get('--outliers', 8))

/**
 * ⚠️ 下面三条正则**必须与 `lib/learning.js` 保持一致**（那是运行时判据，这里是体检用的副本）。
 *   不一致的后果：体检说"会拒掉 20 条"，运行时却拒 30 条 —— 又一处"描述与真相不符"。
 *   改 learning.js 时请同步这里；`tools/check-corpus.mjs` 的判据是「两边同时改」。
 */
const CORRECT_SIG = /(?<!是)不是|不对|不该|别这样|不用|其实|错了|搞错|我的意思是|你理解错|应该先|不至于|没必要/
const TASK_INSTR = /^(你是|请你|帮我|请帮|需要你|调研|返回|输出格式|严禁|不要修改)/
const NOT_CORRECTION = new RegExp([
  '另外[，,].{0,12}(去|帮|搜|看|写|改|试|加)',
  '(不用了|不用找|先不急|回头再)',
  '(我想到了|我想到一个|还有个功能|还有一个)',
  '(我搞错|我记错|拼错|我打错)',
].join('|'))
const IS_QUESTION = /[？?]\s*$|\?{2,}/

if (!fs.existsSync(file)) {
  console.error(`❌ 读不到样本文件：${file}`)
  console.error('   ⇒ 这不是"语料是空的"，是"我没找到它"。先跑一次 alert_check 让样本落盘。')
  process.exit(1)
}

let evs = []
let bad = 0
for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!l.trim()) continue
  try { const o = JSON.parse(l); if (o && typeof o === 'object') evs.push(o); else bad++ } catch { bad++ }
}
const corr = evs.filter((e) => e.kind === 'corr')
const pred = evs.filter((e) => e.kind === 'pred')
const label = evs.filter((e) => e.kind === 'label')

console.log('📄 ' + file)
console.log(`   共 ${evs.length} 条事件｜坏行 ${bad}` + (bad ? '（**不是 0 —— 有行读不动**）' : '') + '\n')

// ── ① 规则重判 ──────────────────────────────────────────────────
const reasons = {}
for (const c of corr) {
  const t = String(c.right || '').trim()
  let r = null
  if (TASK_INSTR.test(t)) r = '任务指令'
  else if (!CORRECT_SIG.test(t)) r = '无纠正信号'
  else if (NOT_CORRECTION.test(t)) r = '排除项命中（补充要求/自纠）'
  else if (IS_QUESTION.test(t)) r = '疑问句'
  if (r) reasons[r] = (reasons[r] || 0) + 1
}
const dropped = Object.values(reasons).reduce((a, b) => a + b, 0)
console.log('【① 规则重判（right 侧）】')
if (!corr.length) console.log('   ⚠️ 一条纠正样本都没有 —— **这不是"没有污染"，是"还没收过"**')
else {
  for (const [k, v] of Object.entries(reasons)) console.log(`   ${k}: ${v}`)
  console.log(`   会拒 ${dropped} / ${corr.length} = **${(dropped / corr.length * 100).toFixed(0)}%**（历史污染）`)
}

// ── ② 形态检查（输入 vs 标签 是不是同源）────────────────────────
const wLen = corr.map((c) => String(c.wrong || '').length)
const rLen = corr.map((c) => String(c.right || '').length)
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0 }
const hasTable = (s) => /\|.*\|/.test(String(s || ''))
const hasEmoji = (s) => /[✅⚠️🔍📚🧩⚓🎯]/.test(String(s || ''))
console.log('\n【② 形态（输入 vs 标签 是不是同源）】')
console.log(`   wrong（AI 侧）中位长度 ${med(wLen)} 字；≥900字 ${wLen.filter((x) => x >= 900).length} 条；含表格 ${corr.filter((c) => hasTable(c.wrong)).length}；含 emoji ${corr.filter((c) => hasEmoji(c.wrong)).length}`)
console.log(`   right（用户侧）中位长度 ${med(rLen)} 字；含表格 ${corr.filter((c) => hasTable(c.right)).length}；含 emoji ${corr.filter((c) => hasEmoji(c.right)).length}`)
if (corr.length && med(wLen) > med(rLen) * 5) {
  console.log('   ⚠️ 两侧长度差 5 倍以上 ⇒ **模型最容易学的是「长 vs 短」这个文体特征，不是「对 vs 错」**')
}

// ── ③ 无监督离群（TF-IDF 2-gram）────────────────────────────────
function grams(s) {
  const m = new Map(); const t = String(s || '').replace(/\s+/g, '')
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1) }
  return m
}
const docs = corr.map((c) => grams(c.right))
const N = docs.length
const dfm = new Map()
for (const g of docs) for (const k of g.keys()) dfm.set(k, (dfm.get(k) || 0) + 1)
const vecs = docs.map((g) => {
  const v = new Map(); let n = 0
  for (const [k, c] of g) { const w = (1 + Math.log(c)) * Math.log((N + 1) / ((dfm.get(k) || 0) + 1)); v.set(k, w); n += w * w }
  n = Math.sqrt(n) || 1
  for (const k of v.keys()) v.set(k, v.get(k) / n)
  return v
})
const cos = (a, b) => { let s = 0; for (const [k, x] of a) { const y = b.get(k); if (y) s += x * y } return s }
const centrality = vecs.map((v, i) => {
  let s = 0; for (let j = 0; j < N; j++) if (i !== j) s += cos(v, vecs[j])
  return N > 1 ? s / (N - 1) : 0
})
console.log('\n【③ 无监督离群（与其余语料的平均相似度）】')
if (N < 3) console.log('   样本太少（<3 条），这项不下结论')
else {
  const idx = centrality.map((c, i) => i).sort((a, b) => centrality[a] - centrality[b])
  const avg = centrality.reduce((a, b) => a + b, 0) / N
  console.log(`   平均中心度 ${avg.toFixed(3)}${avg < 0.03 ? ' ⇒ 语料**几乎均匀散开**，没有天然的两类结构（聚类出标签这条路走不通）' : ''}`)
  console.log(`   最离群 ${Math.min(outlierN, N)} 条（**误收最可能在这里**）：`)
  for (const i of idx.slice(0, Math.min(outlierN, N))) console.log(`     ${centrality[i].toFixed(3)}  ${String(corr[i].right).slice(0, 52)}`)
}

// ── ④ 重复（同一句话被记多次）────────────────────────────────────
const byText = new Map()
for (const c of corr) { const k = String(c.right || ''); if (!byText.has(k)) byText.set(k, []); byText.get(k).push(c) }
const dups = [...byText.values()].filter((v) => v.length > 1)
const samePos = dups.filter((v) => new Set(v.map((c) => c.ref?.pos)).size === 1).length
console.log('\n【④ 重复】')
console.log(`   重复组 ${dups.length}（涉及 ${dups.reduce((a, v) => a + v.length, 0)} 条）｜同 pos 重复 ${samePos} 组｜不同 pos ${dups.length - samePos} 组`)
if (dups.length) {
  const eg = dups[0]
  console.log(`   例：${String(eg[0].right).slice(0, 40)}…`)
  console.log(`     pos=${eg.map((c) => c.ref?.pos).join(' / ')}（h=${eg.map((c) => c.h).join(' / ')}）`)
  console.log('   ⚠️ 同 pos 但 h 不同 ⇒ 同一条用户发言被配了**不同的 AI 上下文**又落了一次库（`extractCorrections` 的 pos/配对基于取样后的子集，不稳定）')
}

// ── ⑤ 标签侧 ────────────────────────────────────────────────────
console.log('\n【⑤ 标签与判断样本】')
console.log(`   pred ${pred.length} 条（已标注 ${pred.filter((p) => p.label != null).length}）｜label 事件 ${label.length} 条`)
if (pred.length && !label.length) console.log('   ⚠️ 一条补标事件都没有 ⇒ 二元任务**只有正类**，训练器读不了（`readiness()` 会如实报 false）')
console.log('\n（本工具只读；它不改数据，也不要求你标注 —— 它只报告「现在这批料能用来做什么」。）')
