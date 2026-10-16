/**
 * classify-labels.mjs — 给「你说过的话」打标签，写回样本库
 *
 * ══ 作者 2026-10-16 的定稿（逐条落地）═══════════════════════════════
 *   「给话打标签（也可以分类）**但不是实时的**（这个功能要留着，还要允许用户改模型），
 *     然后抓取数据的准确度和速度就快了不少，**还能互证**」
 *
 * ══ 用法 ═══════════════════════════════════════════════════════════
 *   node tools/classify-labels.mjs                          # 默认 laya 后端，前 20 条
 *   node tools/classify-labels.mjs --n 40
 *   node tools/classify-labels.mjs --backends laya:multilingual,ollama:qwen2.5:3b   # ★ 互证
 *   node tools/classify-labels.mjs --dry                       # 只看结果，不写盘
 *   node tools/classify-labels.mjs --backends ollama:qwen2.5:3b
 *
 * ══ 判据（**先写在这里，再看数据** —— 免得事后找理由）════════════════
 *   ① **可判率**：能给出标签的比例。**低于 80% ⇒ 这个后端在这一摊上不可用**
 *   ② **互证一致率**：两个以上后端给出同一标签的比例。**低于 70% ⇒ 分类定义太模糊**（要改的是判据，不是模型）
 *   ③ **不确定率**：`uncertain` 占比。它**不是错误** —— 它是"这些话需要人看一眼"的清单
 *      ⚠️ 但它**必须被报出来**：静默把低置信的也当确定，等于让噪声混进训练集（同 §242 筛选器误删）
 *
 * ⚠️ 写盘方式：**追加独立事件**（`kind: 'class'`），**不覆盖** `corr` 事件上的任何字段。
 *    那条 `label` 存的是**纠正原话**（`buildDataset` 当答案用）——
 *    覆盖它 = 把"答案"改成"分类名"，会静默毁掉训练集。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }
const has = (k) => argv.includes(k)

const N = +(get('--n', 20))
const DRY = has('--dry')
const BACKENDS = String(get('--backends', 'laya:multilingual')).split(',').map((s) => s.trim()).filter(Boolean)
const MIN_CONF = +(process.env.DSH_ALERT_CLASSIFY_MIN_CONF || 0.6)

// ⚠️⚠️ 必须在 import samples.js **之前**设好文件路径。
//    原因：`append()` 用的是模块加载时定下的 `SAMPLE_OPTS.file`（从 `SAMPLES_FILE` 读），
//    它**不接受 file 参数** ⇒ 若在 import 之后才改，写盘会落到**另一个文件**上
//    （"以为写到 A、其实写到 B" —— 正是本项目反复抓的那类静默错配）。
const FILE_ARG = get('--file', null)
if (FILE_ARG) process.env.SAMPLES_FILE = FILE_ARG

const { classifyWithConsensus, LABEL_NAMES, parseBackend } = await import('../lib/classifier.js')
const { loadSamples, append, SAMPLE_OPTS } = await import('../lib/samples.js')

const SAMPLE_FILE = SAMPLE_OPTS.file

console.log('═'.repeat(66))
console.log('  给「你说过的话」打标签 —— 可换模型 · 支持互证')
console.log('═'.repeat(66))

// ── 后端解析：**先验后跑**（不认识的早报错，别跑到一半才发现）──
console.log(`后端（${BACKENDS.length} 个）：`)
for (const b of BACKENDS) {
  const p = parseBackend(b)
  console.log(`   ${p.ok ? '✅' : '❌'} ${b}${p.ok ? `　（kind=${p.kind}）` : `　${p.why}`}`)
  if (!p.ok) { console.log('\n❌ 后端标识有误 ⇒ 停在这里（不静默退回默认后端）'); process.exit(1) }
}
if (BACKENDS.length < 2) console.log('   ⚠️ 只有 1 个后端 ⇒ **谈不上互证**（本跑只出单方判定）')

// ── 取数据：作者说过的「纠正原话」──
const all = loadSamples({ file: SAMPLE_FILE })
const corrs = all.filter((e) => e.kind === 'corr' && e.right)
// ⚠️ 已经打过标签的（同前缀 + 同后端组合）跳过 —— 幂等，重跑不会重复写
const done = new Set()
for (const e of all) {
  if (e.kind === 'class' && e.inputPrefix) done.add(e.inputPrefix + '|' + (e.by || ''))
}
const pick = []
for (const c of corrs) {
  const prefix = String(c.right).slice(0, 200)
  const key = prefix + '|' + BACKENDS.join(',')
  if (done.has(key)) continue
  pick.push({ text: c.right, prefix })
  if (pick.length >= N) break
}

console.log('')
console.log(`样本库：${SAMPLE_FILE}`)
console.log(`  纠正样本共 ${corrs.length} 条；本次要判 ${pick.length} 条（已判过的自动跳过）`)
console.log(`  判据：可判率 ≥80% · 互证一致率 ≥70% · 不确定率如实报`)
console.log('')

if (!pick.length) { console.log('⚠️ 没有需要判的（都判过了，或者样本库为空）'); process.exit(0) }

// ── 逐条判 ──
const rows = []
let t0 = Date.now()
for (let i = 0; i < pick.length; i++) {
  const it = pick[i]
  const r = await classifyWithConsensus(it.text, BACKENDS, { timeoutMs: 180000 })
  rows.push({ ...r, prefix: it.prefix })
  const mark = r.uncertain ? '⚠️' : '  '
  const lab = r.label || '（不判）'
  const conf = r.confidence === null ? '  -  ' : r.confidence.toFixed(2)
  process.stdout.write(`\r  ${String(i + 1).padStart(3)}/${pick.length}  ${mark} ${lab.padEnd(4)} ${conf}  ${r.agreement}          `)
}
const totalMs = Date.now() - t0
console.log('')
console.log('')

// ── 汇总（按先写下的三条判据）──
const n = rows.length
/**
 * ⚠️⚠️【判据本身要分清两件事】（2026-10-16 实测抓到的缺陷）
 *   第一版把"可判率"算成 `rows.filter(r => r.label).length / n` —— 而
 *   **互证不一致时 `label` 本来就是 `null`**（我们的设计：不替使用者选）⇒
 *   "两个后端都给出了标签、只是不一致" 被算成 "**模型给不出标签**" ⇒ 可判率 0%。
 *   ⇒ 那会让 **最有价值的那个数字（分歧率）伪装成"后端不可用"**，把人引向错误的排查方向。
 *   ⇒ 正确分法：
 *      · **可判率** ＝ 该句**至少有一个后端给出了标签**（衡量"模型判不判得动"）
 *      · **一致率 / 分歧率** ＝ 在**多方都判了**的那些句里，是否意见相同（衡量"分类定义清不清楚"）
 */
const withAnyLabel = rows.filter((r) => r.votes.some((v) => v.ok && v.label)).length
const multiJudged = rows.filter((r) => r.votes.filter((v) => v.ok && v.label).length >= 2)
const agree = multiJudged.filter((r) => r.agreement === '一致').length
const disagree = multiJudged.length - agree
const uncertain = rows.filter((r) => r.uncertain).length
const failed = rows.filter((r) => r.votes.every((v) => !v.ok)).length

// 每个后端各自的可判率（**用它判断"是哪个后端不行"**）
const perBackend = new Map()
for (const r of rows) {
  for (const v of r.votes) {
    const k = v.model
    if (!perBackend.has(k)) perBackend.set(k, { ok: 0, total: 0, ms: [] })
    const s = perBackend.get(k)
    s.total++
    if (v.ok && v.label) s.ok++
    if (v.ms) s.ms.push(v.ms)
  }
}

const byLabel = new Map()
for (const r of rows) if (r.label) byLabel.set(r.label, (byLabel.get(r.label) || 0) + 1)
const sorted = [...byLabel.entries()].sort((a, b) => b[1] - a[1])

console.log('')
console.log('── 逐条（互证的价值就在这里：**看分歧**）──')
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]
  const votes = r.votes.map((v) => `${v.model.replace(/^(ollama|laya):/, '')}=${v.label ?? '✗'}${v.confidence !== null && v.confidence !== undefined ? `(${v.confidence.toFixed(2)})` : ''}`).join('  ')
  const mark = r.uncertain ? '⚠️' : '  '
  console.log(`  ${mark}${String(i + 1).padStart(2)}. ${votes}`)
  console.log(`      「${String(r.text).slice(0, 52).replace(/\n/g, ' ')}」`)
  if (r.agreement === '不一致') console.log(`      ↑ ${r.why}`)
}
console.log('')

console.log('── 标签分布 ──')
for (const [lab, c] of sorted) console.log(`  ${lab.padEnd(6)} ${String(c).padStart(3)} 条`)
if (uncertain) console.log(`  ${'不确定'.padEnd(6)} ${String(uncertain).padStart(3)} 条　← **需要人看一眼**（不是错误，是清单）`)
if (failed) console.log(`  ${'失败'.padEnd(6)} ${String(failed).padStart(3)} 条　← 全部后端都出错`)

console.log('')
console.log('── 各后端单独看（**判断是哪个后端不行**）──')
for (const [model, s] of perBackend) {
  const ms = s.ms.length ? Math.round(s.ms.reduce((a, b) => a + b, 0) / s.ms.length) : 0
  console.log(`  ${model.padEnd(24)} 给出标签 ${s.ok}/${s.total}（${(s.ok / s.total * 100).toFixed(0)}%）　平均 ${ms} ms/条`)
}

console.log('')
console.log('── ✅ 按判据核对 ──')
const rate = n ? withAnyLabel / n : 0
console.log(`  ① 可判率 ＝ ${(rate * 100).toFixed(0)}%（至少一个后端给出标签）　判据 ≥80% ⇒ ${rate >= 0.8 ? '✅ 过' : '❌ 不过'}`)
if (BACKENDS.length >= 2) {
  const agreeRate = multiJudged.length ? agree / multiJudged.length : 0
  console.log(`  ② 互证（只在"多方都判了"的 ${multiJudged.length} 条里算）`)
  console.log(`     一致 ${agree} 条 / 分歧 ${disagree} 条 ⇒ 一致率 ${(agreeRate * 100).toFixed(0)}%　判据 ≥70% ⇒ ${agreeRate >= 0.7 ? '✅ 过' : '❌ 不过（**要改的是分类定义，不是模型**）'}`)
} else {
  console.log('  ② 互证 ＝ 测不了（只有 1 个后端）')
}
console.log(`  ③ 不确定率 ＝ ${(n ? uncertain / n * 100 : 0).toFixed(0)}%（${uncertain}/${n}）　**如实报告，不静默当确定**`)
if (failed) console.log(`  ⚠️ 全部后端都失败的 ${failed} 条 —— 那是网络/服务问题，不是模型判断问题`)
console.log(`  平均耗时 ＝ ${(totalMs / Math.max(n, 1)).toFixed(0)} ms/条（${BACKENDS.length} 个后端串行）`)

// ── 写盘 ──
if (DRY) {
  console.log('\n（--dry：没有写任何东西。去掉 --dry 才会写）')
} else {
  let added = 0
  for (const r of rows) {
    if (!r.votes.some((v) => v.ok)) continue              // 全失败的不写（不写一个编出来的标签）
    const ok = append({
      kind: 'class',
      task: 'user_correction',
      inputPrefix: r.prefix,
      label: r.label,                                     // ⚠️ 不一致时是 null —— 如实留空
      confidence: r.confidence,
      agreement: r.agreement,
      uncertain: r.uncertain,
      by: BACKENDS.join(','),
      models: r.votes.map((v) => `${v.model}=${v.label ?? '?'}`),
      why: r.why,
    })
    if (ok) added++
  }
  console.log(`\n✅ 已追加 ${added} 条 \`class\` 事件到 ${SAMPLE_FILE}`)
  console.log('   ⚠️ 用的是**追加新事件**：`corr` 上原有的 `wrong`/`right`/`label` 一个字段都没动。')
}

console.log('')
console.log('⚠️ 这些标签是**模型判的，不是真值** —— `uncertain` 那批就是"需要你判一眼"的清单。')
