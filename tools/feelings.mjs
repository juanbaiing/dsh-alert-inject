/**
 * feelings.mjs — CLI：「感觉表」的查看与录入
 *
 * 给**不看代码的人**用：跑一下，看它自己报告"我哪一路判断被否决过几次"。
 *
 * 用法：
 *   node tools/feelings.mjs                          # 看统计（每个 judge 的分母/裁决/否决率）
 *   node tools/feelings.mjs list [--limit 20]        # 看原始事件
 *   node tools/feelings.mjs add <judge> <ok|noise|unsure> [target]
 *                                                    # 手动记一次用户裁决（by=user）
 *   node tools/feelings.mjs --window 30              # 换统计窗口（天，默认 90）
 *
 * ⚠️ 核心约定（见 AGENTS.md §2.1）：
 *   · **没数据** 与 **数据不足** 与 **结论** 是三种东西，本工具分开说；
 *   · 样本不足时**不给否决率**（`null`），不把"没数据"算成 0%；
 *   · 退出码：读不动 ⇒ 1；其余 0（方便脚本判断"有没有坏"）。
 */
import { feelingsFile, feelingsStats, loadFeelings, recordVerdict, MIN_SAMPLES } from '../lib/feelings.js'

const argv = process.argv.slice(2)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }
const windowDays = +(get('--window', 90))

const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : ''

function fmt(b) {
  const dec = b.decided || 0
  if (!dec) return `触发 ${b.fired} 次，**还没有任何裁决**`
  const rate = b.insufficient ? `（样本不足，暂不给否决率；至少要 ${MIN_SAMPLES} 条裁决）` : `否决率 ${(b.noiseRate * 100).toFixed(0)}%`
  return `触发 ${b.fired} 次 ｜ 裁决 ${dec}（对 ${b.ok} ／ 错 ${b.noise} ／ 判不了 ${b.unsure}）｜ ${rate}`
}

if (sub === 'add') {
  const [judge, verdict, target] = argv.slice(1)
  const r = recordVerdict({ judge, verdict, target })
  if (!r.ok) { console.error('❌ 没记上：' + r.reason); process.exit(1) }
  console.log(r.added ? `✅ 已记：${judge} → ${verdict}${target ? `（${target}）` : ''}` : `⏭️ ${r.reason}`)
} else if (sub === 'list') {
  const limit = +(get('--limit', 20))
  const { ok, events, badLines, reason } = loadFeelings()
  if (!ok) { console.error('❌ ' + reason); process.exit(1) }
  console.log(`📄 ${feelingsFile()}`)
  console.log(`共 ${events.length} 条事件${badLines ? `（另有 ${badLines} 行坏了，已跳过）` : ''}`)
  for (const e of events.slice(-limit)) {
    const t = new Date(e.when || '').toISOString().replace('T', ' ').slice(0, 19)
    if (e.kind === 'fired') console.log(`  ${t}  [fired]  ${(e.judges || []).join('、')}`)
    else console.log(`  ${t}  [${e.verdict}] ${e.judge}${e.target ? ' → ' + e.target : ''}`)
  }
  if (!events.length) console.log('  （空表 —— 还没有任何事件）')
} else {
  const st = feelingsStats({ windowDays })
  if (!st.ok) { console.error('❌ ' + st.reason); process.exit(1) }
  console.log('🧪 感觉表（判断的准度，不是内容）')
  console.log(`   ${st.reason}`)
  const judges = Object.keys(st.judges)
  if (!judges.length) {
    console.log('   ⚠️ 还没有任何 judge 记录 ⇒ **这不是"准确率 0%"，是"还没有数据"**')
    console.log('   ⇒ 需要两样：① 每轮记录哪些 judge 响了（fired）② 用户对它们说对/不对（verdict）')
  } else {
    for (const j of judges.sort()) console.log(`   · ${j}：${fmt(st.judges[j])}`)
  }
}
