/**
 * audit-wiring.mjs — 【接线审计】：**哪些导出真的有人在用？**
 *
 * ══ 为什么需要它（2026-10-16 实测起因）══════════════════════════
 *   接手时发现 `lib/context.js`（**420 行**）的四个导出
 *   `normalizeSession` / `loadContext` / `contextStatus` / `contextFile`
 *   —— **全部只有定义、没有任何调用点**。**一整块孤岛**，
 *   而它一直被当成「✅ 已做」的功能写在交接文档里。
 *
 *   ⇒ 这是 §238 那句的原样重演：
 *     「**凡声称"已实现"，先 grep 调用点；没有调用点 ＝ 没有实现。**」
 *   ⇒ 故本工具把这件事**变成一条命令可复现**，而不是靠人工撞见。
 *
 * ══ 它怎么做（不是"逐个 grep"，是【可达性分析】）══════════════
 *   ① 收集所有 `*.js` / `*.mjs`
 *   ② 从**真入口**出发（DSH 插件入口 `lib/index.js`、所有 `tools/*.mjs`、`selftest.mjs`）
 *   ③ 沿 `import ... from '...'` 与**动态** `import('...')` 双向遍历
 *   ④ **走不到的模块 ＝ 孤岛**
 *   ⇒ 这样就避免了"被孤岛 import 的东西也算接线了"这种假阴性。
 *
 * ⚠️ 本工具**只读**：不改任何文件、不写任何数据。
 * 用法：`node tools/audit-wiring.mjs`
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 真入口：插件挂载点 + 全部 CLI + 自测 */
const ENTRIES = [
  path.join(ROOT, 'lib', 'index.js'),   // DSH 插件挂载点
  // ⚠️ 根目录下**所有顶层执行的 .mjs** 也算入口（`selftest.mjs`、`leak-check.mjs` …）。
  //    第一版只写了 selftest ⇒ 把 `leak-check.mjs` 误报成"孤岛"（实测抓到，已修）。
  ...fs.readdirSync(ROOT).filter((f) => f.endsWith('.mjs')).map((f) => path.join(ROOT, f)),
  ...fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(ROOT, 'tools', f)),
].filter((f) => fs.existsSync(f))

function allSources() {
  const out = []
  for (const d of ['lib', 'tools', '.']) {
    const dir = d === '.' ? ROOT : path.join(ROOT, d)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(m?js)$/.test(f)) continue
      const p = path.join(dir, f)
      if (fs.statSync(p).isFile()) out.push(p)
    }
  }
  return [...new Set(out)]
}

const IMPORT_RE = [
  /from\s+['"](\.[^'"]+)['"]/g,             // import/export ... from './x.js'
  /import\(\s*['"](\.[^'"]+)['"]\s*\)/g,    // import('./x.js')
]
const EXPORT_RE = [
  /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm,
  /^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm,
  /^export\s*\{([^}]+)\}/gm,
]

const src = fs.readFileSync
const info = new Map()   // file → { imports:Set, exports:[names] }

for (const f of allSources()) {
  const t = src(f, 'utf8')
  const imports = new Set()
  for (const re of IMPORT_RE) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(t))) {
      const resolved = path.resolve(path.dirname(f), m[1])
      if (fs.existsSync(resolved)) imports.add(resolved)
    }
  }
  const exports = new Set()
  for (const re of EXPORT_RE) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(t))) {
      if (re.source.startsWith('^export\\s*\\{')) {
        for (const part of m[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/)[0].trim()
          if (name) exports.add(name)
        }
      } else if (m[1]) exports.add(m[1])
    }
  }
  info.set(f, { imports, exports: [...exports] })
}

// ── 可达性（BFS）──
const reachable = new Set()
const queue = [...ENTRIES]
while (queue.length) {
  const f = queue.shift()
  if (reachable.has(f)) continue
  reachable.add(f)
  for (const dep of info.get(f)?.imports ?? []) queue.push(dep)
}

const islands = [...info.keys()].filter((f) => !reachable.has(f)).sort()
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')

console.log('══════════════════════════════════════════════════════════')
console.log('  接线审计：哪些导出真的有人在用')
console.log('══════════════════════════════════════════════════════════')
console.log('')
console.log(`入口 ${ENTRIES.length} 个 → 可达 ${reachable.size} 个模块 ／ 全部 ${info.size} 个`)

if (!islands.length) {
  console.log('')
  console.log('✅ 没有孤岛：每个源文件都能从入口走到。')
} else {
  console.log('')
  console.log(`⚠️ **孤岛 ${islands.length} 个**（从入口走不到 ⇒ 里面的一切等于"没有实现"）`)
  for (const f of islands) {
    const ex = info.get(f).exports
    const importedBy = [...info.entries()].filter(([, v]) => v.imports.has(f)).map(([k]) => rel(k))
    console.log('')
    console.log(`  ⚠️ ${rel(f)}   导出 ${ex.length} 个`)
    console.log(`     被谁 import：${importedBy.length ? importedBy.join('、') : '**没有人**'}`)
    if (ex.length) console.log(`     导出名：${ex.join(' / ')}`)
  }
}

// ── 更细一级：可达模块里"导出但没人引用"的名字（初筛，可能同名误报）──
if (process.argv.includes('--names')) {
console.log('')
console.log('── 疑似"导出了但没人用"的名字（字符串初筛，可能有同名误报）──')
const allText = new Map(allSources().map((f) => [f, src(f, 'utf8')]))
let suspect = 0
for (const f of [...reachable].sort()) {
  const ex = info.get(f)?.exports ?? []
  const unused = ex.filter((name) => {
    if (['name', 'inject', 'apply'].includes(name)) return false      // 插件入口契约，DSH 会调用
    for (const [other, t] of allText) {
      if (other === f) continue
      if (new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(t)) return false
    }
    return true
  })
  if (unused.length) {
    suspect += unused.length
    console.log(`  ${rel(f)}：${unused.join(' / ')}`)
  }
}
if (!suspect) console.log('  （无）')
}

console.log('')
console.log('【你怎么自己确认】')
console.log('  · 随便挑上面列出的一个文件名，在项目里搜它 —— 应当搜不到任何 import')
console.log('  · 或者反过来：随便挑一个功能，问「谁在调它」，答不上来就该出现在上面的清单里')
console.log('⚠️ 孤岛 ≠ 该删。也可能是"写好了但还没接线"（本项目的 `context.js` 就属于这种）。')
console.log('   本工具只负责**让它现形**，决定留给作者。')
console.log('══════════════════════════════════════════════════════════')

process.exit(islands.length ? 1 : 0)
