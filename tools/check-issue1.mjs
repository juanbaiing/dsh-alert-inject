#!/usr/bin/env node
/**
 * 复现 GitHub issue #1：「alert_check 读不到当前会话 ⇒ 会话类检测器全部静默跳过」
 *
 * issue 的方法很干净：**同一个 buildReport()，只改 cwd 一个变量**。
 * 本脚本照抄这个方法，看本地版本还活着没有。
 *
 * ⚠️ 关键判据（issue 的核心指控）：
 *   进不去会话时，输出仍然是一行「✅ 无异常」，而 **skipped 里什么都不说** ——
 *   也就是「**没跑**」这件事连留痕都没有。
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.ALERT_NO_RETRIEVAL = '1'

const LIB = new URL('../lib/', import.meta.url).href
const { buildReport } = await import(LIB + 'report.js')
const { latestSessionFile } = await import(LIB + 'index.js')

// 找一个**真实存在的会话工作区**当"cwd 正确"的对照组
const SESS = path.join(os.homedir(), '.dsh', 'sessions')
const goodCwd = 'D:\\dswork'

const cases = [
  { name: 'D:\\dswork（真实会话工作区）', cwd: goodCwd },
  { name: 'D:\\（根目录）', cwd: 'D:\\' },
  { name: 'C:\\', cwd: 'C:\\' },
  { name: os.homedir(), cwd: os.homedir() },
  { name: '运行时目录', cwd: path.join(os.homedir(), '.dsh', 'profiles', 'web') },
  { name: '压根不存在的路径', cwd: 'D:\\no-such-workspace-xyz' },
]

console.log('=== 只改 cwd 一个变量（照 issue 的方法）===')
console.log('')
const rows = []
for (const c of cases) {
  let lsf = null
  try { lsf = latestSessionFile(c.cwd) } catch { /* ignore */ }

  let rep = null
  let err = null
  try { rep = await buildReport(c.cwd, {}) } catch (e) { err = e?.message || String(e) }

  const skipped = rep?.meta?.skipped || []
  const lines = (rep?.text || '').split('\n').filter((l) => l.trim()).length
  rows.push({
    cwd: c.name,
    lsf: lsf ? path.basename(path.dirname(lsf)).slice(0, 18) : 'null',
    acts: rep?.meta?.acts ?? '?',
    skippedN: skipped.length,
    lines,
    clean: (rep?.text || '').includes('无异常'),
  })
}

const pad = (s, n) => String(s).padEnd(n)
console.log(pad('cwd', 30) + pad('latestSessionFile', 20) + pad('acts', 8) + pad('skipped', 9) + pad('行数', 6) + '输出含"无异常"')
console.log('-'.repeat(100))
for (const r of rows) {
  console.log(pad(r.cwd, 30) + pad(r.lsf, 20) + pad(r.acts, 8) + pad(r.skippedN, 9) + pad(r.lines, 6) + r.clean)
}

console.log('')
console.log('=== 判据 ===')
const noSess = rows.filter((r) => r.lsf === 'null')
const silent = noSess.filter((r) => r.skippedN === 0)
const fails = []

if (noSess.length === 0) {
  console.log('  ⚠️ 没造出"读不到会话"的场景 ⇒ 这轮没验到（不算通过也不算失败）')
} else {
  console.log(`  "读不到会话"的场景: ${noSess.length} 个`)
  console.log(`  其中 **skipped 为空（静默）** 的: ${silent.length} 个`)
  if (silent.length) {
    fails.push(`有 ${silent.length} 个"读不到会话"的场景**没有任何留痕**（skipped 为空）⇒ issue #1 的根因②仍然存在`)
  }
  const stillClean = silent.filter((r) => r.clean)
  if (stillClean.length) {
    fails.push(`有 ${stillClean.length} 个场景仍然输出"无异常"而 7 类检测器根本没跑 ⇒ 这正是 issue 指控的"看起来没问题"`)
  }
}

if (fails.length) {
  console.log('')
  console.log('❌ issue #1 仍然活着：')
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
console.log('')
console.log('✅ 读不到会话时**有留痕**（不管跑没跑，都说了出来）')
