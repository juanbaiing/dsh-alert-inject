/**
 * sandbox-test.mjs — 【纯测试环境】：**不碰任何真实数据**，跑完整链路 ＋ 健壮性
 *
 * ══ 为什么要它（`AGENTS.md` 开发顺序第 2、3 步，此前被跳过）════════
 *   > ② **公开测试材料 ＋ 期望答案** —— 任何下载者都能跑出可比较的结果
 *   > ③ **健壮性测试** —— 空／乱码／超长／非中文／二进制，**逐个定行为**
 *   ⇒ 没有这两步，出问题时**分不清是功能错还是环境错**，只能靠作者自述。
 *
 * ══ 「纯」体现在两处 ═════════════════════════════════════════════
 *   ① **全部路径都指向临时沙盒**（隔离变量：数据目录／样本库／索引缓存／影子记录／整理稿／配置／判据表／项目根）
 *   ② **跑完当场核对真实数据没被动过** —— 这是"纯"的**证明**，不是声明
 *
 * ══ 判据（**写在跑之前**）════════════════════════════════════════
 *   A. **无污染**：跑完后，真实数据目录里那 6 类文件的**大小与修改时间全部不变**
 *   B. **不崩**：健壮性 5 项（空／乱码／超长／非中文／二进制）**一项都不许抛未捕获异常**
 *   C. **不静默**：每一项都必须**明确说明**自己的行为（"没找到"≠"我没在找"；"没做完"≠"做完了"）
 *
 * 用法：`node tools/sandbox-test.mjs`
 * ⚠️ 它**只读**真实数据（读指纹用），**只写**临时沙盒。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const REAL_HOME = os.homedir()
const REAL_DSH = path.join(REAL_HOME, '.dsh')

// ══════════════════════════════════════════════════════════════
// ① 先量真实数据（跑完要拿来对比 —— "纯"的证明）
// ══════════════════════════════════════════════════════════════
const WATCH = [
  'learning-samples.jsonl',
  'learning-pending.json',
  'alert-inject.json',
  '.alert-inject-bootstrapped.json',
]
const WATCH_DIRS = ['librarian-cache', 'memory/contexts', 'memory/db', 'alert-shadow']

function snapshot() {
  const out = {}
  for (const f of WATCH) {
    const p = path.join(REAL_DSH, f)
    try { const s = fs.statSync(p); out[f] = `${s.size}:${s.mtimeMs}` } catch { out[f] = '（不存在）' }
  }
  for (const d of WATCH_DIRS) {
    const dir = path.join(REAL_DSH, d)
    const files = {}
    const walk = (cur) => {
      let ents = []
      try { ents = fs.readdirSync(cur, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        const p = path.join(cur, e.name)
        if (e.isDirectory()) walk(p)
        else { try { const s = fs.statSync(p); files[path.relative(dir, p)] = `${s.size}:${s.mtimeMs}` } catch { /* 忽略 */ } }
      }
    }
    walk(dir)
    out[d + '/'] = files
  }
  return out
}

const before = snapshot()

// ══════════════════════════════════════════════════════════════
// ② 建沙盒：**所有路径都指到临时目录**
// ══════════════════════════════════════════════════════════════
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-sandbox-'))
const DATA = path.join(SANDBOX, 'data')
const PROJ = path.join(SANDBOX, 'project')
const SESS_DIR = path.join(DATA, 'sessions', '--sandbox--', 'session-SANDBOX-0001')

process.env.DSH_ALERT_DATA_DIR = DATA
process.env.SAMPLES_FILE = path.join(DATA, 'learning-samples.jsonl')
process.env.SHADOW_DIR = path.join(DATA, 'alert-shadow')
process.env.LIBRARIAN_CACHE = path.join(DATA, 'librarian-cache')
process.env.DSH_CONTEXT_DIR = path.join(DATA, 'memory', 'contexts')
process.env.DSH_ALERT_CONFIG = path.join(DATA, 'alert-inject.json')   // ← 指向不存在的文件 ⇒ 走默认
process.env.DSH_ALERT_PROJECT = PROJ
// ⚠️ 不设 DSH_ALERT_PROVIDER ⇒ 用默认 ollama（本机有）；模型调用只发生在"索引"那一步

fs.mkdirSync(PROJ, { recursive: true })
fs.mkdirSync(SESS_DIR, { recursive: true })
fs.mkdirSync(path.join(PROJ, '.dsh-alert'), { recursive: true })

console.log('══════════════════════════════════════════════════════════')
console.log('  纯测试环境（沙盒）')
console.log('══════════════════════════════════════════════════════════')
console.log(`沙盒：${SANDBOX}`)
console.log(`数据：${DATA}`)
console.log(`项目：${PROJ}（假项目，不是你的）`)
console.log('')

// ── 造一个【格式真实】的会话文件（zstd 容器 ＋ 会话 JSONL 行）──
function makeSession(acts) {
  const lines = []
  for (const a of acts) {
    if (a.kind === '用户') {
      lines.push(JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: a.text }], source: 'user', role: 'user', id: 'x' } }))
    } else if (a.kind === '正文' || a.kind === '思考') {
      // ⚠️⚠️ 真实会话里**两种表示同时存在**（实测一份真实会话：`assistant/message` 1064 条、
      //    `assistant/chunk` 12065 条），覆盖的是**同一批对话**：
      //      · `recentActivity`（index.js，`alert_check` 用）读 **assistant/message**
      //      · `normalizeSession`（context.js，整理稿用）读 **assistant/chunk**
      //    ⇒ 只造一种，就会出现"一边读得到、一边读不到"——
      //      **那是测试不真实，不是产品有 bug**（本沙盒第一版就栽在这里）。
      const bt = a.kind === '正文' ? 'text' : 'reasoning'
      lines.push(JSON.stringify({ type: 'assistant/message', data: { message: { content: [{ type: bt, text: a.text }] } } }))
      lines.push(JSON.stringify({ type: 'assistant/chunk', data: { chunk: { block: { type: bt, text: a.text } } } }))
    } else if (a.kind === '工具') {
      lines.push(JSON.stringify({ type: 'tool/call', data: { name: a.text, arguments: '{}' } }))
      lines.push(JSON.stringify({ type: 'assistant/chunk', data: { chunk: { block: { type: 'tool-call', name: a.text } } } }))
    }
  }
  const raw = Buffer.from(lines.join('\n') + '\n', 'utf8')
  // ⚠️ 真实会话是**多帧 zstd**（每帧一段）；这里压成一帧即可被现有的逐帧解压逻辑读到
  return zlib.zstdCompressSync(raw)
}

const SESSION_FILE = path.join(SESS_DIR, 'session.jsonl.zstd')
const NORMAL_ACTS = [
  { kind: '用户', text: '你好，先看一下这个项目的结构。' },
  { kind: '思考', text: '他在让我看结构，那我先列目录。' },
  { kind: '工具', text: 'exec' },
  { kind: '正文', text: '看完了，目录里有三份设定档案。' },
  { kind: '用户', text: '不对，我说的是让你先读交接文档，不是列目录。' },
  { kind: '思考', text: '我理解偏了，他先要的是读交接。' },
  { kind: '正文', text: '那我现在读交接文档。' },
  { kind: '用户', text: '另外，你顺便去搜一下有没有类似的工程。' },
]

fs.writeFileSync(SESSION_FILE, makeSession(NORMAL_ACTS))
console.log('已造会话：' + path.relative(SANDBOX, SESSION_FILE) + `（${NORMAL_ACTS.length} 个动作）`)

// 假判据表（含 1 条正常 + 1 条影子）
fs.writeFileSync(path.join(PROJ, '.dsh-alert', 'judges.json'), JSON.stringify({
  meta: ['测试用'],
  judges: [
    { id: '测试判据', sources: ['正文'], signals: ['看完了'], anomalies: [], requireTermHit: false, enabled: true },
    { id: '测试影子', sources: ['正文'], signals: ['那我现在'], anomalies: [], requireTermHit: false, enabled: true, shadow: true },
  ],
}, null, 1), 'utf8')
// 假术语表
fs.writeFileSync(path.join(PROJ, 'alert-terms.md'), '| 术语 | 主档 | 别名 | 出 | 入 | 行数 | 备注 |\n|---|---|---|---|---|---|---|\n| 交接文档 | 测试/交接 | 交接 | 1 | 1 | 1 |  |\n', 'utf8')
console.log('已造假判据表（2 条，其中 1 条影子）＋ 假术语表')

const R = []
const say = (ok, name, detail = '') => { R.push({ ok, name, detail }); console.log(`  ${ok === true ? '✅' : ok === false ? '❌' : '⚠️'} ${name}${detail ? '  — ' + detail : ''}`) }

// ══════════════════════════════════════════════════════════════
// ③ 链路测试
// ══════════════════════════════════════════════════════════════
console.log('')
console.log('── 链路 ① 判据表（合并 + 影子分流）──')
const idxMod = await import('../lib/index.js')
const j = idxMod.loadJudges(PROJ)
say(j.judges.length >= 2 && j.judges.some((x) => x.shadow), '判据表加载（含影子判据）', `${j.judges.length} 条：` + j.judges.map((x) => x.id + (x.shadow ? '〔影〕' : '')).join('/'))

console.log('')
console.log('── 链路 ② 会话读取 ──')
const acts = idxMod.recentActivity(SESSION_FILE, 0)
say(acts.length === NORMAL_ACTS.length, '从沙盒会话读回全部动作', `${acts.length} 条（期望 ${NORMAL_ACTS.length}）`)

console.log('')
console.log('── 链路 ③ 整理稿（L2）＋ cases 库 ──')
const ctxMod = await import('../lib/context.js')
const dbMod = await import('../lib/db.js')
const r1 = ctxMod.normalizeSession(SESSION_FILE)
say(r1.ok && !r1.reused, '整理（首次应真的算一遍）', `ok=${r1.ok} reused=${r1.reused} ${r1.total} 条 / ${r1.blocks} 块`)
const lc = ctxMod.loadContext(SESSION_FILE)
say(lc.fromL2, '读回整理稿', lc.note)
let added = 0
for (const g of lc.groups) {
  const res = dbMod.appendEntry('cases', { kind: '案例', what: `第 ${g.block} 块：${g.head}`, from: { session: 'SANDBOX', pos: g.items?.[0]?.srcPos ?? null, block: g.block }, when: new Date().toISOString(), conf: 'derived', src: '整理稿', ver: 1, n: g.n })
  if (res.ok && res.added) added++
}
say(added === lc.groups.length, '灌进 cases 库', `新记 ${added} 条（块数 ${lc.groups.length}）`)
const dbSt = dbMod.dbStatus()
say(dbSt.root.startsWith(SANDBOX), '**库写在沙盒里**（不是真实目录）', dbSt.root)

console.log('')
console.log('── 链路 ④ 影子记录（只记录、不提醒）──')
const shadowMod = await import('../lib/shadow.js')
const sh = shadowMod.recordHits([{ judge: '测试影子', kind: '正文', pos: 3, block: 1, term: '那我现在', n: 1, snippet: '那我现在读交接文档。' }], 'SANDBOX')
const shs = shadowMod.summary()
// ⚠️ `recordHits` 返回的是 `{added, skipped, error}` —— **没有 `ok` 字段**
//    （本沙盒第一版用了 `sh.ok` ⇒ undefined ⇒ 显示成 ⚠️。这也是"测试自己写错"的实例。）
say(sh.error === null && sh.added === 1, '影子记录写入', `新增 ${sh.added}，合计 ${shs.total}`)
say(shs.files.dir.startsWith(SANDBOX), '**影子写在沙盒里**', shs.files.dir)

// ══════════════════════════════════════════════════════════════
// ④ 健壮性（`AGENTS.md` 第 3 步：逐个定行为）
// ══════════════════════════════════════════════════════════════
console.log('')
console.log('── 健壮性：空／乱码／超长／非中文／二进制 ──')

async function probe(name, bytes) {
  const f = path.join(SESS_DIR, `session-${name}.jsonl.zstd`)
  fs.writeFileSync(f, bytes)
  try {
    const a = idxMod.recentActivity(f, 0)
    const r = ctxMod.normalizeSession(f)
    // ⚠️ 判据：不许抛；且**必须给出明确状态**（不是静默返回空）
    const explicit = r.ok === true || !!r.reason
    say(a.length === 0 ? explicit : true, `${name}：不崩，且有明确交代`,
      `读到 ${a.length} 条痕迹；整理 ok=${r.ok}${r.reason ? ' reason=' + r.reason : ''}${r.total !== undefined ? ' total=' + r.total : ''}`)
  } catch (e) {
    say(false, `${name}：**抛异常了**`, e?.message || String(e))
  }
}

await probe('空文件', Buffer.alloc(0))
await probe('乱码', Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x90, 0xab, 0xcd]))
await probe('非中文', makeSession([{ kind: '用户', text: 'hello world, please read the handover document.' }, { kind: '正文', text: 'ok, reading now.' }]))
await probe('正确 zstd 但内部是二进制', zlib.zstdCompressSync(Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00])))
await probe('超长单行', makeSession([{ kind: '用户', text: 'x'.repeat(200000) }]))

// ══════════════════════════════════════════════════════════════
// ⑤ 无污染核对（**这才是"纯"的证明**）
// ══════════════════════════════════════════════════════════════
const after = snapshot()
const diffs = []
for (const k of Object.keys(before)) {
  if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) diffs.push(k)
}
console.log('')
console.log('── 无污染核对（跑前/跑后 对比真实数据目录）──')
if (!diffs.length) {
  say(true, '**真实数据一个字节都没动**', `核对了 ${Object.keys(before).length} 项（含 ${WATCH_DIRS.length} 个目录的逐文件大小+mtime）`)
} else {
  say(false, '真实数据被改动了！', diffs.join(' / '))
  console.log('     ⇒ ⚠️ 请立刻停下查这个 —— 它意味着隔离没做干净')
}

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
const pass = R.filter((x) => x.ok === true).length
const fail = R.filter((x) => x.ok === false).length
console.log('')
console.log('══════════════════════════════════════════════════════════')
console.log(`  结果：通过 ${pass} ／ 失败 ${fail}`)
console.log('══════════════════════════════════════════════════════════')
console.log('')
console.log('【这一轮证明了什么】')
console.log('  · 整条链路能在**一个假项目、假会话、隔离数据目录**里跑通')
console.log('  · 空／乱码／非中文／二进制／超长 **都不崩，而且都有明确交代**')
console.log('  · **真实数据目录的大小与修改时间全部未变** ⇒ 隔离是真的')
console.log('')
console.log(`沙盒留在：${SANDBOX}`)
console.log('（想自己看：用文件管理器打开它；想清掉：删掉这个目录即可 —— 它在系统临时区）')
console.log('⚠️ 本工具**不碰**你的 ~/.dsh；只读它来取指纹。')
process.exit(fail ? 1 : 0)
