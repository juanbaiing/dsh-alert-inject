/**
 * check-label-quality.mjs —— 用**真实会话**测「打标签」的质量
 *
 * ══ 为什么必须这样测（上一版测法的问题）════════════════════════════
 *   上一版直接拿 `corr` 事件当测试集 —— 而那些样本**本来就是用正则判成"纠错"才采进来的**
 *   ⇒ 等于拿"答案已知是纠错"的题去考模型，**全对或全错都不说明问题**（实测：两个后端
 *   一个判 3/4 纠错、一个全判陈述，看着像分歧，其实是我采样有偏）。
 *
 * ══ 本测试的做法 ═══════════════════════════════════════════════════
 *   取**同一个会话里作者说的每一句**（`kind === '用户'`），对每句同时跑两把尺：
 *     · **正则**（`CORRECT_SIG` + `NOT_CORRECTION` + `IS_QUESTION`）—— 生产在用的那把
 *     · **模型**（可指定后端，默认 laya）
 *   ⇒ 比它们**在同一批真话上的分歧**。分歧的地方，才是需要人判的地方。
 *
 * ══ 判据（先写下，再看数据）════════════════════════════════════════
 *   ① **一致率**：两把尺判定相同的比例。**>90% ⇒ 模型只是重复正则**（没带来新信息）
 *   ② **严重分歧率**：正则判"是纠错"而模型判"陈述/指令"（或反之）的比例。
 *      **这批就是"正则误收"或"模型漏判"的候选** —— 必须逐条看原文
 *   ③ **模型不确定率**（置信度 < 阈值）：**如实报**，它是人工复核清单
 *
 * ⚠️ 只读，不写任何库。
 * 用法：`node tools/check-label-quality.mjs [--n 30] [--backends laya:multilingual,ollama:qwen2.5:3b]`
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }
const N = +(get('--n', 24))
const BACKENDS = String(get('--backends', 'laya:multilingual')).split(',').map((s) => s.trim()).filter(Boolean)

const LIB = new URL('../lib/', import.meta.url).href
const { classifyWithConsensus, MIN_CONFIDENCE } = await import(LIB + 'classifier.js')
const { recentActivity, latestSessionFile } = await import(LIB + 'index.js')

// ── 与生产**同一把尺**（照抄自 learning.js，含它自己的坑：`不是` 会匹配 `是不是`）──
const CORRECT_SIG = /(?<!是)不是|不对|不该|别这样|不用|其实|错了|搞错|我的意思是|你理解错|应该先|不至于|没必要/
const NOT_CORRECTION = /^\s*(你是|请你|帮我|请帮|需要你|调研|返回|输出格式|严禁|不要修改)/
const IS_QUESTION = /[？?]\s*$|\?{2,}/
const regexYes = (t) => CORRECT_SIG.test(t) && !NOT_CORRECTION.test(t) && !IS_QUESTION.test(t)

// ── 取真实会话里的作者发言 ──
const roots = []
const walk = (d, depth = 0) => {
  if (depth > 8) return
  let es = []
  try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of es) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, depth + 1)
    else if (e.name === 'session.jsonl.zstd') roots.push(p)
  }
}
walk(path.join(os.homedir(), '.dsh', 'sessions'))
roots.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs } catch { return 0 } })

console.log('═'.repeat(68))
console.log('  打标签质量实测 —— 正则（生产在用） vs 模型')
console.log('═'.repeat(68))
console.log(`后端: ${BACKENDS.join(' , ')}`)

// 从最新若干个会话里收集作者发言（去重、够长才算）
const seen = new Set()
const utts = []
for (const f of roots.slice(0, 8)) {
  let acts = []
  try { acts = recentActivity(f, 0) } catch { continue }
  for (const a of acts) {
    if (a.kind !== '用户') continue
    const t = String(a.text || '').trim()
    if (t.length < 6 || t.length > 300) continue
    if (t.startsWith('<') || t.includes('system-reminder')) continue     // 平台注入物
    if (seen.has(t)) continue
    seen.add(t)
    utts.push({ t, session: path.basename(path.dirname(f)) })
  }
}
console.log(`扫了 ${Math.min(8, roots.length)} 个最新会话，作者发言去重后 ${utts.length} 条`)

// 取最近 N 条（最近的更像"现在怎么说话"）
const pick = utts.slice(-N)
if (!pick.length) { console.log('⚠️ 没取到发言'); process.exit(1) }
const nYes = pick.filter((x) => regexYes(x.t)).length
console.log(`本次测 ${pick.length} 条；其中**正则判为纠错**的 ${nYes} 条（用它当"正例"的近似真值）`)
console.log('')

// ── 逐条跑模型 ──
const rows = []
let t0 = Date.now()
for (let i = 0; i < pick.length; i++) {
  const it = pick[i]
  const r = await classifyWithConsensus(it.t, BACKENDS, { timeoutMs: 180000 })
  rows.push({ ...it, re: regexYes(it.t), r })
  process.stdout.write(`\r  跑 ${i + 1}/${pick.length}   `)
}
const totalMs = Date.now() - t0
console.log('')
console.log('')

// ── 混淆：正则 × 模型（模型多方判定，不一致时用 null）──
const modelYes = (r) => r.label === '纠错'
const modelNull = (r) => !r.label
const both = rows.filter((x) => x.re && modelYes(x.r)).length
const reOnly = rows.filter((x) => x.re && !modelYes(x.r) && !modelNull(x.r)).length
const modelOnly = rows.filter((x) => !x.re && modelYes(x.r)).length
const neither = rows.filter((x) => !x.re && !modelYes(x.r) && !modelNull(x.r)).length
const undecided = rows.filter((x) => modelNull(x.r)).length

console.log('── 交叉表（行=正则，列=模型）──')
console.log('                        模型=纠错   模型=别的   模型不判')
console.log(`  正则=纠错              ${String(both).padStart(6)}   ${String(reOnly).padStart(8)}   ${String(rows.filter((x) => x.re && modelNull(x.r)).length).padStart(8)}`)
console.log(`  正则=别的              ${String(modelOnly).padStart(6)}   ${String(neither).padStart(8)}   ${String(rows.filter((x) => !x.re && modelNull(x.r)).length).padStart(8)}`)
console.log('')

// ── 分歧明细（**这才是要看的**）──
const diverge = rows.filter((x) => x.re !== modelYes(x.r) && !modelNull(x.r))
console.log(`── 分歧 ${diverge.length} 条（**逐条看原文，判断谁对**）──`)
for (const x of diverge.slice(0, 14)) {
  const dir = x.re ? '正则有/模型无' : '正则无/模型有'
  const m = x.r.votes.map((v) => `${v.model.replace(/^[^:]+:/, '')}=${v.label ?? '✗'}${v.confidence != null ? `(${v.confidence.toFixed(2)})` : ''}`).join(' ')
  console.log(`  [${dir}] ${m}`)
  console.log(`      「${x.t.slice(0, 56).replace(/\n/g, ' ')}」`)
}
console.log('')

const uncertain = rows.filter((x) => x.r.uncertain).length
console.log('── ✅ 按判据核对 ──')
const agree = rows.length - diverge.length - undecided
const agreeRate = agree / rows.length
console.log(`  ① 一致率 ＝ ${(agreeRate * 100).toFixed(0)}%（${agree}/${rows.length}）　判据 >90% ⇒ **模型只是重复正则** ⇒ ${agreeRate > 0.9 ? '⚠️ 是（没带来新信息）' : '✅ 否（有分歧，带来了信息）'}`)
console.log(`  ② 严重分歧 ＝ ${diverge.length} 条（${(diverge.length / rows.length * 100).toFixed(0)}%）　← 这批需要人判`)
console.log(`  ③ 模型不判（多方不一致/低置信）＝ ${undecided} 条　不确定率 ${(uncertain / rows.length * 100).toFixed(0)}%（阈值 ${MIN_CONFIDENCE}）`)
console.log(`  平均耗时 ${(totalMs / rows.length).toFixed(0)} ms/条（${BACKENDS.length} 个后端）`)
console.log('')
console.log('⚠️ 本测试**不判谁对**：正则可能误收（作者记录过"20% 杂质"），模型也可能漏判。')
console.log('   它只给出一张"两把尺在哪里不一致"的清单，**对错要人看原文**。')
