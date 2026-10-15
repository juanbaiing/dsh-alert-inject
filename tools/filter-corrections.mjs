/**
 * filter-corrections.mjs — (b) **筛掉「不是一次纠正」的样本**
 *
 * ══ 为什么（2026-10-16 实测）══════════════════════════════════════
 *   样本库里 182 条「纠正」，实测**约 25% 根本不是纠正**：
 *     「我叫 juanbaiing,不是 juanbaing」  ← 纠正**自己的笔误**
 *     「好，先试试，另外，你去搜一下…」    ← **下新指令**
 *     「是的，读取没有危险…然后我讲设想」  ← **继续往下讲**
 *
 *   根因在 `lib/learning.js:364` —— 它**用词表判意图**：
 *     `不是|不对|不该|不用|其实|错了|我理解错|应该先|没必要…`
 *   这些词在**非纠正**的话里同样常见（"不是"→纠正笔误；"不用""应该先"→新指令）。
 *   ⚠️ 作者自己已经为这条规则打过补丁（`(?<!是)不是` 排除"是不是"），
 *      但**打补丁治不了"用词表判意图"这个根**。
 *
 * ══ 它判什么（比"归类"简单一档）══════════════════════════════════
 *   只问一句：**这段话的矛头，指向「AI 做了什么 / 理解成什么」吗？**
 *     · 指向 AI 的产出 ⇒ **YES**（是一次纠正）
 *     · 指向事实 / 下一步 / 自己 ⇒ **NO**（不是纠正）
 *   ⇒ 只有两个答案 —— 比 10 分类简单得多，**小模型大概率够用**。
 *
 * ══ 纪律 ═══════════════════════════════════════════════════════
 *   ① **只读**：不写样本库、不改 learning.js。
 *   ② 同时打印**旧规则**（词表）的判断，便于看"模型多滤掉了什么"。
 *   ③ 抽样给你判 —— **它判得对不对，由你说了算，不是我说了算**。
 *
 * 用法：
 *   node tools/filter-corrections.mjs                    # 默认 20 条
 *   node tools/filter-corrections.mjs --n 40 --model qwen2.5:3b
 */

import { loadSamples } from '../lib/samples.js'

const argv = process.argv.slice(2)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }
const N = +(get('--n', 20))
const MODEL = get('--model', 'qwen2.5:3b')
const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434'

/** ⚠️ 与 `lib/learning.js:364` **完全一致** —— 用来对比"旧规则"的判断 */
const CORRECT_SIG = /(?<!是)不是|不对|不该|别这样|不用|其实|错了|搞错|我的意思是|你理解错|应该先|不至于|没必要/

const PROMPT = (t) =>
  '下面这句话，是【使用者在对 AI 的产出表达不满或纠正】吗？\n\n' +
  '判断标准 —— 看这句话的**矛头指向谁**：\n' +
  '· 指向「**AI 做了什么 / 把话理解成了什么**」⇒ 是（例如「你找错了」「不是这样的」「你理解偏了」）\n' +
  '· 指向**事实本身 / 下一步要做什么 / 使用者自己**⇒ 不是\n' +
  '  （例如：补充一个事实、下一条新指令、接着往下讲、纠正自己的笔误）\n\n' +
  '只输出一个词：YES 或 NO。不要解释。\n\n' +
  '句子：' + String(t).slice(0, 500)

const evs = loadSamples().filter((e) => e.kind === 'corr' && e.right)
console.log('══════════════════════════════════════════════════════════')
console.log('  (b) 筛掉「不是一次纠正」的样本')
console.log('══════════════════════════════════════════════════════════')
console.log(`样本库里的「纠正」：${evs.length} 条　本次判：前 ${Math.min(N, evs.length)} 条`)
console.log(`模型：${MODEL}`)

try {
  const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(6000) })
  if (!r.ok) throw new Error('HTTP ' + r.status)
} catch (e) {
  console.log('')
  console.log(`⚠️ 连不上本机模型（${OLLAMA}）⇒ **这一步做不了**（不静默退化成正则瞎猜）。`)
  process.exit(1)
}

const pick = evs.slice(0, Math.min(N, evs.length))
const rows = []
for (let i = 0; i < pick.length; i++) {
  const e = pick[i]
  let raw = '', err = null
  try {
    const r = await fetch(OLLAMA + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: PROMPT(e.right), stream: false, options: { temperature: 0 } }),
      signal: AbortSignal.timeout(60000),
    })
    if (!r.ok) err = 'HTTP ' + r.status
    else raw = String((await r.json()).response || '').trim()
  } catch (ex) { err = ex?.message || String(ex) }
  const m = raw.toUpperCase().match(/\b(YES|NO)\b/)
  rows.push({ right: e.right, model: m ? m[1] : null, raw, err, legacy: CORRECT_SIG.test(String(e.right)) })
  process.stdout.write(`\r  已判 ${i + 1}/${pick.length}   `)
}
console.log('\n')

const yes = rows.filter((r) => r.model === 'YES').length
const no = rows.filter((r) => r.model === 'NO').length
const bad = rows.filter((r) => !r.model).length
// 旧规则一定判"是"（因为样本就是这么收进来的）；所以"模型说 NO"＝模型认为旧规则收错了
const legacyYes = rows.filter((r) => r.legacy).length

console.log('── 结果 ──')
console.log(`  模型说 YES（是纠正）      ${String(yes).padStart(3)} 条`)
console.log(`  模型说 NO （**不是纠正**） ${String(no).padStart(3)} 条　← 这批就是疑似杂质`)
if (bad) console.log(`  ⚠️ 模型没按格式输出        ${String(bad).padStart(3)} 条　← **如实报，不静默当 NO**`)
console.log(`  （对照：旧词表规则对这批全部判 YES ${legacyYes}/${rows.length} —— 因为样本就是这么收进来的）`)
console.log('')
console.log(`  ⇒ **模型认为旧规则收错了 ${no} 条（${((no / rows.length) * 100).toFixed(0)}%）**`)

console.log('')
console.log('── 抽样：模型判「**NO**」的那批（请你判它对不对 —— 这些就是它要从样本库里剔掉的）──')
const noRows = rows.filter((r) => r.model === 'NO').slice(0, 6)
if (!noRows.length) console.log('  （没有判 NO 的）')
for (const r of noRows) console.log(`  · 「${String(r.right).slice(0, 78).replace(/\n/g, ' ')}」`)

console.log('')
console.log('── 抽样：模型判「**YES**」的那批（请你判它对不对 —— 这些是它认为该留的）──')
for (const r of rows.filter((x) => x.model === 'YES').slice(0, 5)) {
  console.log(`  · 「${String(r.right).slice(0, 78).replace(/\n/g, ' ')}」`)
}

console.log('')
console.log('══════════════════════════════════════════════════════════')
console.log('【你要判的事】上面两组，**模型判得对不对** —— 用你自己的眼睛，不看我的说法。')
console.log('  · 若「NO」那组确实都不是纠正 ⇒ 这一步有用，可以拿去修 `learning.js` 的抽取')
console.log('  · 若「NO」那组里有真纠正被误杀 ⇒ **这一步会删好数据**，必须先调它（宁可漏、不可误杀）')
console.log('⚠️ 本工具**没有写任何数据**。')
console.log('══════════════════════════════════════════════════════════')
