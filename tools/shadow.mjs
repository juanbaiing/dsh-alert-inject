/**
 * shadow.mjs — CLI：**影子判据的汇总裁决**。
 *
 * 给**不看代码的人**用。跑一下，看它报告"影子判据命中了什么、你判过了多少"。
 *
 * 用法：
 *   node tools/shadow.mjs                      # 汇总（默认）
 *   node tools/shadow.mjs --list               # 只列【未裁决】的命中，逐条可判
 *   node tools/shadow.mjs --list --all         # 连已裁决的一起列
 *   node tools/shadow.mjs --good 12            # 第 12 条：**该报**（判对）
 *   node tools/shadow.mjs --bad 12             # 第 12 条：**不该报**（误报）
 *   node tools/shadow.mjs --project D:/某项目   # 指定项目根（用来定位判据表）
 *
 * ⚠️ 核心约定（与 AGENTS.md 一致）：
 *   · **三态**：该报 / 不该报 / **未裁决**。「未裁决」绝不并入"没问题"。
 *   · **误报率的分母只能是已裁决数** —— 否则是用"我不知道"冒充"是对的"。
 *   · **「没在跑」与「跑了没命中」分开报** —— 这两件事混在一起，就是本项目静默失败的成因。
 */

import fs from 'node:fs'
import { summary, markVerdict } from '../lib/shadow.js'
import { judgesPath, config } from '../lib/config.js'

const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }

/** 判据表里有多少条影子判据 —— 决定"影子模式到底有没有在跑" */
function judgesInfo() {
  const root = get('--project') || config().projectRoot || process.env.DSH_ALERT_CWD || process.cwd()
  const jf = judgesPath(root)
  if (!jf) return { root, path: null, total: 0, shadow: 0, names: [], error: `判据表没找到（在 ${root} 下按候选名找过）` }
  try {
    const j = JSON.parse(fs.readFileSync(jf, 'utf8'))
    const all = (j.judges || []).filter((x) => x.enabled !== false)
    const sh = all.filter((x) => x.shadow === true)
    return { root, path: jf, total: all.length, shadow: sh.length, names: sh.map((x) => x.id), error: null }
  } catch (e) {
    return { root, path: jf, total: 0, shadow: 0, names: [], error: `判据表解析失败：${e.message}` }
  }
}

const pct = (r) => (r === null || r === undefined ? '**未知**' : `${(r * 100).toFixed(0)}%`)
const when = (iso) => {
  if (!iso) return '（无记录）'
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const s = summary()
const j = judgesInfo()

// ── 裁决动作（有则先做，再按汇总打印）──
if (has('--good') || has('--bad')) {
  const v = has('--good') ? 'good' : 'bad'
  const n = get(has('--good') ? '--good' : '--bad')
  const r = markVerdict(n, v)
  if (!r.ok) {
    console.log(`⚠️ 裁决失败：${r.error}`)
    process.exit(1)
  }
  console.log(`✅ 已记下：#${r.hit._n} ＝ ${v === 'good' ? '该报（判对）' : '不该报（误报）'}`)
  console.log(`   判据「${r.hit.judge}」· ${r.hit.kind} 第 ${r.hit.pos} 处 · 命中词「${r.hit.term}」`)
  console.log('   （裁决是**追加**一条记录，不改动原命中记录 ⇒ 可改判、可回溯）')
  process.exit(0)
}

// ── --list：逐条列出，供人判 ──
if (has('--list')) {
  const list = s.hits.filter((h) => has('--all') || h._verdict === null)
  if (!list.length) {
    console.log(s.hits.length
      ? `✅ 全部 ${s.hits.length} 条命中都已裁决过，没有待判的（加 --all 可看已裁决的）`
      : '（还没有任何命中记录）')
  } else {
    console.log(`【待判命中】共 ${list.length} 条（裁决：node tools/shadow.mjs --good N 或 --bad N）`)
    console.log('判据 / 源 / 位置 / 命中词 / 原文片段　　← 你只需判「该报还是不该报」')
    console.log('')
    for (const h of list) {
      const mark = h._verdict === null ? '⬜未裁决' : (h._verdict === 'good' ? '✅该报' : '❌不该报')
      const extra = h.n > 1 ? `（另命中 ${h.n - 1} 词）` : ''
      console.log(`#${h._n}  ${mark}  ${h.judge}  ·  ${h.kind} 第 ${h.pos} 处  ·  「${h.term}」${extra}`)
      console.log(`      ${h.snippet}`)
    }
  }
  console.log('')
  console.log(`文件：${s.files.hits}`)
  process.exit(0)
}

// ── 默认：汇总 ──
const L = []
L.push('─'.repeat(60))
L.push(`  影子判据汇总   ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
L.push('─'.repeat(60))
L.push('')

// ① 「有没有在跑」——先回答这个，否则后面的 0 没有意义
if (j.error) {
  L.push(`⚠️ 判据表：${j.error}`)
} else if (j.shadow === 0) {
  L.push('⚠️ 【影子模式**没在跑**】判据表里 0 条 shadow 判据 ——')
  L.push(`   判据表：${j.path}（共 ${j.total} 条判据，全是正常判据）`)
  L.push('   ⇒ 这时输出「没有命中」**不能**说明什么。要启用：给判据加 "shadow": true')
} else {
  L.push(`✅ 影子判据 ${j.shadow} 条：${j.names.join('、')}`)
  L.push(`   判据表：${j.path}（共 ${j.total} 条判据）`)
}

// ② 最近一次扫描的心跳
const lr = s.lastRun
if (!lr) {
  L.push('')
  L.push('⚠️ 【从未扫描过】没有心跳记录 —— 说明 `alert_check` 还没跑过，或影子代码还没生效（改代码需重启 DSH）')
} else {
  L.push('')
  L.push(`最近一次扫描：${when(lr.ts)}`)
  L.push(`  · 扫了 ${lr.scanned} 条痕迹 ／ 分 ${lr.blocks} 块 ／ 判据 ${lr.judges} 条（其中影子 ${lr.shadowJudges} 条）`)
  L.push(`  · 当前语境内影子命中 ${lr.shadowHitsInScope} 处 → 新记下 ${lr.shadowAdded} 条、已记过跳过 ${lr.shadowSkipped} 条`)
  L.push(`  · 同时【正常报警】${lr.alertedJudges} 类判据`)
  if (lr.shadowError) L.push(`  ⚠️ **上次写入失败**：${lr.shadowError}`)
}

// ③ 三态统计
L.push('')
if (!s.total) {
  L.push('【结果】还没有任何命中记录。')
  if (lr && lr.shadowHitsInScope === 0) L.push('  ⇒ 但**它确实扫过**（见上面的心跳）：是「扫了、没命中」，不是「没扫」。')
} else {
  L.push('【结果】三态（⚠️「未裁决」不并入任何一边）')
  L.push(`  · ❌ 不该报（误报） ${s.bad} 条`)
  L.push(`  · ✅ 该报（判对）   ${s.good} 条`)
  L.push(`  · ⬜ **未裁决**      ${s.unknown} 条  ← 还没判的，需要你判`)
  L.push(`  · 合计             ${s.total} 条`)
  L.push('')
  L.push(`【误报率】${pct(s.falseReportRate)}` +
    (s.judged ? `　（**基于已裁决的 ${s.judged} 条**；未裁决的 ${s.unknown} 条不计入）` : '　**未知** —— 一条都还没裁决，无从计算'))
  L.push('')
  L.push('【按判据】')
  for (const g of s.byJudge) {
    L.push(`  · ${g.judge}：命中 ${g.total} ｜ 该报 ${g.good} ／ 不该报 ${g.bad} ／ 未裁决 ${g.unknown} ｜ 误报率 ${pct(g.falseReportRate)}`)
  }
}

// ④ 坏行与上限（如实报告，不假装文件是好的）
if (s.badLines.hits || s.badLines.verdicts) {
  L.push('')
  L.push(`⚠️ 有解析不了的行：命中记录 ${s.badLines.hits} 行、裁决记录 ${s.badLines.verdicts} 行（已跳过，未计入统计）`)
}
if (s.overMaxRead) {
  L.push('')
  L.push('⚠️ 命中记录已达读取上限 —— 统计**可能不完整**（这是明说的不完整，不是静默截断）')
}

// ⑤ 你怎么自己确认
L.push('')
L.push('【你怎么自己确认】')
L.push(`  · 数命中条数：用记事本打开 ${s.files.hits}，数有几行 —— 应当等于上面的「合计」`)
L.push(`  · 看裁决留痕：打开 ${s.files.verdicts}，每次裁决追加一行，**从不改动原文件**`)
L.push(`  · 看它有没有在跑：打开 ${s.files.lastRun}，里面的时间是最近一次自查的时间`)
L.push('')
L.push('─'.repeat(60))
L.push('【下一步】判「未裁决」那批：node tools/shadow.mjs --list')
L.push('         判完再看误报率，再决定这条判据转不转正（去掉 "shadow": true）。')
L.push('⚠️ 误报率高就不要转正 —— 判据表自己记着：「首轮实测 5 条警报全是噪声」。')
L.push('─'.repeat(60))

console.log(L.join('\n'))
