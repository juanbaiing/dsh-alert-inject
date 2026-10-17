/**
 * inflate.js —— **会话日志解压的唯一实现**
 *
 * ══ 为什么要有这个文件（2026-10-17 实测）══════════════════════════════
 *   改动前 `inflate()` 在 `index.js` 与 `anchor.js` 里**各有一份完全相同的实现**，
 *   而两处**各自解压同一个文件**：
 *
 *     recentActivity()  → inflate(fs.readFileSync(file))        ← 第一次
 *     anchor.inflateCached() → inflate(fs.readFileSync(file))   ← 第二次
 *
 *   实测（20 MB 会话 / 43,798 帧）：**单次全量解压 2,782 ms**，
 *   而 `buildReport` 一次要花 11 秒，其中约 5 秒就是这**两次重复解压**。
 *
 *   ⇒ 本文件做两件事：
 *     ① 把解压实现收敛到一处（同一条纪律：**同一件事只能有一个实现**，两份必然漂移）；
 *     ② 按 `文件 + 大小` 缓存解压后的文本，让同一轮里的多个调用方共用一次解压。
 *
 * ⚠️ 缓存键用 `file:size` 而**不是** `file:mtimeMs:size`（这是刻意的）：
 *   会话文件**边写边读**，mtime 每轮都变 ⇒ 带 mtime 的缓存永远不命中，
 *   而 `anchor.js` 原来正是这么写的，所以它的 `inflateCached` 其实一直没起到作用。
 *   追加写只会让 size 增长，所以 `size` 变化足以代表"内容变了"。
 *   截断重写成同一大小的情形理论上存在，但会话日志是纯追加的，不接受这个风险。
 *
 * ⚠️ 缓存上限 3 份：一次自查最多涉及"当前会话 + 几个语境区会话"，
 *   留 3 份够用，再多就是内存浪费（单份解压后可能 40 MB）。
 */

import fs from 'node:fs'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 纯函数：解开所有 zstd 帧（DSH 会话日志是多帧拼接）。 */
export function inflate(buf) {
  const offs = []
  let i = buf.indexOf(MAGIC)
  while (i !== -1) { offs.push(i); i = buf.indexOf(MAGIC, i + 1) }
  offs.push(buf.length)
  let t = ''
  for (let k = 0; k < offs.length - 1; k++) {
    try { t += zlib.zstdDecompressSync(buf.subarray(offs[k], offs[k + 1])).toString('utf8') } catch { /* 尾部不完整帧 */ }
  }
  return t
}

/**
 * 只解最后 `maxFrames` 帧 —— 用于"只要最近若干条痕迹"的场景。
 *
 * ⚠️ 用之前必须确认调用方**不需要早期内容**：
 *   `anchor` 要找会话开头的 goal，所以它不能用这个；
 *   `recentActivity(limit)` 只要尾部，可以用。
 * ⚠️ 返回的是**近似**：帧与痕迹不是一一对应（实测 43,798 帧 → 61,419 行）。
 */
export function inflateTail(buf, maxFrames = 4000) {
  const offs = []
  let i = buf.indexOf(MAGIC)
  while (i !== -1) { offs.push(i); i = buf.indexOf(MAGIC, i + 1) }
  if (offs.length <= maxFrames) return inflate(buf)
  const start = offs.length - maxFrames
  let t = ''
  for (let k = start; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    try { t += zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8') } catch { /* 跳过坏帧 */ }
  }
  return t
}

const _cache = new Map()
const CACHE_MAX = 3

/**
 * 读会话文件并解压（带缓存）。多处调用同一文件时只解压一次。
 * @returns {string|null} 读不动时返回 null（**调用方必须自己出声**，不要当空会话处理）
 */
export function readSessionText(file) {
  let size
  try { size = fs.statSync(file).size } catch { return null }
  const key = `${file}:${size}`
  const hit = _cache.get(key)
  if (hit !== undefined) return hit
  let t
  try { t = inflate(fs.readFileSync(file)) } catch { return null }
  if (_cache.size >= CACHE_MAX) _cache.clear()
  _cache.set(key, t)
  return t
}

/** 测试/调试用：清空缓存 */
export function clearInflateCache() { _cache.clear() }
