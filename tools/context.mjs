/**
 * context.mjs — 整理稿（L2）的 CLI ＋ 灌进 `cases` 库
 *
 * ══ 为什么有这个文件（2026-10-16）══════════════════════════════════
 *   `lib/context.js` 的 7 个导出**全都没有调用点**（接线审计报的孤岛）：
 *     它能把会话**切块→清洗→按语境分组**（实测 20.9MB → 3.6MB，**370 块 / 1689 条**），
 *     但**没有 CLI、也没有代码调它** ⇒ 那份整理稿一直是**手动跑出来的**，
 *     而且**跑出来也没人读**。
 *   ⇒ 本 CLI 是它的**第一个调用点**：手动能跑、能看、能验证。
 *   ⇒ 再接上 `cases`：**整理稿的每个语境块 → 库里的"案例"一条**
 *     （作者要的 `cases` ＝「**L2 的语境块投影**」，就是这件事）。
 *
 * 用法：
 *   node tools/context.mjs --project D:/某项目                # 整理（增量：源没长就复用）
 *   node tools/context.mjs --project D:/某项目 --show         # 只看现状，不动任何文件
 *   node tools/context.mjs --project D:/某项目 --to-cases     # 整理完，把语境块灌进 cases 库
 *
 * ⚠️ 幂等：`cases` 那一步靠内容指纹去重，**重复跑不会重复灌**。
 * ⚠️ 只读＋只写它自己的产物（整理稿、cases 库）；**不碰会话原文**。
 */

import fs from 'node:fs'
import path from 'node:path'
import { normalizeSession, loadContext, contextStatus, contextFile } from '../lib/context.js'
import { latestSessionFile } from '../lib/index.js'
import { appendEntry, dbStatus } from '../lib/db.js'

const argv = process.argv.slice(2)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }
const has = (k) => argv.includes(k)

const projectRoot = get('--project') || process.env.DSH_ALERT_PROJECT || undefined
if (!projectRoot) {
  console.log('⚠️ 没给项目根（--project）⇒ 找不到会话，也就没得整理。')
  console.log('   用法：node tools/context.mjs --project D:/你的项目')
  process.exit(2)
}

console.log('══════════════════════════════════════════════════════════')
console.log('  整理稿（L2）：切块 → 清洗 → 按语境分组')
console.log('══════════════════════════════════════════════════════════')
console.log(`项目根：${projectRoot}`)

const sess = latestSessionFile(projectRoot)
if (!sess) {
  console.log('')
  console.log('⚠️ 这个项目下找不到会话文件 ⇒ **没得整理**（这不是"整理出来是空的"）。')
  process.exit(1)
}
const sessTag = path.basename(path.dirname(sess))
console.log(`会话：${sessTag}`)
console.log(`整理稿会写到：${contextFile(sess)}`)
console.log('')

if (has('--show')) {
  const st = contextStatus()
  console.log('── 现状（--show：不动任何文件）──')
  console.log(`  目录：${st.dir}`)
  console.log(`  文件：${st.files} 个　合计 ${(st.bytes / 1048576).toFixed(2)} MB　${st.records} 条`)
  const c = loadContext(sess)
  console.log(`  本会话：${c.fromL2 ? c.note : '⚠️ ' + c.note}`)
  const d = dbStatus()
  console.log(`  cases 库：${d.libs.cases.count} 条`)
  process.exit(0)
}

// ── ① 整理（增量：`normalizeSession` 自带水位线，源没长就直接复用）──
const r = normalizeSession(sess)
if (!r.ok) {
  console.log('⚠️ 整理失败：' + (r.reason || '（没有给出原因 —— 这是缺陷，请报上来）'))
  process.exit(1)
}
console.log('── ① 整理 ──')
console.log(`  ${r.reused ? '源没变化 ⇒ 直接复用（没重算）' : '已重新整理'}`)
console.log(`  ${r.total} 条 / ${r.blocks} 块` + (r.acts ? `　（源 ${r.acts} 个动作）` : ''))
if (r.dropped) {
  const d = r.dropped
  const sum = (d.platform || 0) + (d.nonHuman || 0) + (d.emptyAfterStrip || 0) + (d.dedup || 0)
  // ⚠️ 「丢弃」账要能平（§245：这个项目的旧账就是这里不平）
  console.log(`  丢弃：平台 ${d.platform || 0} ／ 系统通知 ${d.nonHuman || 0} ／ 剥注入后为空 ${d.emptyAfterStrip || 0} ／ 重复 ${d.dedup || 0}` +
    `　（其中被截断但仍保留 ${d.truncated || 0} 条 —— **它没被丢**）`)
  console.log(`  ${r.acts !== undefined ? `对账：${r.total} + ${sum} = ${r.total + sum}　源 ${r.acts}　${r.total + sum === r.acts ? '✅ 平' : '⚠️ 不平（差 ' + (r.acts - r.total - sum) + '）'}` : ''}`)
}

// ── ② 读回来核对（"写完了" ≠ "读得回"）──
const c = loadContext(sess)
if (!c.fromL2) {
  console.log('')
  console.log('⚠️ 整理完了却**读不回来**：' + c.note)
  console.log('    ⇒ 这一步没成功，**不要当它做完了**。')
  process.exit(1)
}
console.log('')
console.log('── ② 读回来核对 ──')
console.log(`  ${c.note}`)
const first = c.groups[0]
if (first) {
  console.log(`  首块：第 ${first.block} 块　${first.n} 条　标题「${String(first.head).slice(0, 40)}」`)
}

// ── ③ 灌进 cases 库（可选）──
if (!has('--to-cases')) {
  console.log('')
  console.log('（没给 --to-cases ⇒ 没有灌库。要灌：加这个参数）')
  process.exit(0)
}

console.log('')
console.log('── ③ 灌进 cases 库 ──')
console.log('   ⚠️ `cases` ＝「整理稿的**语境块投影**」——每个块一条，用来回答')
console.log('      「**这条知识当初是在什么场景下得的**」。')
const when = (c.meta && c.meta.at) ? c.meta.at : new Date().toISOString()
let added = 0, skipped = 0, failed = 0
const fails = []
for (const g of c.groups) {
  const pos = g.items?.[0]?.srcPos
  const res = appendEntry('cases', {
    kind: '案例',
    what: `第 ${g.block} 块：${String(g.head || '').slice(0, 100)}`,
    from: { session: sessTag, pos: pos ?? null, block: g.block },
    when,
    conf: 'derived',        // ⚠️ 这是**从对话推出来的**，不是他明说的
    src: '整理稿',
    ver: 1,
    n: g.n,
    kinds: g.kinds,
  })
  if (res.ok && res.added) added++
  else if (res.ok) skipped++
  else { failed++; if (fails.length < 3) fails.push(`第 ${g.block} 块：${res.reason}`) }
}
console.log(`  ✅ 新记下 ${added} 条　／ 已经记过跳过 ${skipped} 条　／ **失败 ${failed} 条**`)
for (const x of fails) console.log('     ⚠️ ' + x)
const d = dbStatus()
console.log(`  cases 库现在共 ${d.libs.cases.count} 条`)

console.log('')
console.log('══════════════════════════════════════════════════════════')
console.log('【你怎么自己确认】')
console.log(`  · 打开 ${path.join(d.root, 'cases', 'cases.jsonl')}`)
console.log(`    数行数 —— 应当等于上面说的「cases 库现在共 N 条」`)
console.log('  · 随便挑一行看：它带着来自哪个会话、第几块 —— 顺着能回到原文')
console.log('  · 再跑一次本命令 ⇒ 「新记下 0 条、跳过 N 条」（**幂等**，不重复灌）')
console.log('⚠️ 本命令不碰会话原文；只写整理稿与 cases 库。')
console.log('══════════════════════════════════════════════════════════')
