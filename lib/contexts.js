/**
 * contexts.js —— 「语境区」：**把几场对话绑成一个区，让检索在里面工作**
 *
 * ══ 作者的要求（2026-10-16，逐条）════════════════════════════════════
 *  ① 「建立一个分区，确定它查哪个会话，**要不一直卡着**」
 *  ② 「同语境跨对话」
 *  ③ 「按名字挨个勾选，就像现在边上工作区和对话分类一样」
 *  ④ 「不管有没有搜索，要有一个『在那个语境搜索』的选项，
 *      并要求选出这个语境区**最新的是哪个，在选好之前不启动**」
 *
 * ══ 三个概念（不要混）════════════════════════════════════════════════
 *   · **语境区**（context）= 用户勾出来的一组对话。默认空 ⇒ 行为与"只看当前会话"完全一致。
 *   · **落点**（anchor）= 这个区里**最新的一场**。检索以它为基准（"现在在说的事"）。
 *   · **开关**（enabled）= 「在那个语境搜索」。**只在落点选好之后才能打开**（④）。
 *
 * ⚠️ 为什么"落点"是必需的、不能自动糊弄：
 *    跨对话检索要回答的是「**现在这件事，以前在哪场说过**」——
 *    没有"现在"，就没有"以前"。而"现在"必须是**用户认过的**那一场，
 *    不能由我们悄悄挑一个（挑错了，检索就会拿别人的语境去解释这一场）。
 *
 * ⚠️ 本模块**只读磁盘、只写一个自己的配置文件**：
 *    不建索引、不 embed、不写会话、不碰 `~/.dsh` 下任何别的东西。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readSessionHead } from './harvest.js'

// ══════════════════════════════════════════════════════════════════
// 配置文件
// ══════════════════════════════════════════════════════════════════
export const CONTEXTS_FILE = process.env.DSH_ALERT_CONTEXTS
  || path.join(os.homedir(), '.dsh', 'alert-contexts.json')

export const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions')

/**
 * 语境区配置的**出厂形状**。
 * ⚠️ 默认 `enabled: false` + 空 `selected` ⇒ **不改变任何现有行为**。
 */
const DEFAULT_CFG = {
  version: 1,
  /** 「在那个语境搜索」总开关。**必须落点选好才能为 true**（作者④） */
  enabled: false,
  /** 勾进语境区的会话 id */
  selected: [],
  /**
   * 落点：语境区里**最新的一场**。
   * ⚠️ 存 id 而不是"每次都取最新"：用户可能想钉住某一场，而"最新"会随后续对话漂移。
   */
  anchor: null,
  /** 每次检索最多比对几场（性能闸门；越大越慢） */
  maxSessions: 5,
}

/** 读配置。**坏文件要出声，不能静默当默认**（硬规则 2） */
export function readContexts() {
  try {
    if (!fs.existsSync(CONTEXTS_FILE)) return { ok: true, cfg: { ...DEFAULT_CFG }, exists: false }
    const raw = JSON.parse(fs.readFileSync(CONTEXTS_FILE, 'utf8'))
    return { ok: true, cfg: { ...DEFAULT_CFG, ...raw }, exists: true }
  } catch (e) {
    return { ok: false, cfg: { ...DEFAULT_CFG }, exists: true, why: `配置读不动：${e?.message || e}` }
  }
}

/**
 * 写配置（**原子写**：先写临时文件再 rename）。
 * ⚠️ rename 在同一分区上是原子的 —— 直接覆盖，中途失败会留下半截配置，
 *    而那会让"选了哪几场"凭空消失（人设那次踩过同类，见 `db.js` 的 `writeProfile`）。
 */
export function writeContexts(patch) {
  const cur = readContexts().cfg
  const next = { ...cur, ...patch }
  // ⚠️ 不变量：**落点没选好 ⇒ 开关不许为 true**（作者④「在选好之前不启动」）
  if (next.enabled && !next.anchor) {
    return { ok: false, why: '还没选落点（这一区最新的是哪一场）⇒ 开关不能打开' }
  }
  // ⚠️ 落点必须在选中集合里，否则它指着一场没被勾选的对话
  if (next.anchor && Array.isArray(next.selected) && !next.selected.includes(next.anchor)) {
    return { ok: false, why: `落点 ${next.anchor} 不在已选中的对话里` }
  }
  try {
    fs.mkdirSync(path.dirname(CONTEXTS_FILE), { recursive: true })
    const tmp = CONTEXTS_FILE + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, CONTEXTS_FILE)
    return { ok: true, cfg: next }
  } catch (e) {
    return { ok: false, why: `配置写不进去：${e?.message || e}` }
  }
}

// ══════════════════════════════════════════════════════════════════
// 会话清单
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// 对话名字 / 工作区名字：**读 DSH 自己的存储，不从会话日志解析**
// ══════════════════════════════════════════════════════════════════
/**
 * ★ 2026-10-16 的重大修正（起因是作者原话：「**我没有从中提取到任何有效信息**」）。
 *
 * 我先前一直在**从会话日志里解析标题**（读文件头 64 KB 找 `session/title` 事件），
 * 还做到了 125/132 命中。但那个方向本身就是错的，而且有一个当时没解释清的事实：
 * **同一个接口，我直接调能读到标题，浏览器里却是空**（界面上全是 `(没读到名字) session-…`）。
 *
 * ⇒ 真正的数据源一直摆在那里：
 *   · `~/.dsh/storages/session_projcache.json` —— `tables.sessions[<id>].rows.title.val`
 *     **132 个会话全有标题**（DSH 自己维护的投影缓存）
 *   · `~/.dsh/storages/workspace.json` —— `tables.workspaces[<id>]` = `{ path, title, sessionIds }`
 *     **工作区名与成员关系的权威映射**
 *
 * ⇒ 教训（比上面那个 bug 更重要）：
 *   **宿主已经维护好的事实，不要自己再算一遍。**
 *   自己算的版本会漂移、会漏、只在自己机器上"看起来能用"（125/132 就是那种假象）。
 */
function storagesFile(name) {
  return path.join(os.homedir(), '.dsh', 'storages', name)
}

/** 解析 DSH 存储（**坏文件要说出来，不静默当空**） */
function readStorage(name) {
  const p = storagesFile(name)
  try {
    if (!fs.existsSync(p)) return { ok: true, data: null, why: `没有 ${name}（DSH 还没写过它）` }
    return { ok: true, data: JSON.parse(fs.readFileSync(p, 'utf8')) }
  } catch (e) {
    return { ok: false, data: null, why: `${name} 读不动：${e?.message || e}` }
  }
}

/**
 * 会话标题表：`Map<sessionId, 标题>`，来自 DSH 的投影缓存。
 * ⚠️ **按 mtime 缓存，只解析一次** —— 否则 132 个会话各读一遍这个 433 KB 的 JSON。
 */
let _titleMap = null
let _titleMapAt = -1
function titleMap() {
  let mtime = 0
  try { mtime = fs.statSync(storagesFile('session_projcache.json')).mtimeMs } catch { mtime = 0 }
  if (_titleMap && _titleMapAt === mtime) return _titleMap
  const out = new Map()
  const { data } = readStorage('session_projcache.json')
  const table = data?.tables?.sessions || {}
  for (const id of Object.keys(table)) {
    const v = table[id]?.rows?.title?.val
    if (typeof v === 'string' && v.trim()) out.set(id, v.trim())
  }
  _titleMap = out
  _titleMapAt = mtime
  return out
}

/** 工作区表：[{ id, path, title, sessionIds }]，来自 DSH 的工作区注册表 */
function workspaceTable() {
  const { data } = readStorage('workspace.json')
  const t = data?.tables?.workspaces || {}
  return Object.keys(t).map((id) => ({ id, ...t[id] }))
}

/**
 * 读会话文件开头 64 KB —— ⚠️ **现在只用来取 `cwd`**（标题已改走 `titleMap()`）。
 * 窗口取 64 KB 是因为会话头的第一帧很小、必定在开头；这个量级是我先前实测过"开场几帧都在其内"的。
 */
function headBufOf(file, windowBytes = 65536) {
  try {
    const st = fs.statSync(file)
    const take = Math.min(st.size, windowBytes)
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(take)
      fs.readSync(fd, buf, 0, take, 0)
      return buf
    } finally { fs.closeSync(fd) }
  } catch { return null }
}
/**
 * 索引缓存是否已备好。
 *
 * ⚠️ **复用 `librarian.cachePath()`，不自己拼文件名**（2026-10-16 实测抓到）：
 *    我第一版按 `base64(...).replace(/=/,'')` 自己拼，结果 **17 个缓存一个都认不出来**
 *    ⇒ 界面会把"已备好"全显示成"没备"，而**它只是拼错了名字**。
 *    真源码用的是 `base64url` 且只取前 24 位（`librarian.js:288`）。
 *    ⇒ 同一条规矩：**同一件事只能有一个实现**，两边各拼一次必然漂移。
 */
async function indexInfoOf(sessionFile) {
  try {
    const { cachePath } = await import('./librarian.js')
    const cp = cachePath(sessionFile)
    if (!fs.existsSync(cp)) return { hasIndex: false, indexEntries: null, indexBuiltAt: null }
    const j = JSON.parse(fs.readFileSync(cp, 'utf8'))
    return { hasIndex: true, indexEntries: j.entries?.length ?? null, indexBuiltAt: j.savedAt || j.builtAt || null }
  } catch { return { hasIndex: false, indexEntries: null, indexBuiltAt: null } }
}

/**
 * 列本机所有对话。
 *
 * @returns {{ok:boolean, root:string, sessions:Array, why?:string}}
 * 每条：{ id, file, cwd, title, mb, updatedAt, hasIndex, indexEntries, indexBuiltAt }
 *
 * ⚠️ 标题来自会话日志里的 `session/title` 事件（见 `titleOf`），**不是编的**。
 *    没写过标题的会话（空会话）`title` 为空串 ⇒ 界面用 id 兜底并标明。
 */
export async function listSessions() {
  const out = []
  let dirs = []
  try { dirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }) } catch (e) {
    return { ok: false, root: SESSIONS_ROOT, sessions: [], why: `会话目录读不动：${e?.message || e}` }
  }
  const titles = titleMap()          // ⚠️ 只解析一次（见 titleMap 的 mtime 缓存）
  const wsTable = workspaceTable()   // 工作区名与成员关系
  // sessionId → 工作区名（DSH 自己记的），供界面直接显示「dswork」而不是路径
  const wsOfSession = new Map()
  for (const w of wsTable) for (const sid of (w.sessionIds || [])) wsOfSession.set(sid, w.title || w.path || '')
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const wdir = path.join(SESSIONS_ROOT, d.name)
    let subs = []
    try { subs = fs.readdirSync(wdir, { withFileTypes: true }) } catch { continue }
    for (const s of subs) {
      if (!s.isDirectory()) continue
      const file = path.join(wdir, s.name, 'session.jsonl.zstd')
      let st = null
      try { st = fs.statSync(file) } catch { continue }          // 没有日志的会话目录跳过
      const hb = headBufOf(file)    // 只用来取 cwd
      const idx = await indexInfoOf(file)
      const cwd = (hb ? readSessionHead(file, hb) : null)?.cwd || ''
      out.push({
        id: s.name,
        file,
        cwd,
        // 优先用 DSH 的权威标题；拿不到就不编（界面会显示 id 片段，不假装有名字）
        title: titles.get(s.name) || '',
        workspace: wsOfSession.get(s.name) || (cwd ? path.basename(cwd) : ''),
        mb: +(st.size / 1048576).toFixed(2),
        bytes: st.size,
        updatedAt: st.mtimeMs,
        ...idx,
      })
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return { ok: true, root: SESSIONS_ROOT, sessions: out }
}

/** 哪个是**最新的一场**（落点默认候选）—— 按最后写入时间 */
export function newestOf(sessions) {
  let best = null
  for (const s of sessions) if (!best || s.updatedAt > best.updatedAt) best = s
  return best
}

/**
 * 结合配置，算出界面要显示的一整份状态。
 *
 * @param {string|null} currentSessionId 当前正在进行的会话 id（用于标"现在就这场"）
 * @returns {{enabled:boolean, anchor:string|null, selected:Array, sessions:Array, groups:Array, ready:boolean, why:string}}
 *   `ready` = 落点选好了没有。**`ready===false` ⇒ 开关即使写了 true 也不生效**（④）。
 */
export async function contextState(currentSessionId = null) {
  const { cfg, ok, why } = readContexts()
  const ls = await listSessions()
  const byId = new Map(ls.sessions.map((s) => [s.id, s]))

  // 选中的会话（**过滤掉已不存在的**，并报出来）
  const selected = (cfg.selected || []).filter((id) => byId.has(id))
  const missing = (cfg.selected || []).filter((id) => !byId.has(id))

  // 落点：配置里写的那个；没写就取选中集合里最新的一场
  let anchor = cfg.anchor && byId.has(cfg.anchor) ? cfg.anchor : null
  if (!anchor && selected.length) anchor = newestOf(selected.map((id) => byId.get(id)))?.id || null

  const ready = !!anchor
  // ⚠️ 开关的两道闸：① 用户打开了 ② **落点选好了**（作者④：选好之前不启动）
  const enabled = !!cfg.enabled && ready

  // 按**工作区名**分组（照侧边栏的结构：工作区 → 缩进的会话）
  // ⚠️ 优先用 DSH 记的工作区名（`dswork`），而不是完整路径（`D:\dswork`）——
  //    实测作者看到的侧边栏就是前者，界面必须与它一致，否则他会以为"这不是我那些对话"。
  const groups = []
  const gmap = new Map()
  for (const s of ls.sessions) {
    const title = s.workspace || s.cwd || '未分组'
    const key = s.workspace || s.cwd || ''
    if (!gmap.has(key)) { const g = { key, title, sessions: [] }; gmap.set(key, g); groups.push(g) }
    gmap.get(key).sessions.push(s)
  }
  for (const g of groups) g.sessions.sort((a, b) => b.updatedAt - a.updatedAt)

  /**
   * ★ 结论文案（2026-10-16 重写）。
   *
   * 作者原话：「**我没有从中提取到任何有效信息**」—— 那说的是上一版结论：
   *   `语境区有 1 场，落点是 session-cc7a93da-25a7-4c33-bac4-eaa6d99c826a`
   * 它有三个毛病，**第三个最要紧**：
   *   ① 落点写成 id ⇒ 使用者认不出那是哪场对话；
   *   ② 只陈述"有几场" ⇒ 是数据，不是结论；
   *   ③ **没说"所以现在怎样、你要做什么"** ⇒ 读者只能自己把数据推成结论。
   *
   * ⇒ 原则：结论必须说**「现在的实际行为」+「你需要做什么」**，而不是「有哪些数据」。
   *   所以下面每一句都带这两样；**没待办的就明说"不用管它"**（沉默必须是说出来的结论）。
   */
  const nameOf = (id) => byId.get(id)?.title || byId.get(id)?.workspace || id
  const names = selected.slice(0, 3).map(nameOf).join('、')
  const moreThan3 = selected.length > 3 ? ` 等 ${selected.length} 场` : ''

  const whyText = !ls.ok
    ? `读不到对话清单（${ls.why}）⇒ 这一块现在给不出结论`
    : !ok
      ? why
      : cfg.enabled && !ready
        ? '开关打开了，但**还没选"这一区最新的是哪一场"**⇒ 暂不启动，行为和以前一样。你要做的是：在下面把那一场选出来。'
        : !selected.length
          ? '语境区是空的 ⇒ 只在**你现在这场**对话里找东西。和以前完全一样，不用管它。'
          : missing.length
            ? `有 ${missing.length} 场对话已不在这台机器上，已自动忽略。其余 ${selected.length} 场照常。`
            : enabled
              ? `以后找东西会翻这 ${selected.length} 场：${names}${moreThan3}。`
                + `（以【${nameOf(anchor)}】为"现在"）每场第一次要看几秒到几十秒，之后就有记忆了。`
              : `你勾了 ${selected.length} 场（${names}${moreThan3}），但**上面那个开关没打开** ⇒ 它们还不会被用到。`
                + `想启用就把开关勾上。`

  return {
    enabled,
    anchor,
    anchorName: anchor ? nameOf(anchor) : null,
    anchorInfo: anchor ? byId.get(anchor) : null,
    selected,
    missing,
    sessions: ls.sessions,
    groups,
    currentSessionId,
    ready,
    why: whyText,
    file: CONTEXTS_FILE,
    configExists: readContexts().exists,
  }
}
