/**
 * 端到端：真跑一次 `buildReport`，看**跨对话那一段到底走没走到**。
 *
 * ⚠️ 为什么这条必须有（前面那条只测了渲染器）：
 *   接线的失败方式是**静默无效** —— 配置存了、界面显示"已启用"、
 *   渲染器也测通了，而 `report.js` 里那个 `if` 的条件**根本不成立**。
 *   ⇒ 只有把 `buildReport` 真跑一遍，看 `meta.contexts` 和报告正文里有没有跨对话段，
 *     才算证明"接线生效"。
 *
 * ⚠️ 隔离：`DSH_ALERT_CONTEXTS` 指临时文件 ⇒ **不动作者的真实语境区配置**。
 * 用法：`node tools/check-cross-e2e.mjs`（退出码非 0 = 有问题）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cross-e2e-'))
process.env.DSH_ALERT_CONTEXTS = path.join(tmpDir, 'alert-contexts.json')

const LIB = new URL('../lib/', import.meta.url).href
const { buildReport } = await import(LIB + 'report.js')
const { cachePath } = await import(LIB + 'librarian.js')
const { readSessionHead } = await import(LIB + 'harvest.js')

const fails = []
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✅ ' + label + (extra ? '　' + extra : ''))
  else { console.log('  ❌ ' + label + (extra ? '　' + extra : '')); fails.push(label) }
}

console.log('══════ 跨对话端到端检查 ══════\n')

// 收集有索引的会话，并按 cwd 归类
const root = path.join(os.homedir(), '.dsh', 'sessions')
const found = []
const walk = (d, depth = 0) => {
  if (depth > 8) return
  let ents = []
  try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, depth + 1)
    else if (e.name === 'session.jsonl.zstd') found.push(p)
  }
}
walk(root)
const indexed = []
for (const f of found) {
  const cp = cachePath(f)
  if (!fs.existsSync(cp)) continue
  try {
    const j = JSON.parse(fs.readFileSync(cp, 'utf8'))
    if (!j.entries?.length) continue
    const head = readSessionHead(f) || {}
    if (!head.cwd) continue
    indexed.push({ file: f, id: path.basename(path.dirname(f)), cwd: head.cwd, n: j.entries.length, m: fs.statSync(f).mtimeMs })
  } catch { /* 跳过 */ }
}
console.log('有索引且知道 cwd 的会话: ' + indexed.length + ' 个')

// 找**同一 cwd 下至少两个**有索引的会话（跨对话才有意义）
const byCwd = new Map()
for (const s of indexed) {
  if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, [])
  byCwd.get(s.cwd).push(s)
}
let target = null
for (const [cwd, list] of byCwd) {
  list.sort((a, b) => b.m - a.m)
  if (list.length >= 2) { target = { cwd, list }; break }
}
if (!target) {
  console.log('⚠️ 没有"同一项目下两个都有索引的会话" ⇒ 端到端跑不了（不算失败）')
  console.log('   （要造这个条件：在同一个项目里用两场对话，各跑一次自查让索引建起来）')
  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(0)
}
const A = target.list[0], B = target.list[1]
console.log('项目: ' + target.cwd)
console.log('  A(当前) = ' + A.id + ' (' + A.n + ' 条)')
console.log('  B(别的) = ' + B.id + ' (' + B.n + ' 条)')

/**
 * ⚠️⚠️ 【必须在检查开始前主动把索引建好 —— 否则这个检查"第一次跑必失败"】
 *
 *   实测踩到：`report.js` 在"那一场还没索引"时走的是
 *     「记一句 skipped + fire-and-forget 去后台建」
 *   —— 设计是对的（不阻塞本轮），**但本脚本会 `process.exit()`**，
 *   于是那个后台建索引的 Promise **被进程退出直接杀掉**。
 *   ⇒ 结果：B 场永远没索引 ⇒ 这个端到端检查**第一次跑总是报"报告正文里没出现跨对话段"**，
 *     跑第二次才过（要靠上一次留下的索引）。
 *
 *   ⇒ "时好时坏的检查"是最坏的一种：它会让人怀疑功能，而真正的问题是
 *     **检查没有自己保证前提**。所以这里显式地把前提建起来（幂等，已有索引就直接返回）。
 *   ⚠️ 用 `await`（不是 fire-and-forget）—— 检查要的是"确定的前提"，不是"尽快"。
 */
{
  const { ensureIndex, cacheState } = await import('../lib/librarian.js')
  for (const s of [A, B]) {
    const st = cacheState(s.file)
    if (st.state === 'ok') { console.log(`  ${s.id.slice(0, 8)} 索引已就绪（${st.detail}）`); continue }
    process.stdout.write(`  ${s.id.slice(0, 8)} 建索引中（${st.state}: ${st.detail}）… `)
    const r = await ensureIndex(s.file)
    console.log(r.ok ? `好（${r.entries} 条）` : `失败：${r.error}`)
  }
}

// ① 先跑一次"只有当前一场"（基线）
fs.writeFileSync(process.env.DSH_ALERT_CONTEXTS, JSON.stringify({
  version: 1, enabled: true, selected: [A.id], anchor: A.id, maxSessions: 5,
}))
const base = await buildReport(target.cwd, {})
ok(base.meta.contexts?.enabled === true, '配置读到了（enabled=true）')
ok(base.meta.contexts?.used === 0, '只有当前一场 ⇒ 跨对话用的场数=0', String(base.meta.contexts?.used))
ok((base.text || '').indexOf('跨对话回忆') === -1, '基线报告里**没有**跨对话段')

// ② 再把 B 加进语境区 ⇒ 应该出现跨对话段
fs.writeFileSync(process.env.DSH_ALERT_CONTEXTS, JSON.stringify({
  version: 1, enabled: true, selected: [A.id, B.id], anchor: A.id, maxSessions: 5,
}))
const withB = await buildReport(target.cwd, {})
ok(withB.meta.contexts?.used === 1, '★ 加了一场别的对话 ⇒ 跨对话用的场数=1', String(withB.meta.contexts?.used))
const hasCross = (withB.text || '').indexOf('跨对话回忆') !== -1
ok(hasCross, '★ 报告正文里**出现了跨对话段**（接线真的走到了）',
  hasCross ? '' : '（可能是那一场没有足够相似的命中 —— 那不算 bug，但这次证明不了）')
if (hasCross) {
  ok((withB.text || '').indexOf('来自【') !== -1, '★ 跨对话段落里每条都带来源')
  ok((withB.text || '').indexOf('可能是你后来已经改掉的想法') !== -1, '带"可能是旧想法"的提醒')
}
console.log('\n  meta.contexts = ' + JSON.stringify(withB.meta.contexts))
console.log('  meta.crossMs = ' + (withB.meta.crossMs ?? '—') + ' ms')

fs.rmSync(tmpDir, { recursive: true, force: true })

console.log('\n══════ 结论 ══════')
if (fails.length) {
  console.log('❌ ' + fails.length + ' 项没过：' + fails.join('；'))
  process.exit(1)
}
console.log('✅ 接线端到端成立：配置一变，报告里的跨对话段就跟着变。')
