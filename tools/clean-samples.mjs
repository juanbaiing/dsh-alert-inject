/**
 * clean-samples.mjs — **样本卫生**：找出并清掉"结构性无效"的样本
 *
 * ══ 为什么需要它（2026-10-15 实测踩到）════════════════════════════
 *   弱标注挖掘首版有个 bug：把 `grep`/`glob` 的 **搜索模式**当成了文件路径，
 *   于是采出标签形如「世界·概念/背景概念/（星号）」「世界·概念/（两个星号）/（星号）」
 *   的样本 —— **那些标签是凭空造的**，任何模型都学不了，只会被当成噪声。
 *   ⇒ 这类样本不是"质量差"，是**结构性无效**（标签根本不对应任何真实档）。
 *
 *   ⚠️ 写本注释时又踩了一个坑：原文里打了通配符的完整形态，其中的 `星号+斜杠`
 *      序列**把块注释提前闭合并导致语法错误**。
 *      ⇒ 注释里出现通配符路径时，务必避免那两字符相邻。（同类坑本日第二次：
 *        上一次是模板字面量里出现反引号。）
 *
 * ══ 三个判据（都不是靠猜）══════════════════════════════════════════
 *   ① **标签含通配符** `*` —— 必是假档名
 *   ② **标签不在知识图的节点里** —— 档名对不上任何真实档
 *   ③ **输入是平台注入物** —— 不是作者说的话（同 `harvest.js` 的 NON_HUMAN）
 *
 * ⚠️ 默认**只报告不删**。要删必须显式 `--purge`，且会先备份原文件。
 *   （样本库是资产，宁可多留一天，不可手滑清掉。）
 *
 * 用法：
 *   node tools/clean-samples.mjs --project D:/你的项目            # 报告
 *   node tools/clean-samples.mjs --project ... --purge                         # 清理（先备份）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadGraph } from '../lib/knowledge.js'
import { NON_HUMAN } from '../lib/harvest.js'
import { SAMPLE_OPTS, loadSamples } from '../lib/samples.js'

const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }

const PROJECT = get('--project')
const PURGE = has('--purge')
const FILE = get('--file') || SAMPLE_OPTS.file

if (!PROJECT) { console.error('用法：node tools/clean-samples.mjs --project <项目根> [--purge]'); process.exit(1) }

// ── 合法档名集合（来自知识图；没有图就退化为"只查通配符与注入物"）──
const g = loadGraph(PROJECT)
const validDocs = new Set((g?.nodes || []).map((n) => n.id))
console.log(`知识图：${validDocs.size} 个合法档名${validDocs.size ? '' : '（⚠️ 未读到图，判据②将跳过）'}`)

const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
const evs = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
console.log(`样本文件：${FILE}　${evs.length} 条\n`)

const bad = { wildcard: [], unknownDoc: [], injected: [] }
for (const e of evs) {
  if (e.kind !== 'pred') continue
  const label = e.prediction ?? e.label
  const input = String(e.input || '')
  if (typeof label === 'string' && label.includes('*')) bad.wildcard.push(e)
  // ⚠️ 判据②**只对"标签是档名"的任务适用**：
  //    `unit_classify` 的标签是「知识 / 操作」这类**类别名**，不是档名 ——
  //    拿它去比知识图，会把整批好样本判成"档名不存在"。（实测：60 条里 52 条是这么来的。）
  else if (e.task === 'doc_route_weak' && validDocs.size && typeof label === 'string' && !validDocs.has(label)) bad.unknownDoc.push(e)
  // ⚠️ 判据③只对"弱标注 / 纠正"这类**以作者发言为输入**的任务适用
  if (e.task !== 'unit_classify' && NON_HUMAN.test(input.trim())) bad.injected.push(e)
}

const show = (title, arr, fmt) => {
  console.log(`── ${title}：${arr.length} 条`)
  for (const e of arr.slice(0, 6)) console.log('     ' + fmt(e))
  if (arr.length > 6) console.log(`     …（另有 ${arr.length - 6} 条）`)
  console.log()
}
show('① 标签含通配符（假档名）', bad.wildcard, (e) => `「${e.prediction}」  ${String(e.input).slice(0, 50).replace(/\n/g, ' ')}`)
show('② 标签不在知识图里', bad.unknownDoc, (e) => `「${e.prediction}」  ${String(e.input).slice(0, 50).replace(/\n/g, ' ')}`)
show('③ 输入是平台注入物', bad.injected, (e) => `${String(e.input).slice(0, 60).replace(/\n/g, ' ')}`)

// 去重（一条可能同时命中多条判据）
// ⚠️⚠️ **判据②默认不参与清理**（2026-10-15 实测发现它会误伤）：
//    它抓出的 8 条里，`角色分析/森`×3、`角色分析/混沌`×2、`角色分析/依诗`×1 ——
//    而 `角色分析` 是**项目里真实存在的目录**，只是**不属于 `设定档案-JS`**（知识图只覆盖那 72 档）。
//    ⇒ 这些不是"假档名"，是"**标签超出了图的范围**"，**可能完全正确**。
//    盲删它们 = 把"图不完备"当成"样本错"——**这正是本模块要防的那种错**。
//    ⇒ 默认只报告；要清必须显式 `--purge-unknown`。
const PURGE_UNKNOWN = has('--purge-unknown')
const doomed = new Set([...bad.wildcard, ...bad.injected])
if (PURGE_UNKNOWN) for (const e of bad.unknownDoc) doomed.add(e)

console.log(`★ 结构性确定无效（通配符 + 注入物）：${new Set([...bad.wildcard, ...bad.injected]).size} 条 ← --purge 会清这些`)
console.log(`  仅"不在知识图里"（可能只是图不完备）：${bad.unknownDoc.length} 条 ← 需 --purge-unknown 才清`)
console.log(`  本次实际清理：${doomed.size} 条　剩余：${evs.length - doomed.size} 条`)

if (!PURGE) {
  console.log('\n（报告模式：未改动任何东西。确认后加 --purge 清理，会先备份）')
} else {
  const bak = `${FILE}.bak-${Date.now()}`
  fs.copyFileSync(FILE, bak)
  const kept = evs.filter((e) => !doomed.has(e))
  fs.writeFileSync(FILE, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  console.log(`\n✅ 已备份到 ${bak}`)
  console.log(`✅ 已清理：${evs.length} → ${kept.length} 条`)
}
