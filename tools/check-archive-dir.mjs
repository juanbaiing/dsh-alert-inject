/**
 * check-archive-dir.mjs —— 证明档案目录**能从配置文件读**，且优先级正确。
 *
 * ⚠️ 为什么必须有（这条的功能就是"不依赖环境变量继承"）：
 *   实测背景：作者用 `setx` 设了 `DSH_ALERT_ARCHIVE_DIR`、重启了 DSH，
 *   而**档案检索仍然"没测"** —— 因为用户级环境变量的更新**只对新生 explorer 起的进程生效**，
 *   桌面快捷方式启动的 DSH 继承的是**旧环境**。
 *   ⇒ 所以"能不能从配置文件读"必须被单独证明，它是这条路唯一的立足点。
 *
 * ⚠️ 隔离：`DSH_ALERT_CONFIG` 指向临时文件 ⇒ **不动作者真实的 `~/.dsh/alert-inject.json`**。
 * 用法：`node tools/check-archive-dir.mjs`（退出码非 0 = 有问题）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-archdir-'))
const cfgFile = path.join(tmpDir, 'alert-inject.json')
process.env.DSH_ALERT_CONFIG = cfgFile
delete process.env.DSH_ALERT_ARCHIVE_DIR          // 先确保环境变量这一层是空的

const LIB = new URL('../lib/', import.meta.url).href
const { archiveDir, archiveStatus } = await import(LIB + 'archive.js')

const fails = []
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✅ ' + label + (extra ? '　' + extra : ''))
  else { console.log('  ❌ ' + label + (extra ? '　' + extra : '')); fails.push(label) }
}

console.log('══════ 档案目录配置检查 ══════\n')

// 造一个真的存在、可读的档案目录（含一个 .md，让 walkDocs 有东西）
const docs = path.join(tmpDir, 'docs')
fs.mkdirSync(docs, { recursive: true })
fs.writeFileSync(path.join(docs, 'a.md'), '# 测试标题\n\n一些内容。\n', 'utf8')

// ── ① 什么都不配 ──
fs.writeFileSync(cfgFile, JSON.stringify({}), 'utf8')
let r = archiveDir()
ok(r.dir === '', '① 都没配 ⇒ 目录为空（不是静默当"没有档案"）', r.why)
ok(archiveStatus().state === 'unconfigured', '① archiveStatus 报 unconfigured')
ok(String(archiveStatus().why).includes('没有配置档案目录'), '① why 里明说"没配"', String(archiveStatus().why).slice(0, 60))

// ── ② 只写配置文件 ⇒ **这是本条要证明的路** ──
fs.writeFileSync(cfgFile, JSON.stringify({ archiveDir: docs, _pad: 'x' }), 'utf8')
r = archiveDir()
ok(r.dir === docs, '② 只靠**配置文件**就能配好（不依赖环境变量继承）', r.why)
ok(String(r.why).includes('配置文件'), '② why 说明了来源是配置文件')
ok(archiveStatus().state === 'ok', '② archiveStatus 报 ok', archiveStatus().dir)

// ── ③ 环境变量与配置文件都有 ⇒ 环境变量优先（向后兼容）──
process.env.DSH_ALERT_ARCHIVE_DIR = path.join(tmpDir, 'from-env')
fs.mkdirSync(process.env.DSH_ALERT_ARCHIVE_DIR, { recursive: true })
fs.writeFileSync(cfgFile, JSON.stringify({ archiveDir: docs, _pad: 'xy' }), 'utf8')
r = archiveDir()
ok(r.dir === process.env.DSH_ALERT_ARCHIVE_DIR, '③ 环境变量优先于配置文件（向后兼容）', r.why)
ok(String(r.why).includes('环境变量'), '③ why 说明了来源是环境变量')
delete process.env.DSH_ALERT_ARCHIVE_DIR

// ── ④ 配置里指向一个不存在的目录 ⇒ 必须报 unreadable（不能静默）──
fs.writeFileSync(cfgFile, JSON.stringify({ archiveDir: path.join(tmpDir, '不存在'), _pad: 'xyz' }), 'utf8')
const st4 = archiveStatus()
ok(st4.state === 'unreadable', '④ 目录不存在 ⇒ unreadable（**坏掉要出声**）', st4.state)

// ── ⑤ 配置改回可用 ⇒ 立刻生效（不重启）──
fs.writeFileSync(cfgFile, JSON.stringify({ archiveDir: docs, _pad: 'xyz1' }), 'utf8')
ok(archiveStatus().state === 'ok', '⑤ 改配置文件**立刻生效**（mtime 缓存），不用重启')

fs.rmSync(tmpDir, { recursive: true, force: true })

console.log('\n══════ 结论 ══════')
if (fails.length) {
  console.log('❌ ' + fails.length + ' 项没过：' + fails.join('；'))
  process.exit(1)
}
console.log('✅ 档案目录可从配置文件读、优先级正确、坏路径会出声、改配置即刻生效。')
console.log('   （⚠️ 它证明不了"DSH 重启后真的会读这个文件" —— 那要在真实运行里看体检变绿。）')
