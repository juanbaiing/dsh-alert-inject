#!/usr/bin/env node
/**
 * check-capacity.mjs —— **检索视野的容量体检**（只读，不改任何数据）。
 *
 * ⚠️ 为什么这个检查必须长期存在：
 *   `lib/librarian.js` 的**默认配置**（预算 / 每轮补齐步长）决定了"它到底能记住多少"。
 *   而这个量**无法从代码看出来** —— 它取决于真实会话规模，只能量。
 *   2026-10-16 实测（147 个真实会话）：
 *     · 候选中位数 **627** 条、最大 **2593** 条
 *     · 旧默认上限 120 ⇒ 最大会话只覆盖 **4.6%**、候选中位只覆盖 **19%**
 *   ⇒ 也就是说：**不量它，就永远不知道"这个之前好像发生过"其实对早期内容不可能成立**。
 *
 * ⚠️ 更要紧的是防**幸存者偏差**：缓存目录里当时留着的 25 个索引，有 21 个覆盖率是 100%，
 *   看上去"已经很好了"。那是因为**小会话本来就装得下**，而小会话的缓存更容易留下。
 *   只统计缓存 ⇒ 必得错误结论。**这个脚本一律从 L0 原始会话重算候选数，不看缓存。**
 *
 * 用法：`node tools/check-capacity.mjs [会话数，默认 14]`
 * 耗时：每个会话要读+解压 L0，约 0.3~3 秒/个（实测中位 676 ms）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const LIMIT = Number(process.argv[2]) || 14
const SESS = path.join(os.homedir(), '.dsh', 'sessions')
const { recentActivity } = await import('../lib/index.js')
const { OPTS } = await import('../lib/librarian.js')

function allSessionFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) allSessionFiles(p, out)
    // ⚠️ 只认 DSH 自己的这个文件名；别的 .zstd 不是会话
    else if (e.name === 'session.jsonl.zstd') out.push(p)
  }
  return out
}

console.log('══════ 检索视野容量体检 ══════')
console.log(`当前默认配置: 预算 ${OPTS.budget} 条 · 每轮补齐 ${OPTS.fillStep} 条 · 截断 ${OPTS.snip} 字`)
console.log(`（预算 = 稳态窗口上界；补齐是**逐轮**推进的，故首次使用需要若干轮才补满）`)
console.log('')

const files = allSessionFiles(SESS)
  .map((f) => ({ f, mb: fs.statSync(f).size / 1048576 }))
  .sort((a, b) => b.mb - a.mb)

console.log(`共 ${files.length} 个会话，下面量最大的 ${Math.min(LIMIT, files.length)} 个：`)
console.log('')
console.log('大小MB  痕迹数  候选(思考+正文)  默认预算下覆盖  补满需轮数  读L0 ms  会话')
console.log('-'.repeat(96))

const rows = []
for (const { f, mb } of files.slice(0, LIMIT)) {
  const t0 = Date.now()
  let acts = []
  try { acts = recentActivity(f, 0) || [] } catch (e) {
    console.log(`${mb.toFixed(2).padStart(6)}  ★读取失败: ${e.message}`)
    continue
  }
  const ms = Date.now() - t0
  // ⚠️ 候选口径必须与 librarian 的 selectSlots 一致：只收「思考 / 正文」
  const slots = acts.filter((a) => a.kind === '思考' || a.kind === '正文').length
  // 覆盖 = min(预算, 候选) / 候选（补齐完成后能覆盖的比例）
  const cover = slots ? Math.min(OPTS.budget, slots) / slots : 1
  const rounds = Math.ceil(slots / OPTS.fillStep)
  const name = path.basename(path.dirname(f)).slice(0, 22)
  rows.push({ mb, acts: acts.length, slots, cover, rounds, ms })
  console.log(
    `${mb.toFixed(2).padStart(6)}  ${String(acts.length).padStart(6)}  ${String(slots).padStart(14)}  ` +
    `${(cover * 100).toFixed(1).padStart(13)}%  ${String(rounds).padStart(10)}  ${String(ms).padStart(7)}  ${name}`
  )
}

if (!rows.length) { console.log('\n❌ 一个会话都没量到 —— 检查 ~/.dsh/sessions 是否存在'); process.exit(1) }

const sorted = rows.map((r) => r.slots).sort((a, b) => a - b)
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
console.log('')
console.log('=== 分布 ===')
console.log(`候选数 中位=${pct(0.5)}  75分位=${pct(0.75)}  最大=${sorted[sorted.length - 1]}`)
const full = rows.filter((r) => r.cover >= 0.9999).length
console.log(`预算装得下全部候选（覆盖 100%）的会话：${full} / ${rows.length}`)
console.log(`补满所需轮数 中位=${rows.map((r) => r.rounds).sort((a, b) => a - b)[Math.floor(rows.length / 2)]}（每轮之间要跑一次自查）`)
console.log('')
const readMs = rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)]
console.log(`读 L0 成本（每轮自查都要付一次）：中位 ${readMs} ms`)
console.log(`每轮 embed 成本：${OPTS.fillStep} 条 × 实测 0.10~0.83 s/条 = ` +
  `${(OPTS.fillStep * 0.1 / 60).toFixed(1)} ~ ${(OPTS.fillStep * 0.83 / 60).toFixed(1)} 分钟（**后台跑，不阻塞本轮**）`)
console.log('')
console.log('⚠️ 这个脚本只量"视野有多大"，**量不出"命中准不准"** —— 后者要看真实命中，不是容量。')
