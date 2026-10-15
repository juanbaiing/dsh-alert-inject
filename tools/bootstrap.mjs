/**
 * bootstrap.mjs — CLI：首次引导（把本机历史会话一次性利用起来）
 *
 * ⚠️ 逻辑全在 `lib/bootstrap.js`（本脚本只是外壳）。
 *
 * 用法：
 *   node tools/bootstrap.mjs                      # 正式跑（写标记）
 *   node tools/bootstrap.mjs --dry-run            # 只统计，不写
 *   node tools/bootstrap.mjs --if-needed          # 只在从未引导过时跑
 *   node tools/bootstrap.mjs --max-sessions 20 --max-bytes 40
 *   node tools/bootstrap.mjs --reset              # 删掉标记（下次会重新引导）
 */

import fs from 'node:fs'
import { runBootstrap, renderBootstrap, bootstrapState, BOOTSTRAP_MARK } from '../lib/bootstrap.js'

const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)
const get = (k, d) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }

if (has('--reset')) {
  try { fs.unlinkSync(BOOTSTRAP_MARK); console.log('✅ 已删除引导标记，下次会重新引导') } catch { console.log('（标记本来就不存在）') }
  process.exit(0)
}

if (has('--status')) {
  const s = bootstrapState()
  console.log(s ? JSON.stringify(s, null, 2) : '（从未引导过）')
  process.exit(0)
}

if (has('--if-needed') && !bootstrapState()) {
  const s = bootstrapState()
  if (s) { console.log('（已引导过，跳过。要重跑先 --reset）'); process.exit(0) }
}

const r = await runBootstrap({
  dryRun: has('--dry-run'),
  maxSessions: Number(get('--max-sessions', 60)),
  maxBytes: Number(get('--max-bytes', 120)) * 1024 * 1024,
})
console.log(renderBootstrap(r))
