/**
 * health.mjs — CLI：体检报告
 *
 * 给**不看代码的人**用。跑一下，看它自己报告"我现在是什么状态"。
 *
 * 用法：
 *   node tools/health.mjs                          # 用当前推断的项目根
 *   node tools/health.mjs --project D:/某项目       # 指定项目
 *
 * ⚠️ 核心约定（见 AGENTS.md）：本报告把「没测」和「测了没问题」**分开列**。
 *    这两件事混在一起，就是本项目六次静默失败的共同成因。
 */

import { runHealth, renderHealth } from '../lib/health.js'

const argv = process.argv.slice(2)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }

const r = await runHealth({
  projectRoot: get('--project') || process.env.DSH_ALERT_CWD || undefined,
  cwd: process.cwd(),
})

console.log(renderHealth(r))

// ⚠️ 退出码要能表达状态：坏了 ⇒ 非 0（这样"跑一下"就能被自己或脚本判断）
const broken = r.checks.filter((c) => c.status === 'broken').length
process.exit(broken ? 1 : 0)
