/**
 * harvest-weak.mjs — CLI：从历史会话挖弱标注样本
 *
 * ⚠️ 核心逻辑全在 `lib/harvest.js`（本脚本只是外壳）。
 *    这样 `lib/bootstrap.js`（首次自动引导）能复用同一份提取逻辑，
 *    **不会出现"CLI 与插件行为不一致"这种最难查的 bug。**
 *
 * ══ 防病毒（作者 2026-10-15 提醒「注意病毒」）═══════════════════════
 *   "病毒" = 错样本 → 训出差模型 → 差模型产生错判断 → 又变新样本 → 自我强化。
 *   ⇒ 本工具四道闸：
 *     ① **默认 dry-run**，要写必须显式 `--write`
 *     ② **独立 task**（`doc_route_weak`）—— 与人工纠正 `user_correction` 天然隔离
 *     ③ **带 `confidence = 1/N`**（N = 该轮读了几份档）⇒ 下游能筛
 *     ④ **带 `session + pos`** ⇒ 任何一条可回原文核对
 *   ⚠️ 且本工具**只写样本**（append-only 日志），**绝不碰知识库/待审记** ——
 *      「提炼可以自动，生效必须经审」。
 *
 * ══ 用法 ═════════════════════════════════════════════════════════
 *   node tools/harvest-weak.mjs --project D:/你的项目           # 预览
 *   node tools/harvest-weak.mjs --project ... --write                        # 真写
 *   node tools/harvest-weak.mjs --project ... --min-conf 0.5                 # 只要高置信度
 */

import { findSessionDirs, harvestSession } from '../lib/harvest.js'

const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }

const PROJECT = get('--project')
const WRITE = has('--write')
const LIMIT = Number(get('--limit', 0)) || 0
const MAX_PER_TURN = Number(get('--max-per-turn', 3))
const MIN_TEXT = Number(get('--min-text', 12))
const MAX_TEXT = Number(get('--max-text', 1000))
const MIN_CONF = Number(get('--min-conf', 0))
const SHOW = Number(get('--show', 8))

if (!PROJECT) {
  console.error('用法：node tools/harvest-weak.mjs --project <项目根> [--write] [--limit N] [--min-conf 0.5]')
  process.exit(1)
}

const dirs = findSessionDirs(PROJECT)
console.log('='.repeat(72))
console.log(`  会话挖掘：${PROJECT}`)
console.log('='.repeat(72))
console.log(`  找到该项目的会话：${dirs.length} 个（总 ${(dirs.reduce((a, x) => a + x.size, 0) / 1048576).toFixed(1)} MB）`)
console.log(`  模式：${WRITE ? '★ 真写（--write）' : '预览（dry-run，不写任何东西）'}　每轮最多取 ${MAX_PER_TURN} 个档`)
console.log()

const use = LIMIT ? dirs.slice(0, LIMIT) : dirs
const samples = []
const perDoc = new Map()
const tot = { segments: 0, nonHuman: 0, tooShort: 0, tooLong: 0, lowConf: 0, withDoc: 0 }

for (const s of use) {
  const { samples: sm, stats } = harvestSession(s.file, {
    maxPerTurn: MAX_PER_TURN, minText: MIN_TEXT, maxText: MAX_TEXT, minConf: MIN_CONF,
  })
  for (const k of Object.keys(tot)) tot[k] += stats[k]
  for (const x of sm) {
    samples.push(x)
    perDoc.set(x.label, (perDoc.get(x.label) || 0) + 1)
  }
}

console.log('── 统计 ──')
console.log(`  作者发言段总数          : ${tot.segments}`)
console.log(`  其中【同轮读过设定档】的 : ${tot.withDoc}（${(tot.withDoc / Math.max(tot.segments, 1) * 100).toFixed(1)}%）`)
console.log(`  剔除非人发言(系统通知等)  : ${tot.nonHuman}`)
console.log(`  因过短(<${MIN_TEXT}字)丢弃     : ${tot.tooShort}`)
console.log(`  因过长(>${MAX_TEXT}字)丢弃     : ${tot.tooLong}`)
console.log(`  因置信度低于 ${MIN_CONF} 丢弃   : ${tot.lowConf}`)
console.log(`  ★ 可采样本              : ${samples.length} 条（去重前）`)
console.log(`  覆盖到设定档            : ${perDoc.size} 份`)
console.log()
const dist = {}
for (const x of samples) dist[x.confidence] = (dist[x.confidence] || 0) + 1
console.log('  置信度分布（1/N，N=该轮读过的档数）:')
for (const [c, n] of Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`     conf=${c}  → ${n} 条`)
}

console.log()
console.log('── 抽样（供人核对：标签对不对）──')
for (const x of samples.slice(0, SHOW)) {
  console.log(`  [conf=${x.confidence}] 档=「${x.label}」`)
  console.log(`     发言: ${x.input.slice(0, 70).replace(/\n/g, ' ')}…`)
  console.log(`     出处: ${String(x.ref.session).slice(0, 18)}… pos=${x.ref.pos} 该轮共读 ${x.ref.docCount} 档`)
}

if (!WRITE) {
  console.log()
  console.log('（dry-run：未写任何东西。确认真实无误后加 --write）')
} else {
  const mod = await import('../lib/samples.js')
  let n = 0, dup = 0
  for (const x of samples) {
    const r = mod.recordPrediction({
      task: x.task, input: x.input, prediction: x.label, confidence: x.confidence,
      by: 'weak_session', ref: x.ref, extra: { labelSource: x.labelSource, docCount: x.ref.docCount },
    })
    r ? n++ : dup++
  }
  console.log()
  console.log(`★ 已写入 ${n} 条；因指纹重复跳过 ${dup} 条（幂等，重复跑不会灌重复）`)
  console.log(`  样本库现在：${JSON.stringify(mod.stats().dataset)}`)
}
