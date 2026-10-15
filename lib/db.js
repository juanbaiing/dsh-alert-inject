/**
 * db.js — 三个库的读写（知识 ／ 案例 ／ 人设）
 *
 * ══ 结构（作者 2026-10-16 定）═══════════════════════════════════════
 *   | 库 | 生长方式 | 存储 |
 *   |---|---|---|
 *   | `knowledge/` 知识 | **累积** | `knowledge.jsonl`（一行一条） |
 *   | `cases/`   案例 | 累积 | `cases.jsonl` |
 *   | `profile/` 人设 | **覆盖 ＋ 旧版留痕** | `ai.md` ／ `user.md` ＋ `history/` |
 *
 *   ⚠️ 位置**可配置**：默认 `~/.dsh/memory/db/`，随 `DSH_ALERT_DATA_DIR` 走。
 *   ⚠️ 字段规范与"一条长什么样"写在库自己的 `_schema.md` 里（给不看代码的人看）。
 *
 * ══ 四条纪律（每条都对应本项目踩过的坑）══════════════════════════
 *   ① **绝不静默**：拒写要说明为什么；写失败要 `console.warn`（§239）
 *   ② **必须去重**：内容是"每轮重扫"出来的 ⇒ 没指纹会**平方增长**（`samples.js` 记过同一件事）
 *   ③ **覆盖必须原子**：profile 是覆盖式，直接 `writeFileSync` 会留**半截文件**
 *      ⇒ 写临时文件 → `rename`（rename 在同一分区上是原子的）
 *   ④ **旧版必须留痕**：覆盖前先归档到 `history/`（作者 2026-10-16 定）
 *
 * ⚠️ 本模块**不做判断**：该不该记、算哪一类，由调用方决定。这里只管"存得住、取得回"。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

/** 必填字段 —— 少一个就**拒绝写入**（宁可拒，也不要存半条进去） */
export const REQUIRED = ['from', 'what', 'when', 'kind']

/** 库根目录（**可配置**） */
export function dbRoot() {
  const dataDir = process.env.DSH_ALERT_DATA_DIR || path.join(os.homedir(), '.dsh')
  return path.join(dataDir, 'memory', 'db')
}

const LIBS = { knowledge: 'knowledge/knowledge.jsonl', cases: 'cases/cases.jsonl' }
const PROFILES = { ai: 'profile/ai.md', user: 'profile/user.md' }

/** 一条记忆的内容指纹 —— **不含时间**（同一件事无论何时记，只落一条） */
export function entryKey(e) {
  const key = [
    String(e.kind ?? ''),
    String(e.what ?? ''),
    e.from?.session ?? '',
    e.from?.pos ?? '',
  ].join('\u0000')
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)
}

/** 读 jsonl；**坏行计数并回报**，不静默吞掉 */
export function readEntries(lib) {
  const rel = LIBS[lib]
  if (!rel) return { ok: false, entries: [], badLines: 0, reason: `不认识的库：${lib}（只有 knowledge／cases）` }
  const p = path.join(dbRoot(), rel)
  if (!fs.existsSync(p)) return { ok: true, entries: [], badLines: 0, reason: '库文件还不存在（还没记过东西）' }
  let raw = ''
  try { raw = fs.readFileSync(p, 'utf8') } catch (e) {
    return { ok: false, entries: [], badLines: 0, reason: `读不动：${e?.message || e}` }
  }
  const entries = []
  let badLines = 0
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue
    try { entries.push(JSON.parse(l)) } catch { badLines++ }
  }
  return { ok: true, entries, badLines, reason: '' }
}

/** 已见指纹集合（避免重复记录） */
function seenKeys(file) {
  const set = new Set()
  try {
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!l.trim()) continue
      try { const o = JSON.parse(l); if (o.h) set.add(o.h) } catch { /* 坏行不算 */ }
    }
  } catch { /* 文件不存在 ⇒ 空集 */ }
  return set
}

function rotateIfBig(file, maxBytes = 8 * 1024 * 1024) {
  try {
    const st = fs.statSync(file)
    if (st.size > maxBytes) fs.renameSync(file, file.replace(/\.jsonl$/, `.${Date.now()}.jsonl`))
  } catch { /* 不存在则无需轮转 */ }
}

/**
 * 追加一条（`knowledge` 或 `cases`）。
 *
 * @returns {{ok:boolean, added:boolean, key?:string, reason?:string}}
 *   ⚠️ 被拒时 `reason` **一定**有值 —— 不返回"成功但什么都没做"。
 */
export function appendEntry(lib, entry) {
  const rel = LIBS[lib]
  if (!rel) return { ok: false, added: false, reason: `不认识的库：${lib}` }
  const missing = REQUIRED.filter((k) => entry?.[k] === undefined || entry[k] === '' || entry[k] === null)
  if (missing.length) {
    return { ok: false, added: false, reason: `缺必填字段：${missing.join('、')}（见库自己的 _schema.md）` }
  }
  const key = entryKey(entry)
  try {
    const p = path.join(dbRoot(), rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const seen = seenKeys(p)
    if (seen.has(key)) return { ok: true, added: false, key, reason: '已经记过了（同一条不重复记）' }
    rotateIfBig(p)
    fs.appendFileSync(p, JSON.stringify({ h: key, ...entry }) + '\n', 'utf8')
    return { ok: true, added: true, key }
  } catch (e) {
    // ⚠️ §239：降级可以，**降级必须留痕**
    console.warn('[alert-inject/db] ⚠️ 写入失败（这条没记上）：', e?.message || e)
    return { ok: false, added: false, reason: `写入失败：${e?.message || e}` }
  }
}

/** 读当前 profile 正文（`ai` 或 `user`） */
export function readProfile(half) {
  const rel = PROFILES[half]
  if (!rel) return { ok: false, text: '', reason: `不认识的人设半区：${half}（只有 ai／user）` }
  const p = path.join(dbRoot(), rel)
  if (!fs.existsSync(p)) return { ok: true, text: '', reason: '这一半还没写过（出厂是空的）' }
  try { return { ok: true, text: fs.readFileSync(p, 'utf8'), reason: '' } } catch (e) {
    return { ok: false, text: '', reason: `读不动：${e?.message || e}` }
  }
}

/**
 * 覆盖写 profile —— ⚠️ **旧版先归档，且新版本原子落盘**。
 *
 * @returns {{ok:boolean, archived?:string, reason?:string}}
 */
export function writeProfile(half, body, { ver, source } = {}) {
  const rel = PROFILES[half]
  if (!rel) return { ok: false, reason: `不认识的人设半区：${half}` }
  if (!String(body || '').trim()) return { ok: false, reason: '拒绝写空内容（覆盖成空 = 把人设弄丢了）' }
  const root = dbRoot()
  const p = path.join(root, rel)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // ① 旧版归档（作者 2026-10-16 定：「旧版留痕」）
    let archived
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8').trim()) {
      const hdir = path.join(root, 'profile', 'history')
      fs.mkdirSync(hdir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      archived = path.join(hdir, `${half}-${stamp}.md`)
      fs.copyFileSync(p, archived)
    }
    // ② 原子写：先写临时文件，再 rename（rename 在同一分区上是原子的）
    //    ⚠️ 直接 writeFileSync 覆盖，中途失败会留下**半截人设**，而那是最不该坏的东西
    const tmp = p + '.tmp-' + process.pid
    const full = (ver !== undefined || source)
      ? `${String(body).trimEnd()}\n\n---\n**ver**: ${ver ?? '?'}　**更新时间**: ${new Date().toISOString()}　**来源**: ${source || '?'}\n`
      : String(body)
    fs.writeFileSync(tmp, full, 'utf8')
    fs.renameSync(tmp, p)
    return { ok: true, archived: archived ? path.relative(root, archived) : undefined }
  } catch (e) {
    console.warn('[alert-inject/db] ⚠️ 人设写入失败（旧版仍在）：', e?.message || e)
    return { ok: false, reason: `写入失败：${e?.message || e}` }
  }
}

/** 状态（供体检报告用）—— **每一项都要能被核对** */
export function dbStatus() {
  const root = dbRoot()
  const out = { root, exists: fs.existsSync(root), libs: {}, profile: {} }
  for (const lib of Object.keys(LIBS)) {
    const r = readEntries(lib)
    out.libs[lib] = { count: r.entries.length, badLines: r.badLines, ok: r.ok, reason: r.reason }
  }
  for (const half of Object.keys(PROFILES)) {
    const r = readProfile(half)
    // ⚠️⚠️ 不能只看"有没有字"（2026-10-16 实测抓到）：
    //   出厂模板里**也有字**（"（待长）"）⇒ 用 `length > 0` 会把
    //   **"还没填"报成"已填"** —— 那是标准的"输出与真相不符"。
    const placeholder = /（待长）/.test(r.text)
    out.profile[half] = {
      chars: r.text.length,
      filled: r.text.trim().length > 0 && !placeholder,
      placeholder,          // true ⇒ 还是出厂模板，没真填过
      ok: r.ok,
    }
  }
  let versions = 0
  try { versions = fs.readdirSync(path.join(root, 'profile', 'history')).length } catch { /* 还没有 */ }
  out.profileVersions = versions
  return out
}
