#!/usr/bin/env node
/**
 * 验证「**设定档 .js 能被档案检索正确读成块**」+「切块规则版本能作废旧索引」。
 *
 * ══ 为什么需要这个检查（两次真实代价）══════════════════════════════════
 *
 *  ① **设定档读不进来**：`ARCHIVE_OPTS.exts` 原来只有 `.md`/`.txt`，
 *     而作者的设定档是 `.js` 模块（`{title,intro[],sections[{h1,blocks}]}`）⇒
 *     档案检索**从来没覆盖过设定**，而输出只会说「没找到」——
 *     「没找到」与「我没在找」是两回事（硬规则 1）。
 *
 *  ② **档名不在检索文本里**：设定档（尤其人物档）正文通篇用「她」指称本体，
 *     档名只出现在标题行；而 `chunkMarkdown` 把标题行当分隔符丢掉，只留作 `title` 字段
 *     ⇒ **该档每一块正文都不含档名** ⇒ 查「依诗是谁」命不中 `人物/依诗.js`。
 *     实测就是这个症状（6/7 用例通过，唯一失败的就是它）。
 *
 *  ③ **规则改了不起作用**：只改切块规则、不碰档案 ⇒ `dirStamp` 指纹不变
 *     ⇒ 旧索引被判为最新 ⇒ 输出 `reused: true`、耗时 0 秒，**修复被静默吞掉**，
 *     而报告照样说「索引覆盖 100%」。
 *     ⇒ 加 `ARCHIVE_OPTS.indexRev`，并在 `readCachedIndex` / `ensureArchiveIndex` 里先比它。
 *
 * ⚠️ 判据全部**可核对**：这个脚本自己造fixture，不依赖作者的项目目录，
 *    任何下载者跑一遍都能得到同样的结论。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ARCHIVE_OPTS, readChunks, chunkMarkdown, readCachedIndex, cachePathFor,
} from '../lib/archive.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅ ' + msg) } else { fail++; console.log('  ❌ ' + msg) } }

// ── fixture：两个设定档（一个人物档通篇用「她」）+ 一个 md ──────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-setting-'))
const mk = (rel, body) => {
  const p = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body, 'utf8')
}

mk('人物/依诗.js', `const doc = {
  title: '依诗',
  intro: [
    '信息残片，已整理',
    'NOTE:【启记】她留下的东西是碎的。',
  ],
  sections: [
    { h1: '一、本相', blocks: [ { lines: [
      '【本体】意识本身。',
      '【形质】她并非出生，而是大范围灰线超过浓度后向内坍缩而成。',
    ] } ] },
    { h1: '二、来历', blocks: [ { lines: [
      '【源头】与灰线织物同一机制，只是规模大到产生了意识。',
    ] } ] },
  ],
}
module.exports = { doc }
`)

mk('世界·概念/灰线织物/名录/域锚.js', `const doc = {
  title: '域锚',
  intro: ['（启 归档）'],
  sections: [ { h1: '一、它是什么', blocks: [ { lines: [
    '【作用】把一个区域固定在某个状态上。',
    '【代价】锚越久，解构越难。',
  ] } ] } ],
}
module.exports = { doc }
`)

mk('笔记.md', '# 一条教训\n\n## 小节\n\n这是 markdown 正文，不该被冠档名。\n')

console.log('fixture: ' + tmp)
console.log('')

// ── ① .js 在后缀清单里 ────────────────────────────────────────────────
console.log('① 后缀清单')
ok(ARCHIVE_OPTS.exts.includes('.js'), '`.js` 已进 ARCHIVE_OPTS.exts')
ok(ARCHIVE_OPTS.exts.includes('.md'), '`.md` 仍在（教训库没被挤掉）')

// ── ② readChunks 能读设定档 ───────────────────────────────────────────
console.log('')
console.log('② 读设定档')
const r = readChunks(tmp, { onLog: (m) => console.log('  [log] ' + m) })
ok(r.files === 3, `walkDocs 找到 3 个文件（实际 ${r.files}）`)
ok(r.jsParsed === 2, `2 个 .js 按结构解析（实际 ${r.jsParsed}）`)
ok(r.jsFallback.length === 0, `没有解析失败退化的（实际 ${r.jsFallback.length}）`)
ok(r.failed === 0, `没有读不动的文件（实际 ${r.failed}）`)
ok(r.total > 3, `切出了多块（实际 ${r.total}）`)

// ── ③ 语法噪音为 0 ────────────────────────────────────────────────────
console.log('')
console.log('③ 正文不该含代码骨架')
const NOISE = ['const doc', 'module.exports', 'sections:', 'blocks:', 'require(']
const noise = r.chunks.filter((c) => NOISE.some((n) => c.text.includes(n)))
ok(noise.length === 0, `语法噪音块数为 0（实际 ${noise.length}）`)

// ── ④ 档名进正文（这是"依诗"能被查到的唯一原因）────────────────────────
console.log('')
console.log('④ 档名冠进每块正文')
const yishi = r.chunks.filter((c) => c.file.includes('依诗'))
ok(yishi.length > 0, `依诗档被切成块（实际 ${yishi.length} 块）`)
const yishiNamed = yishi.filter((c) => c.text.includes('依诗'))
ok(yishiNamed.length === yishi.length,
  `依诗档**每一块**正文都含「依诗」（${yishiNamed.length}/${yishi.length}）`)
// 正文本身确实不含档名（证明前缀是必要的，不是凑巧）
const rawNoName = yishi.filter((c) => !c.text.replace(/^依诗｜/, '').includes('依诗'))
ok(rawNoName.length === yishi.length,
  `去掉前缀后正文**都不含**「依诗」（${rawNoName.length}/${yishi.length}）⇒ 前缀不是冗余`)

// ── ⑤ md 不被冠档名 ──────────────────────────────────────────────────
console.log('')
console.log('⑤ `.md` 不冠档名（教训库标题不是实体名）')
const mdChunks = r.chunks.filter((c) => c.file.endsWith('.md'))
ok(mdChunks.length > 0, `md 也被读到了（${mdChunks.length} 块）`)
ok(mdChunks.every((c) => !c.text.startsWith('一条教训｜')), 'md 块正文没有被冠档名')

// ── ⑥ 规则版本能作废旧索引（这是 §六 那句话的落地）─────────────────────
console.log('')
console.log('⑥ 切块规则版本')
ok(typeof ARCHIVE_OPTS.indexRev === 'number' && ARCHIVE_OPTS.indexRev >= 2,
  `indexRev 是数字且 ≥ 2（实际 ${ARCHIVE_OPTS.indexRev}）`)

const oldCacheDir = ARCHIVE_OPTS.cacheDir
const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-archcache-'))
ARCHIVE_OPTS.cacheDir = tmpCache        // 别写到真实缓存目录
try {
  const cf = cachePathFor(tmp)
  const fake = {
    version: 1, kind: 'archive', dir: tmp, rev: 1,      // ← 旧规则版本
    entries: [{ file: 'x.md', line: 1, title: 'x', snip: 'x' }],
    vecs: [[0.1, 0.2]],
    stats: { files: 1, filesCovered: 1, chunks: 1, total: 1, skipped: 0, coverage: 1, failed: 0 },
    stamp: null,
  }
  fs.mkdirSync(tmpCache, { recursive: true })
  fs.writeFileSync(cf, JSON.stringify(fake), 'utf8')
  const got = readCachedIndex(tmp)
  ok(got.state === 'building', `旧 rev 的索引被判为需要重建（state=${got.state}）`)
  ok(got.revMismatch === true, '并且标了 revMismatch')
  ok(/rev/.test(got.why || ''), `理由里说清了 rev（${got.why}）`)

  // 把 rev 改成当前值 ⇒ 应被接受（只是 stamp 不对，会标 stale，但不再判"没就绪"）
  fake.rev = ARCHIVE_OPTS.indexRev
  fs.writeFileSync(cf, JSON.stringify(fake), 'utf8')
  const got2 = readCachedIndex(tmp)
  ok(got2.state === 'ok', `当前 rev 的索引被接受（state=${got2.state}）`)
} finally {
  ARCHIVE_OPTS.cacheDir = oldCacheDir
  fs.rmSync(tmpCache, { recursive: true, force: true })
}

// ── ⑦ 解析失败要留痕（不能静默当没这个文件）───────────────────────────
console.log('')
console.log('⑦ 坏档要留痕')
fs.writeFileSync(path.join(tmp, '坏的.js'), 'this is not a setting doc at all\n', 'utf8')
const r2 = readChunks(tmp, {})
ok(r2.jsFallback.some((f) => f.includes('坏的.js')),
  `解析失败的文件被记进 jsFallback（${JSON.stringify(r2.jsFallback)}）`)
ok(r2.total > 0, `旁边的好档照样被读（${r2.total} 块）`)

fs.rmSync(tmp, { recursive: true, force: true })

console.log('')
console.log(`=== ${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
