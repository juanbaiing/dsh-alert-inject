#!/usr/bin/env node
/**
 * 验证**档案索引增量**真的生效。
 *
 * 判据（三条，缺一不可）：
 *   ① 缓存已有索引时，重建应**大部分复用**（`reused` 接近总块数）
 *   ② 新嵌块数应**很少**（只嵌真正变过的那些）
 *   ③ 耗时应**秒级**，而不是 38 分钟
 *
 * ⚠️ 这条验证最要紧的地方：**它证明"改动档案不用再重跑 38 分钟"**。
 *   在此之前，实测 1.35 秒/块 × 1709 块 = 38 分钟，而 `dirStamp` 按最新 mtime 算
 *   ⇒ 只要动过一个文件就全量重来。
 */
import fs from 'node:fs'
import { archiveDir, ensureArchiveIndex, cachePathFor, readCachedIndex } from '../lib/archive.js'

const ad = archiveDir()
if (!ad.dir) { console.log('档案目录没配：' + ad.why); process.exit(1) }
console.log('档案目录: ' + ad.dir)
console.log('  来源: ' + ad.why)

const cp = cachePathFor(ad.dir)
const before = fs.existsSync(cp) ? JSON.parse(fs.readFileSync(cp, 'utf8')) : null
console.log('')
console.log('重建前缓存: ' + (before ? `entries=${before.entries?.length} chunks=${before.stats?.chunks} coverage=${before.stats?.coverage}` : '不存在'))

console.log('')
console.log('开始 ensureArchiveIndex（应走增量）…')
const t0 = Date.now()
const logs = []
const r = await ensureArchiveIndex(ad.dir, { onLog: (m) => { logs.push(m); console.log('  [log] ' + m) } })
const ms = Date.now() - t0

console.log('')
console.log('=== 结果 ===')
console.log('  state = ' + r.state + (r.reused ? ' （直接复用，未重建）' : ''))
if (r.why) console.log('  why = ' + r.why)
if (r.index) {
  console.log('  块数 = ' + r.index.entries.length)
  console.log('  stats = ' + JSON.stringify(r.index.stats))
  console.log('  incremental = ' + JSON.stringify(r.index.incremental))
  console.log('  覆盖 = ' + ((r.index.stats?.coverage ?? 0) * 100).toFixed(1) + '%')
}
console.log('  耗时 = ' + (ms / 1000).toFixed(1) + ' 秒')

console.log('')
console.log('=== 判据 ===')
const fails = []
if (r.index && r.index.incremental) {
  const inc = r.index.incremental
  const tot = inc.reused + inc.embedded
  if (inc.reused === 0) fails.push('一块都没复用 ⇒ 增量没生效（或缓存里没有可复用的条目）')
  if (inc.embedded > tot * 0.5) fails.push(`新嵌 ${inc.embedded}/${tot} ⇒ 复用得太少，增量意义不大`)
  console.log(`  ① 复用 ${inc.reused} / ${tot} 块（${(inc.reused / Math.max(1, tot) * 100).toFixed(0)}%）`)
  console.log(`  ② 新嵌 ${inc.embedded} 块`)
  console.log(`  ③ 耗时 ${(ms / 1000).toFixed(1)} 秒`)
} else if (r.reused) {
  console.log('  ① 直接命中有效缓存（连重建都没走）—— 这也是期望行为')
} else {
  fails.push('既没走增量、也没命中缓存 ⇒ 查 readCachedIndex / buildArchiveIndex 的接线')
}
if (ms > 120000) fails.push(`耗时 ${(ms / 1000).toFixed(0)} 秒 > 120 秒 ⇒ 不像增量（全量约 38 分钟）`)

console.log('')
if (fails.length) {
  console.log('❌ 未过：')
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
console.log('✅ 增量成立：档案改动后只需重嵌很少的块。')
