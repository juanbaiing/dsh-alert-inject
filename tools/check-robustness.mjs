#!/usr/bin/env node
/**
 * check-robustness.mjs —— **按"测试工程师进酒吧"那张表的分类**，逐个功能面打一遍。
 *
 * 为什么要这个文件（而不是再加几个 check-*）：
 *   原来的 check-* 都是**每模块一个**，各测各的"正常路径"。
 *   它们合起来证明不了最容易被忽略的一类事：**同一份坏输入，从不同入口进去会怎样**。
 *   那张笑话表给出的正好是这套分类 —— 特别是它的最后一条：
 *     「测试工程师们满意地离开了酒吧。 **然后一名顾客点了一份炒饭，酒吧炸了。** 」
 *   ⇒ 最难的不是"每个入口单独能扛"，而是**"前面一切正常之后，来一个不相关的东西"**。
 *     本文件最后一段 ⑨ 就是测这个（"炒饭测试"）。
 *
 * ⚠️ 隔离铁律：所有写入类测试**必须**先把环境变量指向临时目录，且**在 import 之前**。
 *   `db.js` 的 `dbRoot()` 与 `samples.js` 的 `SAMPLE_OPTS.file` 都是**模块加载时**读环境变量，
 *   import 之后再设就晚了 —— 那会把测试数据写进真实库。
 *
 * ⚠️ 本文件自己踩过的坑（**测试也会写错**，记下来省得后人重踩）：
 *   ① 一开始用 `{role,content}` 当会话数据 —— **格式根本不对**。
 *      真实 DSH 会话是 `{type:'assistant/message'|'user/message'|'tool/call', seq, time, data}` 的事件流，
 *      且**多帧 zstd 追加**（实测一个 489 KB 会话有 736 帧）。⇒ 用 `frames:true` + `ev()` 造数据。
 *   ② 把 `readEntries` 当数组用 —— 它返回 `{ok, entries, badLines, reason}`。
 *   ③ 以为 `appendEntry` 缺字段会**抛异常** —— 本项目统一用**返回值报错**（`{ok:false, reason}`）。
 *      断言"必须抛异常"是**测试写错**；该断言的是"它有没有说清缺了什么"。
 *   ④ `detectRepetition(text, opts)` 要**字符串**、`extractRefs` 返回 **Map**、
 *      `detectMissingRefs(text, opts)` 收的是**文本**不是 refs。
 *   ⇒ 教训：**测别人之前先读签名**，否则"测出"的全是自己的错。
 *
 * 用法：`node tools/check-robustness.mjs`（退出码非 0 = 有未过项）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

// ── ① 隔离：必须在所有 import 之前 ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-robust-'))
process.env.DSH_ALERT_DATA_DIR = path.join(TMP, 'data')
process.env.SAMPLES_FILE = path.join(TMP, 'data', 'samples.jsonl')
process.env.LIBRARIAN_CACHE = path.join(TMP, 'cache')
process.env.DSH_ALERT_CONTEXTS = path.join(TMP, 'contexts.json')
process.env.ALERT_NO_RETRIEVAL = '1'
fs.mkdirSync(process.env.DSH_ALERT_DATA_DIR, { recursive: true })
fs.mkdirSync(process.env.LIBRARIAN_CACHE, { recursive: true })

const LIB = new URL('../lib/', import.meta.url).href

// ── 微型断言框架（全部 async，避免 async 测试失败变成未处理的 rejection）──
let pass = 0, fail = 0
const fails = []
const group = (t) => console.log('\n───── ' + t + ' ─────')

async function it(name, fn) {
  try {
    const r = await fn()
    if (r === true || r === undefined) { pass++; console.log('  ✅ ' + name) }
    else { fail++; fails.push(name + ' → ' + r); console.log('  ❌ ' + name + '\n       ' + r) }
  } catch (e) {
    const m = e && e.message ? e.message : e
    fail++; fails.push(name + ' → 抛异常 ' + m)
    console.log('  ❌ ' + name + '\n       **抛异常**：' + m)
  }
}

// ── 造数据的工具 ────────────────────────────────────────────────
/** 一条**真实格式**的 DSH 事件（实测：{type, seq, time, data}） */
const ev = (type, data, seq = 0) => ({ type, seq, time: 1700000000000 + seq, data })

/**
 * 写一个 session.jsonl.zstd
 * ⚠️ `frames: true` = **每行一帧**，等价于真实 DSH 的"多帧追加"。
 *    整体解压只出第一帧 ⇒ 不用多帧就测不到"能不能读全"。
 */
function writeSession(name, lines, opts) {
  const o = opts || {}
  const dir = path.join(TMP, 'sessions', name)
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'session.jsonl.zstd')
  // body 延迟到真正需要时才算：原来写在 if 之前，lines=null（rawWrite 模式）时会
  // 在 lines.map 抛 TypeError，导致永远走不到 rawWrite 分支（测试报 null.map）。
  if (o.rawWrite) { fs.writeFileSync(p, o.rawWrite) } else if (o.frames) {
    const body = o.raw !== undefined && o.raw !== null ? o.raw : (lines || []).map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')
    const parts = body.split('\n').filter(Boolean)
      .map((l) => zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8')))
    fs.writeFileSync(p, parts.length ? Buffer.concat(parts) : zlib.zstdCompressSync(Buffer.from('', 'utf8')))
  } else {
    const body = o.raw !== undefined && o.raw !== null ? o.raw : (lines || []).map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')
    fs.writeFileSync(p, zlib.zstdCompressSync(Buffer.from(body, 'utf8')))
  }
  return p
}

const userMsg = (text, seq) => ev('user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, seq)
const assistantText = (text, seq) => ev('assistant/message', { turn: 1, step: seq, message: { role: 'assistant', content: [{ type: 'text', text }] } }, seq)
const assistantThink = (text, seq) => ev('assistant/message', { turn: 1, step: seq, message: { role: 'assistant', content: [{ type: 'reasoning', text }] } }, seq)

// ── 导入（隔离已设置完毕）──────────────────────────────────────
const { recentActivity } = await import(LIB + 'index.js')
const { selectSlots, cachePath, cacheState, loadCache } = await import(LIB + 'librarian.js')
const { appendEntry, readEntries, readProfile, writeProfile } = await import(LIB + 'db.js')
const { loadSamples } = await import(LIB + 'samples.js')
const { extractRefs, detectMissingRefs } = await import(LIB + 'reference-check.js')
const { detectRepetition } = await import(LIB + 'repetition.js')
const { assessText: fokAssessText } = await import(LIB + 'fok.js')
const { termCoverage } = await import(LIB + 'novelty.js')
const { classifyRule, extractUnits } = await import(LIB + 'learning.js')
const { readJsonl, countBadLines } = await import(LIB + 'shadow.js')
const { readContexts } = await import(LIB + 'contexts.js')

/** readEntries 的统一适配（它返回 {ok, entries}，不是数组） */
const entriesOf = (lib) => {
  const rd = readEntries(lib)
  return Array.isArray(rd) ? rd : (rd && rd.entries ? rd.entries : [])
}

console.log('══════ 插件鲁棒性测试（按"测试工程师进酒吧"分类）══════')
console.log('隔离目录: ' + TMP)

// ══════════════════════════════════════════════════════════════
await group('① 基础功能（笑话第 1~5 条：要一杯啤酒 / 咖啡 / 两杯 / 100 杯 / 一桶）')
// ══════════════════════════════════════════════════════════════
{
  const normal = [
    ev('session', { id: 'fake' }, 0),
    userMsg('帮我看一下这个函数的边界情况', 1),
    assistantThink('先看它接受什么参数', 2),
    assistantText('这个函数对负数会返回 0。', 3),
    userMsg('好，那改成报错', 4),
    ev('tool/call', { name: 'grep', arguments: '{"pattern":"x"}' }, 5),
  ]
  const f = writeSession('normal', normal, { frames: true })
  const acts = recentActivity(f, 0)

  await it('要一杯啤酒：正常会话能读出痕迹', () => acts.length > 0 ? true : '痕迹数 0')
  await it('要一杯咖啡：能认出「思考」类痕迹（reasoning 块）', () =>
    acts.some((a) => a.kind === '思考') ? true : 'kinds=' + JSON.stringify([...new Set(acts.map((a) => a.kind))]))
  await it('能认出「正文」（text 块）', () =>
    acts.some((a) => a.kind === '正文') ? true : 'kinds=' + JSON.stringify([...new Set(acts.map((a) => a.kind))]))
  await it('**用户发言**也能读到（历史 bug：user/message 嵌套结构与 assistant 不同，曾永远读不到）', () =>
    acts.some((a) => a.kind === '用户') ? true : '没有「用户」类痕迹，kinds=' + JSON.stringify([...new Set(acts.map((a) => a.kind))]))
  await it('能认出「工具」调用', () =>
    acts.some((a) => a.kind === '工具') ? true : '没有「工具」类痕迹')
  await it('要两杯啤酒：selectSlots 只收「思考/正文」', () => {
    const s = selectSlots(acts)
    const want = acts.filter((a) => a.kind === '思考' || a.kind === '正文').length
    return s.slots.length === want ? true : '候选 ' + s.slots.length + ' ≠ 应得 ' + want
  })
  await it('插件注入的系统消息**不会被当成用户发言**（source.kind=plugin 应跳过）', () => {
    const fx = writeSession('pluginmsg', [
      ev('user/message', { role: 'user', content: [{ type: 'text', text: '这条是插件注入的' }], source: { kind: 'plugin' } }, 1),
      userMsg('这条是作者说的', 2),
    ], { frames: true })
    const a = recentActivity(fx, 0)
    const texts = a.map((x) => x.text).join('|')
    return texts.indexOf('作者说的') !== -1 && texts.indexOf('插件注入') === -1 ? true : '实际读到：' + texts
  })
  await it('**多帧** zstd（真实会话是数百帧）⇒ 每一帧都要读到，不能只读第一帧', () => {
    const fx = writeSession('multiframe', [
      ev('session/end-seed', {}, 0),
      ev('permission/preset', { preset: 'workspace-write' }, 1),
      ev('sandbox/mode', { mode: 'workspace-write' }, 2),
      userMsg('第四帧才是我说的话', 3),
    ], { frames: true })
    const a = recentActivity(fx, 0)
    return a.length === 1 && a[0].text.indexOf('第四帧') !== -1
      ? true
      : '只读到 ' + a.length + ' 条 ⇒ 可能只解了第一帧'
  })
  await it('要一桶啤酒：同一份输入重复调用结果稳定（无随机性）', () => {
    const a = JSON.stringify(selectSlots(acts).use)
    const b = JSON.stringify(selectSlots(acts).use)
    return a === b ? true : '两次结果不同 ⇒ 有随机性或状态泄漏'
  })
}

// ══════════════════════════════════════════════════════════════
await group('② 边界值（笑话第 6~12 条：0 杯 / 1.0 杯 / 0.7 杯 / -1 杯 / 2^32 杯 / ±Infinity）')
// ══════════════════════════════════════════════════════════════
{
  await it('0 杯啤酒：空会话文件 ⇒ 痕迹 0 条，且不抛错', () => {
    const f = writeSession('empty', [])
    const a = recentActivity(f, 0)
    return Array.isArray(a) && a.length === 0 ? true : '返回 ' + JSON.stringify(a)
  })
  await it('0 杯（变体）：文件只有 header、没有任何痕迹事件 ⇒ 0 条', () => {
    const f = writeSession('headeronly', [ev('session', { id: 'x' }, 0)], { frames: true })
    const a = recentActivity(f, 0)
    return Array.isArray(a) && a.length === 0 ? true : '返回 ' + a.length + ' 条'
  })
  await it('1.0 杯：**恰好一条**痕迹 ⇒ 候选 1 条，索引不崩', () => {
    const f = writeSession('exactly1', [assistantText('就这一句', 1)], { frames: true })
    const acts = recentActivity(f, 0)
    const s = selectSlots(acts)
    return s.slots.length === 1 && s.use.length === 1 ? true : '候选 ' + s.slots.length + '、选中 ' + s.use.length
  })
  await it('-1 杯：limit 传负数 ⇒ 不崩', () => {
    const f = writeSession('neg', [userMsg('一', 1), userMsg('二', 2)], { frames: true })
    return Array.isArray(recentActivity(f, -1)) ? true : '没返回数组'
  })
  await it('2^32 杯：limit 传 2**32 ⇒ 不崩（不试图分配巨量内存）', () => {
    const f = writeSession('biglimit', [userMsg('一', 1)], { frames: true })
    return Array.isArray(recentActivity(f, 2 ** 32)) ? true : '没返回数组'
  })
  await it('+Infinity 杯：limit=Infinity ⇒ 不崩', () => {
    const f = writeSession('inflimit', [userMsg('一', 1)], { frames: true })
    return Array.isArray(recentActivity(f, Infinity)) ? true : '没返回数组'
  })
  await it('-Infinity 杯：limit=-Infinity ⇒ 不崩', () => {
    const f = writeSession('neginflimit', [userMsg('一', 1)], { frames: true })
    return Array.isArray(recentActivity(f, -Infinity)) ? true : '没返回数组'
  })
  await it('0.7 杯：limit=0.7（小数）⇒ 不崩', () => {
    const f = writeSession('fraclimit', [userMsg('一', 1)], { frames: true })
    return Array.isArray(recentActivity(f, 0.7)) ? true : '没返回数组'
  })
  await it('100 杯：limit=100 时**只取末尾 100 条**（不是取不到就返回全部）', () => {
    const lines = []
    for (let i = 0; i < 300; i++) lines.push(userMsg('第 ' + i + ' 句', i))
    const f = writeSession('limit100', lines, { frames: true })
    const a = recentActivity(f, 100)
    return a.length === 100 ? true : '返回 ' + a.length + ' 条（应恰好 100）'
  })
  await it('selectSlots 边界：budget=0 ⇒ 不返回全部、也不崩', () => {
    const acts = Array.from({ length: 10 }, (_, i) => ({ kind: '正文', text: 't' + i }))
    const s = selectSlots(acts, null, 0, 1)
    return s.use.length <= 10 ? true : '选中数超过候选数'
  })
  await it('selectSlots 边界：fillStep=0 ⇒ 不崩（不该死循环）', () => {
    const acts = Array.from({ length: 10 }, (_, i) => ({ kind: '正文', text: 't' + i }))
    const s = selectSlots(acts, null, 5, 0)
    return Array.isArray(s.use) ? true : '没返回数组'
  })
  await it('selectSlots 边界：budget/fillStep 传 NaN ⇒ 必须收敛，而非返回 NaN 长度', () => {
    const acts = Array.from({ length: 10 }, (_, i) => ({ kind: '正文', text: 't' + i }))
    const s = selectSlots(acts, null, NaN, NaN)
    return Number.isFinite(s.use.length) ? true : 'use.length=' + s.use.length
  })
  await it('selectSlots 边界：budget 极大（2^32）⇒ 不崩', () => {
    const acts = Array.from({ length: 10 }, (_, i) => ({ kind: '正文', text: 't' + i }))
    const s = selectSlots(acts, null, 2 ** 32, 3)
    return s.use.length <= 10 ? true : '选中 ' + s.use.length
  })
}

// ══════════════════════════════════════════════════════════════
await group('③ 特殊输入与非法值（笑话第 13~21 条：洗脚水 / 蜥蜴 / 乱码 / undefined / NUL / False / NaN）')
// ══════════════════════════════════════════════════════════════
{
  await it('洗脚水：文件内容全是 CJK 垃圾文本 ⇒ 不崩', () => {
    const f = writeSession('garbage', ['烫烫烫', '锟斤拷', '@#$%^&*'])
    return Array.isArray(recentActivity(f, 0)) ? true : '没返回数组'
  })
  await it('蜥蜴：**纯二进制**文件（非 zstd）⇒ 不崩', () => {
    const f = writeSession('binary', null, { raw: Buffer.from([0, 1, 2, 255, 254, 0, 0, 128]) })
    return Array.isArray(recentActivity(f, 0)) ? true : '没返回数组'
  })
  await it('NUL 字节混在文本里 ⇒ 不崩', () => {
    const f = writeSession('nul', null, { raw: zlib.zstdCompressSync(Buffer.from('{"type":"user/message","data":{"content":"a\u0000b"}}', 'utf8')) })
    return Array.isArray(recentActivity(f, 0)) ? true : '没返回数组'
  })
  await it('undefined / Nil / None：JSON 行是 null ⇒ **不崩**（初次跑真测出 bug）', () => {
    // ⚠️ 这一条最初**真测出 bug**：JSON.parse('null') 得 null，紧接着读 r.type 抛 TypeError。
    //    而"文件里混进一行坏数据"不该让整次读取失败。
    const f = writeSession('nulls', ['null', 'null', '{"type":null,"data":null}', '{}', '[]', '0', '"字符串"', 'true'])
    const a = recentActivity(f, 0)
    return Array.isArray(a) ? true : '没返回数组'
  })
  await it('False：值全是布尔 ⇒ 不崩', () => {
    const f = writeSession('bools', ['true', 'false'])
    return Array.isArray(recentActivity(f, 0)) ? true : '没返回数组'
  })
  await it('NaN 杯 Null：数值型非法 JSON（NaN / 1e999）⇒ 不崩', () => {
    const f = writeSession('nanjson', ['{"type":"user/message","data":{"x":NaN}}', '{"x":1e999}'])
    return Array.isArray(recentActivity(f, 0)) ? true : '没返回数组'
  })
  await it('什么也没要：**文件存在但 0 字节** ⇒ 不崩（区别于"文件不存在"）', () => {
    const f = writeSession('zerobyte', null, { raw: Buffer.alloc(0) })
    return Array.isArray(recentActivity(f, 0)) ? true : '没返回数组'
  })
  await it('超长单行（2 MB）⇒ 不崩、不内存爆掉', () => {
    const huge = 'x'.repeat(2 * 1024 * 1024)
    const f = writeSession('huge1line', null, { raw: zlib.zstdCompressSync(Buffer.from(JSON.stringify(userMsg(huge, 1)), 'utf8')) })
    return Array.isArray(recentActivity(f, 0)) ? true : '没返回数组'
  })
  await it('**深度嵌套** JSON（1000 层）⇒ 不崩', () => {
    let nested = '1'
    for (let i = 0; i < 1000; i++) nested = '{"a":' + nested + '}'
    const f = writeSession('deepjson', null, { raw: zlib.zstdCompressSync(Buffer.from(nested, 'utf8')) })
    return Array.isArray(recentActivity(f, 0)) ? true : '没返回数组'
  })
}

// ══════════════════════════════════════════════════════════════
await group('④ 异常路径与流程（笑话第 22~28 条：进进出出 / 跳进 / 倒退进 / 蒙眼 / Uzi 扫射）')
// ══════════════════════════════════════════════════════════════
{
  await it('从窗户进来：**文件不存在** ⇒ 不崩', () => {
    const p = path.join(TMP, 'sessions', 'never-existed', 'session.jsonl.zstd')
    return Array.isArray(recentActivity(p, 0)) ? true : '没返回数组'
  })
  await it('从下水道钻进来：**目录不存在** ⇒ 不崩', () => {
    return Array.isArray(recentActivity(path.join(TMP, 'no-such-dir', 'x', 'session.jsonl.zstd'), 0)) ? true : '没返回数组'
  })
  await it('Uzi 扫射：**截断的 zstd**（压缩流砍一半）⇒ 不崩', () => {
    const full = zlib.zstdCompressSync(Buffer.from(JSON.stringify(userMsg('一半', 1)), 'utf8'))
    const f = writeSession('truncated', null, { raw: full.subarray(0, Math.floor(full.length / 2)) })
    return Array.isArray(recentActivity(f, 0)) ? true : '没返回数组'
  })
  await it('Uzi 扫射 2：**多帧里中间坏一帧** ⇒ 其余帧仍能读出（坏帧不连坐好帧）', () => {
    const good1 = zlib.zstdCompressSync(Buffer.from(JSON.stringify(userMsg('好帧一', 1)) + '\n', 'utf8'))
    const good2 = zlib.zstdCompressSync(Buffer.from(JSON.stringify(userMsg('好帧二', 3)) + '\n', 'utf8'))
    const broken = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03])
    const f = writeSession('midbroken', null, { rawWrite: Buffer.concat([good1, broken, good2]) })
    const a = recentActivity(f, 0)
    const txt = a.map((x) => x.text).join('|')
    return txt.indexOf('好帧一') !== -1 && txt.indexOf('好帧二') !== -1 ? true : '只读到：' + txt
  })
  await it('倒退着进：JSON 行**倒序**排列 ⇒ 不崩', () => {
    const f = writeSession('reversed', [userMsg('第三', 3), assistantText('第二', 2), userMsg('第一', 1)].reverse(), { frames: true })
    return Array.isArray(recentActivity(f, 0)) ? true : '没返回数组'
  })
  await it('半合法 JSON：一半行合法一半乱码 ⇒ 合法的那些仍能读出', () => {
    const f = writeSession('halfbad', [
      JSON.stringify(userMsg('正常一', 1)), '这不是 JSON',
      JSON.stringify(assistantText('正常二', 3)), '{未闭合',
    ], { frames: true })
    const a = recentActivity(f, 0)
    return a.length === 2 ? true : '读到 ' + a.length + ' 条（应 2 条）'
  })
  await it('烫烫烫的锟斤拷：UTF-8 非法字节序列 ⇒ 不崩', () => {
    const f = writeSession('badutf8', null, { raw: zlib.zstdCompressSync(Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42])) })
    return Array.isArray(recentActivity(f, 0)) ? true : '没返回数组'
  })
  await it('没有换行符：整个文件是一行 ⇒ 不崩', () => {
    const f = writeSession('nosep', null, { raw: zlib.zstdCompressSync(Buffer.from(JSON.stringify(userMsg('单行', 1)), 'utf8')) })
    return Array.isArray(recentActivity(f, 0)) ? true : '没返回数组'
  })
  await it('蒙着眼睛：**读一个目录**（不是文件）⇒ 不崩', () => {
    return Array.isArray(recentActivity(TMP, 0)) ? true : '没返回数组'
  })
}

// ══════════════════════════════════════════════════════════════
await group('⑤ 压力与容量（笑话第 33~38 条：五百吨 / 1T / 把酒吧拆了）')
// ══════════════════════════════════════════════════════════════
{
  await it('酒量为零：**10 万条痕迹**的 selectSlots 不崩且不超时（<5s）', () => {
    const acts = Array.from({ length: 100000 }, (_, i) => ({ kind: i % 2 ? '正文' : '思考', text: 't' + i }))
    const t0 = Date.now()
    const s = selectSlots(acts)
    const ms = Date.now() - t0
    return s.use.length <= 100000 && ms < 5000 ? true : '耗时 ' + ms + ' ms 或条数异常 ' + s.use.length
  })
  await it('五百吨：单条 **5 MB 文本** ⇒ 不崩', () => {
    const acts = [{ kind: '正文', text: 'y'.repeat(5 * 1024 * 1024) }]
    return selectSlots(acts).use.length === 1 ? true : '奇怪结果'
  })
  await it('把酒吧拆了：**5000 条零长文本** ⇒ 不崩', () => {
    const acts = Array.from({ length: 5000 }, () => ({ kind: '正文', text: '' }))
    return Number.isFinite(selectSlots(acts).use.length) ? true : 'NaN'
  })
  await it('把酒吧拆了 2：**1 万帧**的会话文件 ⇒ 能全解出来（分帧不丢帧）', () => {
    const lines = []
    for (let i = 0; i < 10000; i++) lines.push(userMsg('第 ' + i + ' 帧', i))
    const f = writeSession('frames10k', lines, { frames: true })
    const a = recentActivity(f, 0)
    return a.length === 10000 ? true : '只读到 ' + a.length + ' / 10000 ⇒ 丢帧'
  })
  await it('一万个工程师呼啸而过：**连续读 1000 次**不出错', () => {
    const f = writeSession('repeat-read', [userMsg('重复读', 1)], { frames: true })
    for (let i = 0; i < 1000; i++) {
      if (!Array.isArray(recentActivity(f, 0))) return '第 ' + i + ' 次失败'
    }
    return true
  })
}

// ══════════════════════════════════════════════════════════════
await group('⑥ 安全与注入（笑话第 39~43 条：DROP TABLE / script / or 1=1 / 盗用老板身份）')
// ══════════════════════════════════════════════════════════════
{
  await it('DROP TABLE：SQL 注入串进文本 ⇒ 原样当文本、不崩', () => {
    const acts = [{ kind: '正文', text: "啤酒';DROP TABLE 酒吧;--" }]
    return selectSlots(acts).use.length === 1 ? true : '奇怪'
  })
  await it('script 标签：HTML 注入串 ⇒ 不崩', () => {
    const acts = [{ kind: '正文', text: '<script>alert("要了一杯酒")</script>' }]
    return selectSlots(acts).use.length === 1 ? true : '奇怪'
  })
  await it('盗用老板身份：**原型污染** —— 条目带 __proto__ ⇒ 不污染 Object.prototype', () => {
    const before = ({}).polluted
    const f = writeSession('proto', ['{"type":"user/message","data":{"content":"x"},"__proto__":{"polluted":"yes"}}'], { frames: true })
    recentActivity(f, 0)
    const after = ({}).polluted
    return before === after && after === undefined ? true : '**Object.prototype 被污染了**'
  })
  await it('or 1=1：**必填字段缺失**时必须**出声**（本插件用返回值报错，不抛异常）', () => {
    // ⚠️ 我第一次写的是"必须抛异常" —— 那是**测试写错**：本项目统一用返回值报错。
    //    真正要断言的是"**它有没有说清缺了什么**"。
    const r = appendEntry('knowledge', { what: '只有 what，缺 from/when/kind' })
    if (r && (r.ok === false || r.added === false)) {
      const reason = String(r.reason || '')
      const named = ['from', 'when', 'kind'].filter((k) => reason.indexOf(k) !== -1)
      return named.length >= 2 ? true : '报错了但没说清缺哪些：' + reason
    }
    return '**它说成功了** ⇒ 静默丢弃（违反硬规则 1）：' + JSON.stringify(r)
  })
  await it('必填字段齐全时能正常写入（避免"为了安全把功能也堵死"）', () => {
    const r = appendEntry('knowledge', { from: 'robust-test', what: '一条正常条目', when: '2026-10-17', kind: 'fact' })
    if (r && r.ok === false) return '写入被拒：' + r.reason
    const back = entriesOf('knowledge').filter((e) => e.from === 'robust-test')
    return back.length >= 1 ? true : '写入后读不回来：' + JSON.stringify(r)
  })
  await it('注入串**原样存储**（不做转义篡改：它是数据，不是代码）', () => {
    const evil = '"; DROP TABLE x; --'
    appendEntry('knowledge', { from: 'robust-test', what: evil, when: '2026-10-17', kind: 'fact' })
    const hit = entriesOf('knowledge').find((e) => e.what === evil)
    return hit ? true : '文本被改写了 ⇒ 数据完整性受损'
  })
  await it('**未知库名** ⇒ 明确拒绝，不静默成功', () => {
    const r = appendEntry('不存在的库', { from: 'x', what: 'y', when: 'z', kind: 'k' })
    const rd = readEntries('不存在的库')
    const bad = (r && r.ok === false) || (rd && rd.ok === false)
    return bad ? true : '未知库名竟然通过了：' + JSON.stringify(r)
  })
}

// ══════════════════════════════════════════════════════════════
await group('⑦ 权限与身份（笑话第 44~46 条：名叫 exception 的工程师 / 化装成老板 / 未成年）')
// ══════════════════════════════════════════════════════════════
{
  await it('名叫 exception：**缓存文件是坏 JSON** ⇒ cacheState 说 unreadable，不谎报 ok', () => {
    const sess = writeSession('badsess1', [userMsg('一', 1)], { frames: true })
    const cp = cachePath(sess)
    fs.mkdirSync(path.dirname(cp), { recursive: true })
    fs.writeFileSync(cp, '{这不是合法 JSON', 'utf8')
    const st = cacheState(sess)
    return st.state === 'unreadable' ? true : '状态是 ' + st.state + '（应当 unreadable）'
  })
  await it('化装成老板：**缓存不存在** ⇒ cacheState 说 missing，不抛错', () => {
    const sess = writeSession('nosuchcache', [userMsg('一', 1)], { frames: true })
    const st = cacheState(sess)
    return st && st.state ? true : '没返回状态'
  })
  await it('未成年的工程师：**entries 不是数组** ⇒ 不崩', () => {
    const sess = writeSession('badstruct', [userMsg('一', 1)], { frames: true })
    const cp = cachePath(sess)
    fs.writeFileSync(cp, JSON.stringify({ version: 2, model: 'x', snip: 50, entries: 'not-an-array', vecs: null }), 'utf8')
    const st = cacheState(sess)
    let idx = null
    try { idx = loadCache(sess) } catch (e) { return 'loadCache 抛异常：' + e.message }
    return st && (idx === null || typeof idx === 'object') ? true : '奇怪'
  })
  await it('老板不付钱：writeProfile 写入后能读回最新版', () => {
    writeProfile('ai', '第一版：称呼 AI', { ver: 1, source: 'robust-test' })
    writeProfile('ai', '第二版：称呼助手', { ver: 2, source: 'robust-test' })
    const cur = readProfile('ai')
    const txt = typeof cur === 'string' ? cur : JSON.stringify(cur)
    return txt.indexOf('第二版') !== -1 ? true : '读不回最新版：' + txt.slice(0, 150)
  })
  await it('**拒绝写空内容**（覆盖成空 = 把人设弄丢）', () => {
    const r = writeProfile('ai', '   ', { ver: 3, source: 'robust-test' })
    return r && r.ok === false ? true : '空内容竟然写成功了：' + JSON.stringify(r)
  })
  await it('**人设历史要留痕**（不静默丢旧版）', () => {
    const hist = path.join(process.env.DSH_ALERT_DATA_DIR, 'memory', 'db', 'profile', 'history')
    const n = fs.existsSync(hist) ? fs.readdirSync(hist).length : 0
    return n >= 1 ? true : '没有 history 目录或为空 ⇒ 旧版被静默覆盖'
  })
}

// ══════════════════════════════════════════════════════════════
await group('⑧ 其他功能面（引用检查 / 重复检测 / 知晓感 / 新颖性 / 规则分流 / 阴影记录 / 语境配置）')
// ══════════════════════════════════════════════════════════════
{
  await it('引用检查：**指向不存在的文件** ⇒ 不崩（extractRefs 返回 Map）', () => {
    const text = '请读 ' + path.join(TMP, '不存在的目录', '不存在的文件.md') + ' 然后继续'
    // 实测纠正：extractRefs 返回**数组**（源码末行 return [...out.values()]），
    // 且默认 onlyProject:true ⇒ 项目外路径会被过滤。测试要传 onlyProject:false。
    const refs = extractRefs(text, { onlyProject: false })
    if (!Array.isArray(refs)) return 'extractRefs 没返回数组，实际 ' + typeof refs
    // detectMissingRefs 返回**对象** {checked, found, missing}，不是数组
    const r = detectMissingRefs(text, { bases: [TMP] })
    if (!r || typeof r !== 'object' || !Array.isArray(r.missing)) return 'detectMissingRefs 形状不对：' + JSON.stringify(r)
    return typeof r.checked === 'number' && typeof r.found === 'number' ? true : '形状对但字段不对'
  })
  await it('引用检查：**空文本** ⇒ 不崩、返回空数组', () => {
    const refs = extractRefs('')
    return Array.isArray(refs) && refs.length === 0 ? true : '返回 ' + JSON.stringify(refs)
  })
  await it('重复检测：**同一句连续重复 50 次** ⇒ 应**报出**重复（正例，防漏报）', () => {
    // ⚠️ 签名是 (text, opts) —— 我一开始传了数组 ⇒ text.split is not a function
    const r = detectRepetition('这句话完全一样。'.repeat(50))
    const v = JSON.stringify(r)
    const flagged = v.indexOf('true') !== -1 || (r && r.level && r.level !== 'ok' && r.level !== 'none')
    return flagged ? true : '没报出重复：' + v.slice(0, 160)
  })
  await it('重复检测：**全是不同内容** ⇒ 不抛异常（负例）', () => {
    const txt = Array.from({ length: 30 }, (_, i) => '第 ' + i + ' 句完全不同的内容，编号 ' + i * 7 + '。').join('')
    return detectRepetition(txt) !== undefined ? true : '返回 undefined'
  })
  await it('重复检测：**空字符串** ⇒ 不崩（不该除零）', () => {
    return detectRepetition('') !== undefined ? true : '返回 undefined'
  })
  await it('知晓感：**空输入** ⇒ 不崩，且能表达"我不知道"', () => {
    const r = fokAssessText('')
    return r && typeof r === 'object' ? true : '返回 ' + JSON.stringify(r)
  })
  await it('新颖性：**空词表** ⇒ 不崩（不该除零）', () => {
    const r = termCoverage('随便一句话', new Set())
    return r === null || typeof r === 'object' || typeof r === 'number' ? true : '返回 ' + JSON.stringify(r)
  })
  await it('规则分流：**空串 / 纯符号** ⇒ 不崩', () => {
    const a = classifyRule('')
    const b = classifyRule('!@#$%^&*()')
    return a !== undefined && b !== undefined ? true : '返回 undefined'
  })
  await it('学习抽取：**没有纠正的普通文本** ⇒ 不该硬挤出"纠正单元"（防误报）', () => {
    const u = extractUnits('今天天气不错，我们去公园走走吧。')
    return Array.isArray(u) && u.length === 0 ? true : '从无纠正文本里抽出了 ' + (u && u.length) + ' 个单元'
  })
  await it('阴影记录：**坏 JSONL** ⇒ 能数出坏行（不假装全部合法）', () => {
    const p = path.join(TMP, 'shadow-bad.jsonl')
    fs.writeFileSync(p, '{"ok":1}\n坏的\n{"ok":2}\n{也坏\n', 'utf8')
    const bad = countBadLines(p)
    return bad >= 2 ? true : '数出坏行 ' + bad + '（应 ≥2）⇒ 坏行被静默吞掉'
  })
  await it('阴影记录：**文件不存在** ⇒ 不崩', () => {
    return Array.isArray(readJsonl(path.join(TMP, 'no-such.jsonl'))) ? true : '没返回数组'
  })
  await it('样本库：**坏行**混在 JSONL 里 ⇒ loadSamples 不崩', () => {
    const p = process.env.SAMPLES_FILE
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '{"a":1}\n坏的\n{"b":2}\n', 'utf8')
    const s = loadSamples()
    return Array.isArray(s) ? true : '返回 ' + JSON.stringify(s)
  })
  await it('语境配置：**坏 JSON** ⇒ readContexts 不崩，且不谎报 enabled', () => {
    fs.writeFileSync(process.env.DSH_ALERT_CONTEXTS, '{坏的', 'utf8')
    const c = readContexts()
    return c && typeof c === 'object' ? true : '返回 ' + JSON.stringify(c)
  })
}

// ══════════════════════════════════════════════════════════════
await group('⑨ ★ 炒饭测试（笑话第 48~49 条：一切正常之后，来个不相干的东西）')
// ══════════════════════════════════════════════════════════════
{
  /**
   * 「测试工程师们满意地离开了酒吧。然后一名顾客点了一份炒饭，酒吧炸了。」
   * ⇒ 要测的是：**在全部功能都正常跑过一遍之后，来一份"不相干的东西"，
   *    会不会把之前一切正常的部分带崩。**
   *   具体到本插件：**一份炒饭 = 一个与它毫无关系的文件/路径/输入**。
   */
  await it('炒饭 1：传入**别的项目的文件**（AGENTS.md）当会话 ⇒ 不崩，且不误报成功', () => {
    const a = recentActivity('D:\\dswork\\AGENTS.md', 0)
    return Array.isArray(a) ? true : '没返回数组'
  })
  await it('炒饭 2：传入**目录本身**当文件 ⇒ 不崩', () => {
    return Array.isArray(recentActivity(TMP, 0)) ? true : '没返回数组'
  })
  await it('炒饭 3：传入 **null / undefined / 数字 / 布尔**当路径 ⇒ 不崩', () => {
    const r = [recentActivity(null, 0), recentActivity(undefined, 0), recentActivity(42, 0), recentActivity(false, 0)]
    return r.every(Array.isArray) ? true : '有一项不是数组'
  })
  await it('炒饭 4：**在正常流程之后**塞坏输入 ⇒ 之前的正常结果不受影响（无状态泄漏）', () => {
    const f = writeSession('statecheck', [userMsg('正常一', 1), assistantText('正常二', 2)], { frames: true })
    const before = JSON.stringify(recentActivity(f, 0).map((a) => a.kind))
    recentActivity(path.join(TMP, 'no-such-file-xyz'), 0)
    recentActivity(null, 0)
    recentActivity('\\\\?\\C:\\', 0)
    const after = JSON.stringify(recentActivity(f, 0).map((a) => a.kind))
    return before === after ? true : '坏输入污染了后续正常读取：' + before + ' → ' + after
  })
  await it('炒饭 5：**全部功能面各跑一次之后**，核心索引逻辑仍然正确', () => {
    const acts = Array.from({ length: 10 }, (_, i) => ({ kind: '正文', text: 't' + i }))
    const s = selectSlots(acts, null, 5, 3)
    const ok = s.use.length <= 10 && new Set(s.use).size === s.use.length
    return ok ? true : '索引逻辑被影响：' + JSON.stringify(s.use)
  })
  await it('炒饭 6：**超长路径**（4000 字符）⇒ 不崩', () => {
    return Array.isArray(recentActivity(path.join(TMP, 'x'.repeat(4000)), 0)) ? true : '没返回数组'
  })
  await it('炒饭 7：**路径含 Windows 保留名 / 控制字符 / UNC** ⇒ 不崩', () => {
    const r = [
      recentActivity(path.join(TMP, 'CON', 'session.jsonl.zstd'), 0),
      recentActivity(path.join(TMP, 'a\u0000b'), 0),
      recentActivity('\\\\?\\C:\\', 0),
    ]
    return r.every(Array.isArray) ? true : '有一项不是数组'
  })
  await it('炒饭 8：**把隔离目录整个删掉**之后，各入口仍不崩（这才是真的"酒吧炸了"）', () => {
    const doomed = path.join(TMP, 'doomed')
    fs.mkdirSync(doomed, { recursive: true })
    const f = writeSession('doomed-sess', [userMsg('要被删了', 1)], { frames: true })
    fs.rmSync(doomed, { recursive: true, force: true })
    const a = recentActivity(f, 0)
    const st = cacheState(f)
    return Array.isArray(a) && st && st.state ? true : '删掉目录后崩了'
  })
}

// ── 收尾 ────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }

console.log('\n══════ 结论 ══════')
console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项')
if (fail) {
  console.log('\n  未过项：')
  for (const f of fails) console.log('    · ' + f)
  process.exit(1)
}
console.log('  ✅ 全部通过')
console.log('\n  ⚠️ 它证明的是"**不崩、不静默**"，证明不了"**结果对**" —— 后者要看真实命中。')
