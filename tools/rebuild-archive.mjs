#!/usr/bin/env node
/**
 * 重建档案索引（**会写盘**）+ 计时 + 增量统计。
 *
 * ⚠️⚠️ 【为什么改写：上一版有个 38 分钟的静默失败，务必记住】
 *   上一版直接调 `buildArchiveIndex()` —— 但那个函数的契约是「**不写盘**」
 *   （它自己的注释第一行就写着）。于是：
 *     · 它算了 **2731 秒**、报了「块数 1709 / 覆盖 100%」
 *     · 而缓存文件**一个字节都没变**（还是旧的 400 块）
 *     · 更坏的是它打印的「缓存大小 5.08 MB」是 `statSync` 读的**旧文件**，
 *       看上去像"写成功了" —— **形状完全正常，只有结果是假的**。
 *   ⇒ 这就是本项目最戒备的那类：`fail-plausible`。
 *   ⇒ 根因：**没有读被调用函数的契约就假设它会副作用**。
 *     正确做法是走**已经实现并验证过写盘的** `ensureArchiveIndex()`
 *     （它内部：命中戳记就复用、否则 build + 写盘 + 盖 stamp）。
 *
 * 用法：node tools/rebuild-archive.mjs
 * 耗时：全量 1709 块实测约 45 分钟（1.6 秒/块）；增量秒级。
 */
import fs from 'node:fs'
import { archiveDir, ensureArchiveIndex, cachePathFor } from '../lib/archive.js'

const ad = archiveDir()
if (!ad.dir) { console.log('档案目录没配：' + ad.why); process.exit(1) }
console.log('档案目录: ' + ad.dir)
console.log('  来源: ' + ad.why)

const cp = cachePathFor(ad.dir)
const before = fs.existsSync(cp) ? JSON.parse(fs.readFileSync(cp, 'utf8')) : null
console.log('')
console.log('重建前缓存: ' + (before
  ? `entries=${before.entries?.length} chunks=${before.stats?.chunks} coverage=${before.stats?.coverage} builtAt=${before.builtAt}`
  : '不存在'))
console.log('  缓存文件: ' + cp)
console.log('  （注意：这份索引**不写盘**的旧版本曾让我白等 38 分钟，见文件头）')
console.log('')
console.log('开始（走 ensureArchiveIndex ⇒ 确认会写盘）…')

const t0 = Date.now()
let last = 0
const r = await ensureArchiveIndex(ad.dir, {
  onLog: (m) => {
    // 只打印每 200 条一次的进度，避免刷屏
    const m2 = /重建 (\d+)\/(\d+)/.exec(m)
    if (m2) {
      const done = Number(m2[1])
      if (done - last >= 200 || done === Number(m2[2])) {
        last = done
        console.log(`  ${done}/${m2[2]}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
      }
    } else console.log('  [log] ' + m)
  },
})
const ms = Date.now() - t0

console.log('')
console.log('=== 结果 ===')
console.log('  state = ' + r.state + (r.reused ? '（命中缓存，未重建）' : ''))
if (r.why) console.log('  why = ' + r.why)
if (r.index) {
  console.log('  块数 = ' + r.index.entries.length)
  console.log('  stats = ' + JSON.stringify(r.index.stats))
  console.log('  incremental = ' + JSON.stringify(r.index.incremental))
  console.log('  覆盖 = ' + ((r.index.stats?.coverage ?? 0) * 100).toFixed(1) + '%')
}
console.log('  耗时 = ' + (ms / 1000).toFixed(1) + ' 秒')
console.log('')

// ★ 关键：**回读磁盘**确认真的写进去了（不看内存里的返回值）
console.log('=== 回读磁盘核对（这才是"写成功"的证据）===')
if (!fs.existsSync(cp)) {
  console.log('  ❌ 缓存文件不存在 ⇒ 没写盘！')
  process.exit(1)
}
const after = JSON.parse(fs.readFileSync(cp, 'utf8'))
const fi = fs.statSync(cp)
console.log('  文件: ' + (fi.size / 1048576).toFixed(2) + ' MB  改于 ' + fi.mtime.toISOString().slice(0, 19))
console.log('  entries = ' + after.entries.length + '   vecs = ' + after.vecs.length)
console.log('  coverage = ' + after.stats.coverage + '   chunks = ' + after.stats.chunks + '/' + after.stats.total)
console.log('  builtAt = ' + after.builtAt)
console.log('  stamp = ' + JSON.stringify(after.stamp))

const ok = Array.isArray(after.vecs) && after.vecs.length === after.entries.length && after.stats.coverage >= 0.999
console.log('')
console.log(ok
  ? '  ✅ 写盘成功且覆盖完整（entries 与 vecs 等长、coverage=100%）'
  : '  ❌ 写盘结果不对（entries/vecs 不等长，或覆盖不足）')
process.exit(ok ? 0 : 1)
