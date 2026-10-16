/**
 * 临时自检：界面代码里引用的每个东西是否都存在。
 * ① 每个 t('xxx') 的 key 在 zh 字典里有没有（缺了 ⇒ 屏幕上是空白）
 * ② 每个 className 的 ap-* 在 style 里有没有定义（缺了 ⇒ 排版崩）
 * ③ ContextSection 有没有被引用、有没有定义
 */
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── 找出字典 zh 的 key ──
const zhBlock = src.slice(src.indexOf('const zh = {'), src.indexOf('const en = {'))
const zhKeys = new Set(Array.from(zhBlock.matchAll(/^\s*(\w+):/gm)).map((m) => m[1]))
console.log('zh 字典 key 数: ' + zhKeys.size)

// ── 找出所有 t('xxx') 用法 ──
const used = Array.from(src.matchAll(/\bt\(\s*'([A-Za-z_][\w]*)'\s*\)/g)).map((m) => m[1])
const usedSet = new Set(used)
console.log('t() 用到的 key 数: ' + usedSet.size)

const missing = Array.from(usedSet).filter((k) => !zhKeys.has(k))
console.log('\n① 字典缺 key: ' + (missing.length ? missing.join(', ') : '无 ✅'))

// ── 未被用到的 key（不是错误，只是提示）──
const unused = Array.from(zhKeys).filter((k) => !usedSet.has(k))
console.log('   （未用到的 key ' + unused.length + ' 个，可接受）')

// ── className 检查 ──
const styleBlock = src.slice(src.indexOf('const style = ['), src.indexOf('function AlertInjectTab'))
const defined = new Set(Array.from(styleBlock.matchAll(/\.(ap-[\w-]+)/g)).map((m) => m[1]))
const usedCls = new Set(Array.from(src.matchAll(/className:\s*'([^']+)'/g)).flatMap((m) => m[1].split(/\s+/)).filter((c) => c.startsWith('ap-')))
console.log('\n② 样式里定义的类: ' + defined.size + '　代码里用到的类: ' + usedCls.size)
const clsMissing = Array.from(usedCls).filter((c) => !defined.has(c))
console.log('   用而未定义的类: ' + (clsMissing.length ? clsMissing.join(', ') : '无 ✅'))

// ── ContextSection 引用完整性 ──
const hasDef = src.indexOf('function ContextSection(') !== -1
const useCount = (src.match(/ContextSection/g) || []).length
console.log('\n③ ContextSection: 定义=' + hasDef + '  出现次数=' + useCount + '（≥2 才说明既定义又被用）')
console.log('   挂在主组件里: ' + (src.indexOf('React.createElement(ContextSection') !== -1 ? '✅' : '❌'))

// ── 检查有没有"注释吃代码"的老毛病 ──
const badLines = []
src.split('\n').forEach((l, i) => {
  if (/^\s*\/\/.*React\.createElement/.test(l) && !/^\s*\/\/\s*──/.test(l)) badLines.push(i + 1)
})
console.log('\n④ 疑似"注释吃代码"的行: ' + (badLines.length ? badLines.join(', ') : '无 ✅'))

const bad = missing.length || clsMissing.length || !hasDef
console.log('\n' + (bad ? '❌ 有问题' : '✅ 引用完整性检查通过'))
process.exit(bad ? 1 : 0)
