/**
 * check-cordis-js.mjs —— **改 DSH profile 配置前的隔离检查**（2026-10-27 加）
 *
 * ══ 为什么有这个工具（一次真实的、把 DSH 起不来的事故）════════════════
 *   2026-10-26 给 `cordis.patch.yml` 挂 graph-memory 时写了：
 *       dbPath: !!js "require('path').join(require('os').homedir(), ...)"
 *   ⇒ DSH 重启直接崩：`failed to apply loader entry graph-memory: require is not defined`
 *      报错点在 cordis-plugin-loader 的 `eval`（ESM 模块作用域，**没有 require**）。
 *   ⇒ 代价：GUI 起不来，得靠外部工具救回来。
 *
 * ══ 这个工具做什么 ══════════════════════════════════════════════════════
 *   扫描一个 YAML patch 文件里**所有生效的 `!!js` 表达式**，在**与 cordis 相同的环境**
 *   （ESM 模块作用域、无 require）里求值：
 *     · 能求值 ⇒ ✅（顺带打印结果，让你核对路径对不对）
 *     · 抛错   ⇒ ❌（**这就是会导致整树加载失败的那一行**）
 *
 * ══ 为什么用 `new Function` 模拟 cordis 的 eval ═══════════════════════════
 *   `new Function` 创建的函数在**全局作用域**运行，拿不到模块级的 `require` ——
 *   与 cordis 在 ESM 里 `eval` 的效果一致。**所以它能提前抓到同一类错误。**
 *   ⚠️ 它不能替代「真跑一次 DSH」：插件 apply 阶段的其他错误它看不到。
 *      它只保证**配置表达式本身**不会在加载器里炸。
 *
 * 用法：
 *   node tools/check-cordis-js.mjs [配置文件]
 *   默认：~/.dsh/profiles/web/cordis.patch.yml
 *
 * 退出码：有表达式会炸 ⇒ 1；全部能求值（或没有 !!js）⇒ 0
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const file = process.argv[2] || path.join(os.homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')

if (!fs.existsSync(file)) {
  console.error(`❌ 文件不存在：${file}`)
  process.exit(1)
}

const text = fs.readFileSync(file, 'utf8')
const lines = text.split(/\r?\n/)

/**
 * 提取生效的 `!!js` 表达式：
 *   - 只认**行首非 `#`** 的（注释掉的配置不会被执行，但会被单独提示）
 *   - 支持两种写法：`!!js "expr"`（双引号字符串）与 `!!js expr`（裸表达式）
 */
const active = []
const commented = []
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  const idx = line.indexOf('!!js')
  if (idx === -1) continue
  const isComment = /^\s*#/.test(line)
  let expr = line.slice(idx + 4).trim()
  // 去掉行尾注释（只在引号外；简单处理：以 " 开头就找配对的 "）
  if (expr.startsWith('"')) {
    const end = expr.indexOf('"', 1)
    expr = end === -1 ? expr.slice(1) : expr.slice(1, end)
  } else {
    expr = expr.replace(/\s+#.*$/, '').trim()
  }
  ;(isComment ? commented : active).push({ line: i + 1, expr })
}

/** 与 cordis 一致的环境：ESM 模块作用域，**没有 require** */
function evalLikeCordis(expr) {
  const fn = new Function(`"use strict"; return (${expr});`)
  return fn()
}

let bad = 0
console.log(`📄 ${file}`)
console.log(`   生效的 !!js 表达式：${active.length} 个` + (commented.length ? `（另有 ${commented.length} 个被注释，不检查）` : '') + '\n')

if (!active.length) {
  console.log('✅ 没有生效的 !!js 表达式 —— 这个文件不会因为表达式而炸。')
} else {
  for (const { line, expr } of active) {
    const short = expr.length > 70 ? expr.slice(0, 70) + '…' : expr
    try {
      const val = evalLikeCordis(expr)
      const shown = typeof val === 'string' ? `"${val}"` : JSON.stringify(val)
      console.log(`  ✅ L${line}  ${short}`)
      console.log(`        ⇒ ${shown}`)
    } catch (e) {
      bad++
      console.log(`  ❌ L${line}  ${short}`)
      console.log(`        ⇒ ${e.message}`)
      if (/require is not defined/i.test(e.message)) {
        console.log('        ⇒ **这就是会让整棵插件树加载失败的那一行**：cordis 的 eval 环境没有 require。')
        console.log('          改成只用全局变量，例如：process.env.USERPROFILE + "/.dsh/xxx"')
      }
    }
  }
}

if (bad) {
  console.log(`\n❌ ${bad} 个表达式会炸 —— **先修好再重启 DSH**（否则 GUI 起不来）。`)
  process.exit(1)
}
console.log('\n✅ 全部能求值。注意：这只保证"配置表达式"没问题，不保证插件 apply 不报错。')
