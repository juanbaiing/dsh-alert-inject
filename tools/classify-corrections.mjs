/**
 * classify-corrections.mjs — 用**本机模型**把「使用者对 AI 的每一次纠正」归到某一类
 *
 * ══ 为什么是这样（作者 2026-10-16 定）════════════════════════════
 *   > 「我们是不是可以不要数据，而是**只要识别出那个是哪种错误**即可，
 *   >    **训练交给安装者电脑自动训练**」
 *   ⇒ **出厂带分类表**（`lib/defaults/error-taxonomy.json`），**数据在使用者本机长**。
 *   ⇒ 本工具就是那条链路的**第一段**：把纠正**归类**，为"每类攒够 8 条就训"做准备。
 *
 * ══ ✅ 判据（**先写在这里，再看数据** —— 免得事后找理由）════════
 *   ① **覆盖率**：能被归到某一类的比例。**低于 80% ⇒ 分类表不合用**（有大量落不进任何一类）
 *   ② **集中度**：最大一类占比。**超过 70% ⇒ 分类太粗**（等于只有一类，不如不分类）
 *      反向：**没有任何一类 ≥ 8 条 ⇒ 分类太细**（攒不出门槛）
 *   ③ **分类失败率**：模型没按格式输出、或输出不在表内的比例 —— **必须如实报，不许静默归成"其他"**
 *
 * ⚠️ 分类是**模型判的，不是真值** ⇒ 输出会带原文，供你**自己判它归得对不对**。
 *
 * 用法：
 *   node tools/classify-corrections.mjs                    # 默认 20 条
 *   node tools/classify-corrections.mjs --n 60 --model qwen3:4b
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSamples } from '../lib/samples.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }

const N = +(get('--n', 20))
const MODEL = get('--model', 'qwen2.5:3b')
const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434'
const TAX = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'defaults', 'error-taxonomy.json'), 'utf8'))

// ── 把分类表摊平成 prompt 用的清单 ──
const MODES = []
for (const d of TAX.domains) {
  for (const m of d.modes) MODES.push({ code: d.code + '-' + m.code, name: m.name, desc: m.desc, domain: d.name, question: d.question })
}
const VALID = new Set(MODES.map((m) => m.code))

const menu = MODES.map((m) => `- ${m.code}  ${m.name}：${m.desc}`).join('\n')

const PROMPT = (right, wrong) =>
  '你是分类器。下面是一条【使用者对 AI 的纠正】。把它归到**恰好一个**类别。\n\n' +
  '类别表（只能选其中之一）：\n' + menu + '\n\n' +
  '判断要点：\n' +
  '· 若「他其实要的是别的/我理解偏了/找错了对象」⇒ 优先 PRG-MIS\n' +
  '· 若「该有的没有」⇒ STR-OMI；若「说了没被要的」⇒ STR-EXC\n' +
  '· 若「话是对的但场合不对（语气/详略）」⇒ PRG-FIT\n\n' +
  '⚠️⚠️ **如果这段话根本不是在纠正 AI 的错误**（例如：只是补充信息、下新指令、\n' +
  '   继续往下讲、纠正自己的笔误），**必须输出 OTHER** —— 不要硬塞进上面某一类。\n' +
  '   硬塞会让统计失真。\n\n' +
  '使用者的话：' + String(right).slice(0, 400) + '\n\n' +
  'AI 当时说的（供参考，可截断）：' + String(wrong || '').slice(0, 300) + '\n\n' +
  '只输出类别码本身（例如 PRG-MIS 或 OTHER），**不要任何解释、不要标点**。'

// ── 拿数据 ──
const evs = loadSamples().filter((e) => e.kind === 'corr' && e.wrong && e.right)
console.log('══════════════════════════════════════════════════════════')
console.log('  把「你对 AI 的纠正」归类 —— 用本机模型')
console.log('══════════════════════════════════════════════════════════')
console.log(`分类表：${MODES.length} 个模式 ／ 纠正样本：${evs.length} 条`)

try {
  const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(6000) })
  if (!r.ok) throw new Error('HTTP ' + r.status)
} catch (e) {
  console.log('')
  console.log(`⚠️ 连不上本机模型（${OLLAMA}）⇒ **这一步做不了**（不静默退化成正则瞎猜）。`)
  console.log('   错误：' + (e?.message || e))
  process.exit(1)
}

const pick = evs.slice(0, N)
console.log(`本机模型：${MODEL}    本次分类：前 ${pick.length} 条`)
console.log('')

const rows = []
for (let i = 0; i < pick.length; i++) {
  const e = pick[i]
  let raw = '', err = null
  try {
    const r = await fetch(OLLAMA + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: PROMPT(e.right, e.wrong), stream: false, options: { temperature: 0 } }),
      signal: AbortSignal.timeout(90000),
    })
    if (!r.ok) err = 'HTTP ' + r.status
    else raw = String((await r.json()).response || '').trim()
  } catch (ex) { err = ex?.message || String(ex) }

  const m = raw.match(/\b(OTHER|(STR|SEM|PRG|EPI)-(OMI|EXC|MAL|INC|PRT|AMB|MIS|FIT|OVR|UNG))\b/)
  const code = m ? m[0] : null
  rows.push({ i, right: e.right, wrong: e.wrong, code, raw, err, ok: !!(code && (code === 'OTHER' || VALID.has(code))) })
  process.stdout.write(`\r  已分类 ${i + 1}/${pick.length}   `)
}
console.log('\n')

// ── 汇总（按先写下的三条判据）──
const counts = new Map()
let fail = 0
let other = 0
for (const r of rows) {
  if (!r.ok) { fail++; continue }
  if (r.code === 'OTHER') { other++; continue }
  counts.set(r.code, (counts.get(r.code) || 0) + 1)
}
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
const classified = rows.length - other - fail
const coverRate = classified / rows.length
const otherRate = other / rows.length
const topRate = sorted.length ? sorted[0][1] / rows.length : 0
const enough = sorted.filter(([, n]) => n >= 8).length

console.log('── 分类分布 ──')
for (const [code, n] of sorted) {
  const md = MODES.find((x) => x.code === code)
  console.log(`  ${code.padEnd(9)} ${String(md?.name || '?').padEnd(14)} ${String(n).padStart(3)} 条`)
}
if (other) console.log(`  ${'OTHER'.padEnd(9)} ${'不是一次纠正'.padEnd(14)} ${String(other).padStart(3)} 条　← 下新指令／继续对话／补充信息／纠正笔误`)
if (fail) console.log(`  ⚠️ 分类失败（模型没按要求输出 / 输出不在表内）  ${fail} 条　← **如实报告，没有静默归成"其他"**`)

console.log('')
console.log('── ✅ 按判据核对（**判据在跑之前就写在文件头**）──')
console.log(`  ① 真覆盖率 ＝ ${(coverRate * 100).toFixed(0)}%（＝归到某个真类 ／ 全部）　判据 ≤80% 即不合用 ⇒ ${coverRate >= 0.8 ? '✅ 过' : '❌ 不过'}`)
console.log(`  ② **OTHER 比例 ＝ ${(otherRate * 100).toFixed(0)}%**　← 这批样本里**不是纠正**的占比。`)
console.log(`     ⚠️ 它偏高说明【样本不纯】，不一定是分类表的错 —— 两种可能必须分开看：`)
console.log(`        · 分类表不合用（该归的归不进）／`)
console.log(`        · 采集把"不是纠正的话"也收进来了（**那是 learning.js 的抽取问题**）`)
console.log(`  ③ 集中度 ＝ 最大一类占 ${(topRate * 100).toFixed(0)}%（判据 >70% 即太粗）⇒ ${topRate <= 0.7 ? '✅ 过' : '❌ 不过（等于只有一类）'}`)
console.log(`  ④ 够门槛的类 ＝ ${enough} 个（每类 ≥8 条）⇒ ${enough >= 1 ? '✅ 至少一类可试训' : '⚠️ 本次不够'}`)

// ── 抽样：给人判 ──
console.log('')
console.log('── 抽样 6 条（**请你自己判它归得对不对** —— 这是模型判的，不是真值）──')
const step = Math.max(1, Math.floor(rows.length / 6))
for (let i = 0; i < rows.length && i / step < 6; i += step) {
  const r = rows[i]
  console.log(`  [${r.ok ? r.code : '分类失败'}] 你说：「${String(r.right).slice(0, 74).replace(/\n/g, ' ')}」`)
  if (!r.ok) console.log(`        模型原始输出：${String(r.raw).slice(0, 60) || '（空）'}${r.err ? '  错误：' + r.err : ''}`)
}

console.log('')
console.log('══════════════════════════════════════════════════════════')
console.log('⚠️ 本工具**没有写任何数据**：只读样本库、只打印结果。')
console.log('   下一步（未做）：把归类结果存下来 → 每类攒够 8 条 → 在**本机**训判据 → 回接哨兵。')
console.log('══════════════════════════════════════════════════════════')
