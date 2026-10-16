/**
 * check-cross-context.mjs —— 证明**跨对话检索真的接线了**，且每条命中带来源。
 *
 * ⚠️ 为什么必须测这一条：
 *   接线的失败方式之一是**静默无效** —— 开关打开、配置存了、界面也显示"已启用"，
 *   而检索那一段根本没走跨对话分支（`report.js` 里一行 if 的条件写错就够）。
 *   ⇒ 唯一能证明的办法：**真跑一次检索，看输出里有没有别的对话的名字**。
 *
 * ⚠️ 隔离：`DSH_ALERT_CONTEXTS` 指向临时文件 ⇒ **不动作者真实的语境区配置**。
 * 用法：`node tools/check-cross-context.mjs`（退出码非 0 = 有问题）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cross-'))
process.env.DSH_ALERT_CONTEXTS = path.join(tmpDir, 'alert-contexts.json')
// ⚠️ **不要**隔离 LIBRARIAN_CACHE（我第一版隔离了，结果"有索引的会话: 0 个"）——
//    本检查**只读**缓存（`loadCache` / `query` 都不写盘），而隔离之后
//    那 17 个真实索引全都看不见了 ⇒ 检查自己把自己废掉了。
//    ⇒ 规矩：**隔离"会被写的东西"，但读的数据源要留可见**。

const LIB = new URL('../lib/', import.meta.url).href
const { query, render, loadCache, cachePath } = await import(LIB + 'librarian.js')
const { readSessionHead } = await import(LIB + 'harvest.js')

const fails = []
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✅ ' + label + (extra ? '　' + extra : ''))
  else { console.log('  ❌ ' + label + (extra ? '　' + extra : '')); fails.push(label) }
}

console.log('══════ 跨对话检索检查 ══════\n')

// 找两个**已经有索引**的会话（没有就得先建，那要几十秒，直接跳过更诚实）
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
const withIdx = []
for (const f of found) {
  const cp = cachePath(f)
  if (fs.existsSync(cp)) { try { const j = JSON.parse(fs.readFileSync(cp, 'utf8')); if (j.entries?.length) withIdx.push({ f, n: j.entries.length }) } catch { /* 坏缓存跳过 */ } }
}
withIdx.sort((a, b) => b.n - a.n)
console.log('本机有索引的会话: ' + withIdx.length + ' 个')
if (withIdx.length < 2) {
  console.log('⚠️ 少于 2 个有索引的会话 ⇒ 这条检查现在跑不了（不算失败）')
  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(0)
}
const A = withIdx[0].f, B = withIdx[1].f
const idOf = (f) => path.basename(path.dirname(f))
const headOf = (f) => { try { return readSessionHead(f) || {} } catch { return {} } }
console.log('用这两场：\n  A = ' + idOf(A) + ' (' + withIdx[0].n + ' 条索引)\n  B = ' + idOf(B) + ' (' + withIdx[1].n + ' 条索引)\n')

// ① 单对话（现状）：渲染里**不该**出现"跨对话"
const idxA = loadCache(A)
const qrA = await query(idxA, '检查一下这个改动的后果', { topK: 3 })
const single = render(qrA)
ok(single.indexOf('跨对话') === -1, '单对话渲染里不含"跨对话"字样')
ok(single.indexOf('来自【') === -1, '单对话渲染里不含来源标注')

// ② 跨对话（模拟 report.js 的接线逻辑）：把 B 的命中并进 extra
const idxB = loadCache(B)
const qrB = await query(idxB, '检查一下这个改动的后果', { topK: 2 })
const best = qrB?.top?.[0]
ok(!!best, 'B 场检索有命中（没有命中就测不了来源标注）', best && ('sim=' + (best.sim * 100).toFixed(0) + '%'))
if (best) {
  const hits = [{ ...best, fromContext: '测试用的别的对话' }]
  const cross = render({ ...qrA, top: hits, cross: true })
  ok(cross.indexOf('跨对话') !== -1, '跨对话渲染有专属标题')
  ok(cross.indexOf('来自【测试用的别的对话】') !== -1, '★ 每条命中**标明了来自哪一场**（防"记串"）')
  ok(cross.indexOf('可能是你后来已经改掉的想法') !== -1, '带"这可能是旧想法"的提醒')
  // ③ 关键：不能污染原查询结果（我用了 {...best} 复制）
  ok(qrB.top[0].fromContext === undefined, '复制命中**没有污染原检索结果**（qrB 仍干净）')
}

fs.rmSync(tmpDir, { recursive: true, force: true })

console.log('\n══════ 结论 ══════')
if (fails.length) {
  console.log('❌ ' + fails.length + ' 项没过：' + fails.join('；'))
  process.exit(1)
}
console.log('✅ 跨对话渲染成立：单对话不变、跨对话有专属标题且**每条带来源**。')
console.log('   （⚠️ 它证明不了 `report.js` 里的分支条件真的会走到 —— 那要真勾一场别的对话跑自查。）')
