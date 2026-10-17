/**
 * dsh-alert-inject — host half（v3：真工具 + 静态前置指令）
 *
 * 四版演进与各自的栽跟头（定论，2026-10-15）：
 *   v1 `systemPrompt.context` 每轮把判据命中注回上下文 → 自我喂食闭环；且读 reasoning 通道。
 *   v2 `agent/pre-step` 往对话【最前面】插消息 → system 之后全体错位一格，
 *      而 DeepSeek 硬盘缓存要求「从第 0 个 token 起完整匹配」⇒ 整段前缀缓存全废。
 *      （⚠️ dsh-openviking 的自动召回也是这么写的，它每轮都在打断缓存。）
 *   v3（当前）注册真工具 `alert_check` + 一句【静态】前置指令 → 落在缓存前缀里，不打断缓存。
 *   v4 输出改为【只报计数与位置，不回显触发词】——避免把命中词注回上下文再被匹配。
 *
 * ⚠️ 关于 reasoning 通道（2026-10-15 修正，原注释表述不准）：
 *   危险的是【往 reasoning 通道注入】，不是【读取】。读取无害（作者确认）。
 *   强制回传只发生在【带工具调用的轮次】（见 dsh-llm-deepseek/lib/types/serialize.d.ts：
 *   "Assistant reasoning is replayed as reasoning_content only on tool-call turns"）。
 *   ★ 实测：会话日志【确实记录】思考 —— `assistant/message` 的 content[] 里有
 *     {type:'reasoning', text}（与正文同结构），另有 `reasoning-chunks` 事件。
 *   ⚠️ 我一度误判"日志里没有思考"，原因是查的那个会话没开 thinking（reasoningEffort=off）。
 *     教训：**找不到证据 ≠ 事件没发生，先验证通道当时开没开**（本项目 §110/§111）。
 *   ★ 作者的实测覆盖率：`off` → 0%（只抓思考则哨兵全瞎）；`high` → 69%（仍有 31% 盲区）
 *     ⇒ **必须四源同抓（思考/正文/工具/用户），不能只靠思考。**
 *
 * ⚠️ v2 遗留：`createAlertMessage` 已无调用点（v3 用工具，不插消息），仅为历史留档。
 * ⚠️ `id: randomUUID()` 若将来恢复 v2 路线是硬要求，缺了会让整个会话加载失败
 *    （SessionPersistenceCorruptionError）。
 * ⚠️ 只在绑定的工作区生效；未绑定的工作区一律返回空串。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { config, matchesWorkspace, judgesPath, termsPath, BUNDLED_JUDGES_PATH } from './config.js'
// ⚡ 直呼用的称呼（从 `profile/ai.md` 取）。⚠️ `db.js` 只依赖 node 内置 + 本模块外的东西 ⇒ 无循环依赖。
import { pickAgentName } from './db.js'
import { splitBlocks, indexBlockMap, currentBlock, inScope } from './blocks.js'
import { readSessionText } from './inflate.js'
import { recordHits, writeLastRun } from './shadow.js'

/**
 * ⚠️⚠️ `@deepseek-ai/dsh-tools` 必须在 `apply()` 里**动态载入**（2026-10-15 发布前修正）⚠️⚠️
 *
 * 原先写在**顶层静态 import**。后果实测：
 *   脱离 DSH 环境运行任何脚本（例如自测）会直接：
 *     `Cannot find package '@deepseek-ai/dsh-tools' imported from …/lib/index.js`
 *   ⇒ **整个模块加载失败** ⇒ 别人 clone 下来**连自测都跑不了**。
 *   ⇒ 而本插件**绝大多数功能并不需要 DSH**（判据扫描、重复检测、引用检查、
 *     知识层遍历…全是纯程序）。**只为了两个工具的注册，就让整个包不可独立运行，
 *     代价与收益不成比例。**
 * ⇒ 故改为：模块顶层**零 DSH 依赖**；只在 `apply()` 里按需载入。
 */
let _defineTool = null
async function getDefineTool() {
  if (_defineTool) return _defineTool
  const m = await import('@deepseek-ai/dsh-tools')
  _defineTool = m.defineTool
  return _defineTool
}

export const name = 'alert-inject'
export const inject = ['systemPrompt', 'tools']

/**
 * ⚠️ 2026-10-15 配置化：原来这里硬编码了工作区与项目路径 ——
 *    `WORKSPACES = [/某个项目名/i, …]`、`PROJECT = '某个具体路径'`。
 *    ⇒ 后果：**别人 clone 下来什么都不做，而且静默**（工作区不匹配即返回空串）。
 *     这与作者装过的记忆库"感觉不好、没能实现"是同一类门槛。
 *    ⇒ 现在全部走 `config.js`：**零配置可跑**（空 workspaces = 全部生效；
 *      projectRoot 默认由会话 cwd 推断），配错可用 `diagnose()` 明确报出来。
 */

/**
 * ⚠️ 本会话 cwd 的缓存（2026-10-15 修 BUG，**这是最严重的一条**）——
 *
 *   `alert_check` 的 `execute` **拿不到 context**（见 PLUGIN.md），
 *   过去它退到 `process.cwd()` —— 那是 **DSH 进程的启动目录**，不是当前项目。
 *   实测后果（本机复现）：
 *     · `latestSessionFile(cwd)` 找不到会话 ⇒ `acts = 0`
 *     · `acts = 0` ⇒ 所有依赖会话的检测器**全部跳过** ⇒ `text = ''`、`skipped = 0`
 *     · ⇒ 工具返回「✅ 无异常」**且不带任何提示**
 *   ⇒ **看起来完全正常，实际什么都没查**（而且要采集的样本也一条不采）。
 *   这与"社区评测者指出'另有 N 项未运行'那句从没出现过"是同一个症状。
 *
 *   ⇒ 解法：由 `ctx.systemPrompt.variable` 的回调顺手记下会话 cwd
 *     —— 那个回调**能拿到 context**（它每轮组装时求值，`evaluated per assembly`）。
 */
let _sessionCwd = null

/**
 * 解析「这次该查哪个项目根」。优先级：
 *   ① 环境变量 `DSH_ALERT_CWD`　② 配置文件 `projectRoot`
 *   ③ **本会话的 cwd**（新增，才是正确的默认）
 *   ④ 进程 cwd（**最后兜底，通常不可靠** —— 见 `_sessionCwd` 的注释）
 */
function resolveCwdForTool() {
  return process.env.DSH_ALERT_CWD || config().projectRoot || _sessionCwd || process.cwd()
}

/** 解析本项目根：显式配置优先，否则用会话 cwd（零配置） */
function resolveRoot(cwd) {
  const c = config()
  return c.projectRoot || cwd || null
}

const SESS_ROOT = path.join(os.homedir(), '.dsh', 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * ⚠️ 本地 `inflate()` 已移除（2026-10-17）—— 移到 `inflate.js`。
 *
 *   原因（实测）：这一份和 `anchor.js` 里的那份**完全相同**，而两处**各自解压同一个文件**。
 *   20 MB / 43,798 帧的会话：单次全量解压 **2,782 ms**，一次 `buildReport` 就花掉约 5 秒在重复解压上。
 *   ⇒ 统一到 `inflate.js` 的 `readSessionText()`，按 `文件+大小` 缓存，两处共用一次解压。
 *
 *   ⚠️ 下面 `readSessionHead()` 仍用 `MAGIC`/`zlib`：它**只读文件头的第一帧**取 cwd，
 *      那是刻意的优化，不是重复实现。
 */

/**
 * ⚠️ 数据源读取状态（同 loadJudges 的做法，2026-10-16 修，见 TODO §17）：
 *   区分「**这个工作区没有会话**」（正常）与「**会话读不动/解压失败**」（坏了）。
 *   后者现在会静默返回 `''`，被调用方当成「✅ 无异常」——
 *   而本项目**真的出过会话文件损坏**（连环损坏那次），所以这条不是假想。
 */
let sourceState = { status: 'ok', detail: '' }

function latestSessionFile(cwd) {
  const cands = []
  let roots = []
  try { roots = fs.readdirSync(SESS_ROOT) } catch (e) {
    sourceState = { status: 'unreadable', detail: `会话目录读不动：${SESS_ROOT}（${e?.message || e}）` }
    return null
  }
  for (const ws of roots) {
    const wd = path.join(SESS_ROOT, ws)
    try { if (!fs.statSync(wd).isDirectory()) continue } catch { continue }
    for (const sid of fs.readdirSync(wd)) {
      const f = path.join(wd, sid, 'session.jsonl.zstd')
      try { cands.push({ f, m: fs.statSync(f).mtimeMs }) } catch { /* 没有就没有 */ }
    }
  }
  cands.sort((a, b) => b.m - a.m)
  // ⚠️⚠️ 修复 2026-10-15：**不要用固定数字截断候选** ⚠️⚠️
  //   旧代码是 `cands.slice(0, 6)` —— 把【全部工作区】的会话混在一起按 mtime 排序后只查前 6 个。
  //   实测：D:\dswork 下有 30 个会话，但最近 6 个里混进了别的工作区，
  //   于是 latestSessionFile('D:\dswork') 返回 null，插件【永远拿不到数据】——
  //   而它表现为"没有命中所以不报警"，与"数据源正常但确实无异常"长得一模一样。
  //   ⇒ 先按目录名粗筛（dsh 把路径转义成 --D-dswork-- 这种形式），再逐个核对会话头里的 cwd。
  //   ⇒ 每条候选都必须真的核对 cwd，绝不用"最近 N 个"这种与正确性无关的启发式。
  const escapeWsDir = (p) => {
    const abs = path.resolve(p)
    // dsh 的目录命名：非 ASCII 转成 ~XXXX~ 形式的码点，分隔符转成 -
    const enc = abs.replace(/[^\x20-\x7E]/g, (ch) =>
      '~' + [...ch].map((c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join('~') + '~')
    return enc.replace(/[\\/:]/g, '-')
  }
  const wanted = cwd ? escapeWsDir(cwd) : null

  const ordered = wanted
    ? [...cands].sort((a, b) => {
        // 优先看目录名与目标 cwd 相符的；其余仍按 mtime 兜底排在后面
        const aw = path.basename(path.dirname(path.dirname(a.f))) === wanted ? 0 : 1
        const bw = path.basename(path.dirname(path.dirname(b.f))) === wanted ? 0 : 1
        return aw - bw || b.m - a.m
      })
    : cands

  for (const c of ordered) {                     // ⚠️ 全量遍历，不截断
    try {
      // ⚠️ 性能修复（2026-10-15 风险审计）：原来 `fs.readFileSync(c.f)` **整个读入**，
      //   而这里**只需要第一帧的 header**（.zstd 是多帧追加，header 在最前面）。
      //   实测：114 个会话共 157 MB，最大单文件 26.75 MB ⇒ 纯浪费，且随会话数线性增长。
      const head = readSessionHeader(c.f)
      if (!head) continue
      const headCwd = String(head.cwd || '')
      if (!matchesWorkspace(headCwd)) continue
      if (cwd && path.resolve(headCwd) !== path.resolve(cwd)) continue
      return c.f
    } catch { /* 解析失败试下一个 */ }
  }
  return null
}

/**
 * 只读会话文件的【头部若干字节】取出第一帧 header。
 * ⚠️ 不读整个文件：实测最大会话 26.75 MB，而 header 只需开头几十字节。
 * @returns {object|null} header 对象（含 cwd 等字段）
 */
function readSessionHeader(file, { initial = 16 * 1024, maxBytes = 4 * 1024 * 1024 } = {}) {
  let fd
  try {
    const st = fs.statSync(file)
    const size = st.size
    fd = fs.openSync(file, 'r')
    let cap = Math.min(initial, size)
    for (;;) {
      const buf = Buffer.allocUnsafe(cap)
      const n = fs.readSync(fd, buf, 0, cap, 0)
      const b = buf.subarray(0, n)
      const i = b.indexOf(MAGIC)
      if (i !== -1) {
        const j = b.indexOf(MAGIC, i + 1)
        // 找到完整的第一帧 ⇒ 解压
        if (j !== -1) {
          try {
            const txt = zlib.zstdDecompressSync(b.subarray(i, j)).toString('utf8')
            const first = txt.split('\n')[0]
            if (first) return JSON.parse(first)
          } catch { /* 帧不完整，扩大再试 */ }
        }
      }
      // 没找到完整帧 ⇒ 扩大窗口（上限 maxBytes，防极端情况无限读）
      if (cap >= Math.min(maxBytes, size)) return null
      cap = Math.min(cap * 4, maxBytes, size)
    }
  } catch { return null } finally { if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* ignore */ } } }
}

/**
 * 取最近的痕迹。**四源同抓：思考 / 正文 / 工具调用 / 用户发言。**
 *
 * ⚠️ 关于 reasoning 通道（2026-10-15 两次修正，最终结论）：
 *   ① 危险的是【往 reasoning 通道注入】，不是【读取】。读取无害 —— 作者确认。
 *      强制回传只发生在【带工具调用的轮次】（dsh-llm-deepseek/lib/types/serialize.d.ts：
 *      "Assistant reasoning is replayed as reasoning_content only on tool-call turns"）。
 *   ② ★ 曾一度写下"日志里根本不存在思考文本"——**那是错的**，是采样偏差：
 *      当时查的会话没开 thinking（reasoningEffort=off），于是 reasoning 块为 0。
 *      实测（开思考后）：`assistant/message` 的 content[] 里有 {type:'reasoning', text}，
 *      字段结构与正文【完全相同】；另有 `reasoning-chunks` 事件（含逐 token 的 dt/texts）。
 *      实测计数：某会话 434 处 reasoning、85/39 个块。
 *      ⇒ 教训：**找不到证据 ≠ 事件没发生，要先验证通道当时开没开。**
 *   ③ 作者的实测：`reasoningEffort=off` 时 reasoning 覆盖率 0%（哨兵全瞎）；
 *      `high` 时覆盖率 69%（仍有 31% 盲区）⇒ **必须多源同抓，不能只靠思考**。
 */
/**
 * 取痕迹。
 * @param limit 0（默认）= **全量**，视野不设限。
 *
 * ⚠️ 原默认值是 8 —— 实测这是"插件从来没报过"的直接原因：
 *   limit=8  → 判据命中 **0 次**
 *   limit=50 → 1 次 ｜ 200 → 4 次 ｜ **全量(1058) → 12 次**
 *   而耗时几乎不变（394~446ms，时间花在读文件+解压，不在匹配）。
 *   ⇒ 视野从 8 调到全量是【纯赚】：多报 12 条，耗时不变。
 *   与"隐藏超长上下文里、模型察觉不到"的设计目标直接相关——只看 8 条，
 *   看到的全是模型自己还记得的东西，等于什么都没做。
 */
function recentActivity(file, limit = 0) {
  /**
   * 走共享解压（inflate.js）。**试过「只解尾部」，结论是不可用** —— 见 inflate.js
   * 的 readSessionTail 注释：一条痕迹平均占 12.4 帧，要 3500 条就得接近全量帧数。
   * ⇒ 现在老老实实全量解压一次，靠缓存让 anchor 那边复用（0 成本）。
   */
  const fullText = readSessionText(file)
  if (fullText == null) {
    sourceState = { status: 'unreadable', detail: '会话文件读不动或解压失败' }
    return []
  }

  const parseAll = (txt) => {
    const acc = []
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue
      let r; try { r = JSON.parse(line) } catch { continue }
      /**
       * ⚠️⚠️ 【必须挡非对象 —— 2026-10-17 由 `tools/check-robustness.mjs` 测出的真 bug】
       *
       *   `JSON.parse` 对**合法的非对象 JSON** 不报错：`'null'`→null、`'0'`→0、
       *   `'"str"'`→'str'、`'true'`→true、`'[]'`→[]。下一行读 `r.type` 直接抛 TypeError，
       *   而抛错位置在循环里没有被 try 包住 ⇒ **整场会话一条都读不出来**。
       *   （本项目真的有过会话文件损坏的历史。）
       */
      if (!r || typeof r !== 'object') continue
      if (r.type === 'assistant/message') {
        for (const c of (r.data?.message?.content || [])) {
          if (c.type === 'reasoning' && c.text?.trim()) acc.push({ kind: '思考', text: c.text })
          else if (c.type === 'text' && c.text?.trim()) acc.push({ kind: '正文', text: c.text })
        }
      } else if (r.type === 'tool/call') {
        const d = r.data || {}
        acc.push({ kind: '工具', text: `[工具调用] ${d.name || ''} ${String(d.arguments || '').slice(0, 300)}` })
      } else if (r.type === 'user/message') {
        const m = r.data?.message || r.data || {}
        if (m.source?.kind === 'plugin') continue
        const parts = []
        for (const c of (m.content || [])) {
          if (typeof c === 'string') parts.push(c)
          else if (c?.type === 'text' && c.text) parts.push(c.text)
        }
        const t = parts.join('\n').trim()
        if (t) acc.push({ kind: '用户', text: t })
      }
    }
    return acc
  }

  const acts = parseAll(fullText)
  return limit > 0 ? acts.slice(-limit) : acts
}


// ── 判据（读项目的 json；带 mtime 缓存，改判据不用重启）──
/**
 * 当前数据源能提供的 kind。
 * ⚠️ 曾误删「思考」——因一次采样偏差（当时会话没开 thinking）而误判"日志里没有思考"。
 *    实测开思考后 reasoning 块正常存在 ⇒「思考」有效，见 recentActivity 注释。
 * 保留本集合的意义：判据表里若写了集合外的 kind（拼写错 / 新来源尚未实现），要显式告警。
 */
const PROVIDED_KINDS = new Set(['思考', '正文', '工具', '用户'])

let judgeCache = { key: '', val: { meta: [], judges: [] } }
/**
 * ⚠️ 读取状态：让调用方能区分「**没配**」与「**在、但读不动**」（2026-10-16 修，见 TODO §17）。
 *   · `missing`    = 找不到（零配置的正常情形）⇒ **有意静默**，其余功能不受影响
 *   · `unreadable` = 文件在、却读不动/解析失败 ⇒ **坏了，必须出声**
 *     —— 否则 `alertText` 返回空，会被误读成「✅ 无异常」（本项目第一条硬规则）
 */
let judgeReadState = { status: 'ok', file: null, error: null }

/**
 * 读判据表 —— ⚠️ **两份合并**（2026-10-16 修，这是「出厂带通用常识」能不能成立的关键）。
 *
 * ══ 为什么必须合并，而不是"项目表优先、出厂表兜底" ══════════════════
 *   我把"出厂判据表"实现成**兜底**时，实测的后果是：
 *   **使用者一旦配了自己那份判据表，出厂那 5 条通用判据就彻底消失** ——
 *   而作者要的是「**出厂带一点通用常识 ＋ 你所有的都能配**」＝ **两者共存**。
 *
 * ══ 合并规则 ══════════════════════════════════════════════════
 *   · **项目的先读** ⇒ 同 `id` 时**项目覆盖出厂**（使用者能覆盖任何一条通用判据）
 *   · **`meta`（自指防护词）取并集** ⇒ 两份的防护都生效
 *   · **一份坏、另一份好** ⇒ 用好的那份，但**必须 console.warn 留痕**（§239）
 *   · **两份都读不动** ⇒ `unreadable`（调用方要出声）
 *
 * @param projectRoot 不给则用配置里的 projectRoot（或调用方已解析的根）
 */
function loadJudges(projectRoot) {
  const f = judgesPath(projectRoot)
  const sources = []
  if (f) sources.push(f)
  // ⚠️ 出厂那份：只要**不是同一个文件**，就一并合并进来（这就是"通用常识"落地的地方）
  if (BUNDLED_JUDGES_PATH && f !== BUNDLED_JUDGES_PATH && fs.existsSync(BUNDLED_JUDGES_PATH)) {
    sources.push(BUNDLED_JUDGES_PATH)
  }
  if (!sources.length) {
    judgeReadState = { status: 'missing', file: null, error: null }
    return { meta: [], judges: [] }
  }

  // 缓存 key 必须含**每一份**的路径+时间，否则改了其中一份不会重读
  let key = ''
  try {
    for (const s of sources) { const st = fs.statSync(s); key += `${s}:${st.mtimeMs}:${st.size}|` }
  } catch { key = '' }                       // 取不到时间 ⇒ 不走缓存，直接读
  if (key && judgeCache.key === key) return judgeCache.val

  const byId = new Map()                     // 同 id 先到者优先（项目先读 ⇒ 项目覆盖出厂）
  const metaSet = new Set()
  const errors = []
  for (const src of sources) {
    try {
      const j = JSON.parse(fs.readFileSync(src, 'utf8'))
      for (const m of (j.meta || [])) metaSet.add(m)
      for (const jd of (j.judges || [])) {
        if (jd.enabled === false) continue
        if (byId.has(jd.id)) continue         // 被更靠前的那份覆盖了
        // ⚠️ 显式告警：判据声明了数据源给不出的 kind ⇒ 该判据【永远不触发】。
        //    这是静默失效，必须出声 —— 否则"没报警"会被误读成"没问题"。
        for (const s of (jd.sources || [])) {
          if (!PROVIDED_KINDS.has(s)) {
            console.warn(
              `[alert-inject] 判据「${jd.id}」声明 sources 含「${s}」，` +
              `但当前数据源只提供 ${[...PROVIDED_KINDS].join('/')} —— 该来源将【永不匹配】。`
            )
          }
        }
        byId.set(jd.id, jd)
      }
    } catch (e) {
      errors.push(`${src}：${e?.message || e}`)
    }
  }

  const judges = [...byId.values()]
  if (!judges.length && errors.length) {
    // 两份都没读到 ⇒ 这是"坏了"，不是"没配"
    judgeReadState = { status: 'unreadable', file: sources.join(' ＋ '), error: errors.join(' ／ ') }
    return { meta: [], judges: [] }
  }
  if (errors.length) {
    // ⚠️ 一份坏、一份好 ⇒ 照用好的那份，但**降级必须留痕**（§239）
    console.warn('[alert-inject] ⚠️ 有判据表读不动（其余那份已生效）：' + errors.join(' ／ '))
  }
  const val = { meta: [...metaSet], judges }
  if (key) judgeCache = { key, val }
  // 状态用"主表"（sources[0]）的位置，若它读失败而另一份成功，仍记为 ok 但已 warn 过
  judgeReadState = { status: 'ok', file: sources.join(' ＋ '), error: null }
  return val
}

// ── 术语表（与门）：术语名短形式 ＋ 别名（剥 `!`）──
let termCache = { key: '', val: [] }
/** 术语表读取状态（同上：区分「没配」与「读不动」） */
let termReadState = { status: 'ok', file: null, error: null }
/** 读术语表词表（加 mtime 缓存）。⚠️ 导出供 novelty.js 复用，避免重复实现。 */
export function loadTermWords(projectRoot) {
  const F = termsPath(projectRoot)
  // ⚠️ 旧注释写「无术语表 ⇒ 与门失效（判据会变**宽松**）」—— **是反的**（2026-10-16 实测，见 TODO §17）：
  //   命中判断是 `if (j.requireTermHit && !termHit.length) continue`，
  //   术语表为空 ⇒ `termHit` 必为空 ⇒ **带与门的判据永不触发**，实际是变【严】（全哑）。
  if (!F) {
    termReadState = { status: 'missing', file: null, error: null }
    return []
  }
  try {
    const st = fs.statSync(F)
    const key = `${F}:${st.mtimeMs}:${st.size}`
    if (termCache.key === key) return termCache.val
    const words = new Set()
    for (const line of fs.readFileSync(F, 'utf8').split('\n')) {
      if (!line.startsWith('|')) continue
      const c = line.split('|').map((s) => s.trim())
      if (c.length < 9 || !c[2] || c[2] === '主档' || /^-+$/.test(c[2])) continue
      const short = c[1].includes('·') ? c[1].split('·').pop().trim() : c[1]
      if (short && short.length >= 2) words.add(short)
      if (c[1] && c[1].length >= 2) words.add(c[1])
      for (const a of (c[3] || '').split(/[、,，\/]/)) {
        const t = a.trim().replace(/^!/, '')
        if (t.length >= 2) words.add(t)
      }
    }
    const val = [...words]
    termCache = { key, val }
    termReadState = { status: 'ok', file: F, error: null }
    return val
  } catch (e) {
    termReadState = { status: 'unreadable', file: F, error: e?.message || String(e) }
    return []
  }
}

/**
 * 组装警报文本；没有命中则返回 ''（此时工具返回"无异常"）。
 *
 * @param cwd 会话工作目录
 * @param sessionFileOverride 测试/调试用：指定任意会话
 * @param actsOverride **性能关键**：调用方若已读过痕迹，直接传进来 ——
 *   读全量会话（解压+解析 1116 条）实测 **485ms**，而总装报告会多次需要它。
 *   首版没传，导致同一份会话被读三次（3×450ms）⇒ 自查总耗时一度达 3.7 秒。
 * 旧格式是【逐条报】：`- 第 N 处 · <判据> · 检出 X 处`
 * 视野从 8 条放到全量后，逐条报会产出十几行 —— 会话越长行数越多，最终淹没模型。
 * ⇒ 改成【按判据汇总】：每个判据一行，输出行数 = 命中判据数，**与会话长度无关**。
 *    信息量保留：检出次数 / 最早与最近位置 / 来源通道 / 涉及的档。
 *
 * ⚠️⚠️ 铁律：**只报计数与位置，不回显命中的触发词**（REPORT.md §二·v4）。
 *   旧格式把触发词写回上下文，而判据下一轮会重新匹配它们 ——
 *   报一次 = 往上下文植入一轮样本 = 自我喂食闭环。这是本插件 v1~v3 的病因之一。
 *   判据 id 可以报（它是内部标签，不在判据表里，不会被匹配）。
 *   术语名可以报（它是"与门"用的档名，同样不是判据信号词）。
 *
 * ⚠️ 另修一处：旧代码写 `hits.length`，而 `hits` 上一轮已被改成数字，
 *   结果是输出"检出 undefined 处"——**不抛异常，但内容错**。
 *   （教训：改完只验证"不崩"是不够的，必须验证**输出内容**。）
 */
const MAX_SCAN = +(process.env.DSH_ALERT_MAX_SCAN || 0)   // 0 = 全量
const MAX_JUDGE_LINES = +(process.env.DSH_ALERT_MAX_LINES || 8)

function alertText(cwd, sessionFileOverride, actsOverride, opts = {}) {
  const root = resolveRoot(cwd)                    // 配置优先，否则用会话 cwd（零配置）
  const { meta, judges } = loadJudges(root)
  if (!judges.length) {
    // ⚠️ 区分两种「没有判据」（2026-10-16 修，见 TODO §17）：
    //   · missing（没配）⇒ **有意静默**：零配置也能跑，其余功能不受影响
    //   · unreadable（在、但读不动/解析失败）⇒ **必须出声**
    //     否则「没报警」会被误读成「✅ 无异常」—— 本项目第一条硬规则。
    if (judgeReadState.status === 'unreadable') {
      return '【自查未完成】判据表读不动：' + judgeReadState.file + '\n'
        + '  原因：' + judgeReadState.error + '\n'
        + '⇒ **本次没有做判据扫描** —— 这不代表真的没事。'
    }
    return ''
  }
  // sessionFileOverride 仅用于【测试与调试】：可指定任意会话，绕过工作区绑定。
  sourceState = { status: 'ok', detail: '' }   // ⚠️ 每轮重置，避免用到上一轮的陈旧状态
  const file = sessionFileOverride || latestSessionFile(cwd)
  if (!file) {
    // ⚠️ 区分「没有会话」（正常，零配置）与「会话目录读不动」（坏了）——见 TODO §17。
    //   后者若静默，就与「数据源正常、确实无异常」长得一模一样（§239 的形状）。
    if (sourceState.status === 'unreadable') {
      return '【自查未完成】' + sourceState.detail + ' ⇒ 本次没有做判据扫描，这不代表真的没事。'
    }
    return ''
  }
  // ⚠️ 已读过的痕迹直接复用（读全量实测 485ms；不传会重复读）
  const acts = actsOverride && actsOverride.length ? actsOverride : recentActivity(file, MAX_SCAN)
  if (!acts.length) {
    // ⚠️ 「会话是空的」（正常）与「读了但解压失败」（坏了）必须分开说（见 TODO §17）
    if (sourceState.status === 'unreadable') {
      return '【自查未完成】' + sourceState.detail + ' ⇒ 本次没有做判据扫描，这不代表真的没事。'
    }
    return ''
  }
  const termWords = loadTermWords(root)

  // ⚠️ 与门失效必须出声（2026-10-16 实测，见 TODO §17）：
  //   带 `requireTermHit` 的判据，在拿不到术语表时【永远不会触发】——
  //   而旧注释写「判据会变宽松」，**是反的**（实测是变【严】）。
  //   ⇒ 这是「判据还在、却注定不响」，属**能力缺失**，不能让它安静地失效。
  const gated = judges.filter((j) => j.requireTermHit)
  const gateBroken = gated.length > 0 && !termWords.length && termReadState.status !== 'ok'
  const gateNote = gateBroken
    ? '【自查有缺口】术语表' + (termReadState.status === 'missing' ? '未找到' : '读不动')
      + ' ⇒ ' + gated.map((j) => j.id).join('、')
      + ' 这些判据的与门失效，**本次不会触发**。'
    : ''

  // ── 语境分块（2026-10-15 加，解决"这个语境对、另一个语境没必要报"）──
  //    实测：全库命中 45 处，而**当前语境块内 0 处** ⇒ 之前报的全是别的语境的事。
  const blocks = splitBlocks(acts)
  const blockMap = indexBlockMap(blocks)
  const scope = opts.scope || 'current'          // 'current' | 'recent' | 'all'
  const lastBlock = currentBlock(blocks)

  // ── 汇总：判据 id → { count（范围内）, otherCount（范围外）, anom, pos[], kinds{}, terms:Set } ──
  const agg = new Map()
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]
    const body = `【${a.kind}】${a.text}`
    if (meta.some((w) => body.includes(w))) continue          // 自指防护
    const termHit = termWords.filter((w) => body.includes(w))
    const bi = blockMap.get(i)
    const now = inScope(bi, blocks, scope)
    for (const j of judges) {
      if (j.sources && !j.sources.includes(a.kind)) continue  // 源过滤：这条判据该看谁的痕迹
      const signals = (j.signals || []).filter((w) => body.includes(w))
      const anomalies = (j.anomalies || []).filter((w) => body.includes(w))
      const n = signals.length + anomalies.length             // ← 原为未定义变量 `hits`（ReferenceError）
      if (!n) continue
      if (j.requireTermHit && !termHit.length) continue       // 与门
      let e = agg.get(j.id)
      if (!e) { e = { count: 0, otherCount: 0, anom: 0, pos: [], kinds: {}, terms: new Set(), blocks: new Set(), shadow: !!j.shadow, detail: [] }; agg.set(j.id, e) }
      if (!now) { e.otherCount++; continue }                  // 范围外：只计数，不占输出
      e.count++
      e.anom += anomalies.length
      e.pos.push(i + 1)                                       // 1-based 位置
      e.kinds[a.kind] = (e.kinds[a.kind] || 0) + 1
      e.blocks.add(bi)
      for (const t of termHit) e.terms.add(t)
      // ⚠️ 影子判据：把命中详情留档，供作者逐条判「该报 / 不该报」。
      //    **每条痕迹每个判据只记一条**（命中多个词也合并）——
      //    否则同一处会出现多行，裁决它的人要重复判好几遍。
      if (e.shadow) {
        const allTerms = [...signals, ...anomalies]
        e.detail.push({
          judge: j.id, kind: a.kind, pos: i + 1, block: bi,
          term: allTerms[0], terms: allTerms.slice(0, 6), n: allTerms.length,
          snippet: String(a.text || '').replace(/\s+/g, ' ').slice(0, 160),
        })
      }
    }
  }
  // 只有"范围内有命中"的判据才进输出；纯范围外的判据归入一行摘要
  // ⚠️ 影子判据（`shadow:true`，见 shadow.js 的模块说明）**不进输出**，故两类分开：
  const allHit = [...agg.entries()].filter(([, e]) => e.count > 0)
  const rows = allHit.filter(([, e]) => !e.shadow)
    .sort((a, b) => b[1].anom - a[1].anom || b[1].count - a[1].count)
  const shadowRows = allHit.filter(([, e]) => e.shadow)
  const outsideTotal = [...agg.values()].reduce((s, e) => s + e.otherCount, 0)

  // ── 影子判据：**只记录、不输出** ──
  //   ⚠️⚠️ 必须在下面两道 never-worse 门控**之前**做 ——
  //     否则「当前语境只有影子命中」时函数会在第 416 行提前 return，
  //     命中根本不会被记下来 ——**那就是静默**（硬规则 1）。
  const shadowHits = shadowRows.flatMap(([, e]) => e.detail)
  const sessionTag = file ? path.basename(path.dirname(file)) : ''
  const shadowStat = recordHits(shadowHits, sessionTag)
  writeLastRun({
    session: sessionTag,
    scanned: acts.length, blocks: blocks.length, scope,
    judges: judges.length,
    shadowJudges: judges.filter((j) => j.shadow).length,
    shadowHitsInScope: shadowHits.length,
    shadowAdded: shadowStat.added, shadowSkipped: shadowStat.skipped, shadowError: shadowStat.error,
    alertedJudges: rows.length, outsideHits: outsideTotal,
  })

  // ⚠️ 门控：当前语境无命中就沉默（避免端上"我查过了"的空话）。
  //   但**能力缺失**（gateNote）不一样 —— 它必须说出来，哪怕这轮一条都没命中。
  if (!rows.length && !outsideTotal) return gateNote

  // 异常模式（anomalies，具体句式）比信号词（signals，泛词如"不对/为什么"）更硬 —— 优先展示
  const lines = []
  for (const [id, e] of rows.slice(0, MAX_JUDGE_LINES)) {
    const last = e.pos[e.pos.length - 1]
    const first = e.pos[0]
    const span = e.count > 1 ? `最早第 ${first} 处、最近第 ${last} 处` : `第 ${first} 处`
    const src = Object.entries(e.kinds).map(([k, v]) => `${k}${v}`).join('/')
    const terms = e.terms.size ? `（涉及：${[...e.terms].slice(0, 3).join('、')}）` : ''
    lines.push(`- ${id} · 检出 ${e.count} 处 · ${span} · 来源 ${src}${terms}`)
  }
  if (rows.length > MAX_JUDGE_LINES) lines.push(`- （另有 ${rows.length - MAX_JUDGE_LINES} 类判据命中，未展开）`)

  const scanned = acts.length
  // ⚠️⚠️ **never-worse 门控**（2026-10-15 验收测试催生）⚠️⚠️
  //   实测：当前语境 0 命中时，旧实现仍会输出一段
  //   "以下是当前语境内的痕迹（已扫 990 条 ／ 分 54 块）…（另有 26 处命中在其他语境里…）"
  //   —— **207 字，却一条具体所指都没有**。这是**礼貌的空话**：
  //   它等于说"我查了，没找到"，而**这句话本身不构成信息**。
  //   参照 `dsh-plugin-save-token` 的 never-worse 双门控（"任一门不过，原样放行"）：
  //   ⇒ **当前语境无命中 ⇒ 本段沉默**（不出声，而不是报告"我查过了"）。
  //     "其他语境有 N 处"这类统计也**只在真要看时才有意义**（scope=all）。
  if (scope !== 'all' && !rows.length) return gateNote
  if (scope === 'all' && !rows.length && !outsideTotal) return ''

  // ⚠️ 本模板的每一个字都要过【不回显触发词】这一关 —— 实测踩过四次（"可疑"/"矛盾·站不住"/"不要"/"错了"）。
  //   ⇒ 任何改动本模板的人，改完必须跑一次触发词泄漏检查（`leak-check.mjs`）。
  const head = scope === 'all'
    ? `【自查结果】当前语境 ／ 全库（已扫 ${scanned} 条）：`
    : `【自查结果】当前语境内有 ${rows.length} 类命中（已扫 ${scanned} 条 ／ 分 ${blocks.length} 块）：`
  const out = [head, ...lines]
  // ⚠️ 能力缺失（如与门拿不到术语表）**无论有没有命中都要说**（见 TODO §17）
  if (gateNote) out.push('', gateNote)
  if (scope === 'all' && outsideTotal) {
    out.push(`（另有 ${outsideTotal} 处在其他语境里，与当前话题可能无关）`)
  }
  out.push('', '按需核对即可；不必为它中止回答或重写整篇。')
  return out.join('\n')
}

/**
 * peek — 【指针的兑现端】。
 *
 * 设计（作者 2026-10-15 定："潜意识要再附带一个返回指针的功能"）：
 *   潜意识只给**指针**（第 N 处、什么类别、多少相似度），**不给内容** ——
 *   这正是 déjà vu 的机制：`decoupled familiarity`（熟悉感与回忆脱同步），
 *   颞叶只发"这事发生过"的信号给额叶决策区，不把内容一起送上来。
 *   然后由主模型（或模型组）**按指针主动去取**。
 *
 * ⇒ 本函数就是那个"按指针去取"的动作。它把"只报位置、无法行动"的缺口补上了。
 *
 * ⚠️ 自我喂食的边界（必须理解清楚，否则会把 v1 的瘟疫重新引入）：
 *   · 危险的是【每轮自动注入】 —— 那会让命中内容每轮都回到上下文，被判据反复匹配。
 *   · 安全的是【模型主动取一次】 —— 这是正常工具使用，模型看到历史、据此判断。
 *   · 但仍有次级风险：取回的内容进了上下文，**下一轮判据可能又匹配到它**。
 *     ⇒ 故配套要求：调用方应把 peek 过的位置记入"已报"，避免"报→取→再报"的循环。
 *       （参考 `工具\_alert-watch.js` 用 seq 去重的既有做法 —— 别重复造。）
 *
 * @param sessionFile 会话文件
 * @param pos 1-based 位置（与 alertText / librarian 报的编号【同一套】）
 * @param opts.maxChars 截断长度（默认 1200，避免一次取回过多）
 * @returns {null | {pos, kind, text, truncated, total}}
 */
function peek(sessionFile, pos, opts = {}) {
  const maxChars = opts.maxChars ?? 1200
  let acts
  try { acts = recentActivity(sessionFile, 0) } catch { return null }   // ⚠️ 必须 limit=0，否则编号会错位
  const i = Number(pos) - 1
  if (!Number.isInteger(i) || i < 0 || i >= acts.length) {
    return { pos, kind: null, text: '', truncated: false, total: acts.length, error: `位置 ${pos} 超出范围（共 ${acts.length} 条）` }
  }
  const a = acts[i]
  const full = a.text
  const truncated = full.length > maxChars
  return {
    pos: Number(pos),
    kind: a.kind,
    text: truncated ? full.slice(0, maxChars) : full,
    truncated,
    size: full.length,
    total: acts.length,
  }
}

/**
 * 把指针渲染成【可操作】的形式。
 * ⚠️ 同样遵守"不回显触发词"铁律：指针本身只含【位置 + 类别 + 数值】，不含原文。
 */
function renderPointer(items) {
  if (!items?.length) return ''
  const lines = ['【指针】按位置可回看（用 peek 取原文）：']
  for (const t of items) lines.push(`- pos=${t.pos} · ${t.kind} · 相似度 ${(t.sim * 100).toFixed(0)}%`)
  return lines.join('\n')
}

/**
 * 造一条消息，插进对话。
 * ⚠️ 必须带非空 id —— dsh 会话加载验证（assertMessageEventShape）要求 user/message
 *    携带 identified message，缺了会让**整个会话**以 SessionPersistenceCorruptionError 被拒。
 *    （照 dsh-openviking 的 createRecallMessage，一字不改这个结构。）
 */
function createAlertMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-alert-inject', form: 'alert-notify' },
  }
}

/**
 * alert_check 工具返回值的渲染 —— 【抽成独立函数】是为了能被 leak-check 直接调用。
 * ⚠️ 教训：初版这段逻辑写在 defineTool 的 render 闭包里，结果 leak-check
 *    只检查了"工具描述"、漏掉了"工具输出"，于是这里的两处触发词一直没被发现。
 *    ⇒ 凡是会进模型视野的文本，都必须放在**可被检查工具直接调用**的地方。
 * ⚠️ 本模板每个字都要过 leak-check。
 */
export function renderAlertTool(value) {
  const lines = []
  if (value?.clean) {
    lines.push('✅ 无异常——未检出需要留意的条目，可以按原计划回答。')
    // ⚠️ 透明性：必须说清"有几项没跑"，否则"无异常"会被误读成"全查过了"。
    if (value?.note) lines.push(`（${value.note}）`)
  } else {
    // ⚡ 直呼（2026-10-16 加）：称呼从 `profile/ai.md` 取（`value.agentName` 由调用方查好塞进来）。
    //    ⚠️ 取不到就**不加这一句** —— 不硬编码"agent"（在别人机器上会变成莫名其妙的话）。
    //    ⚠️ 依据：arXiv:2606.05976 —— 只改角色标签（内容逐字节相同），纠错率差 23–93 个百分点。
    let an = value?.agentName
    // ⚠️ 调用方没带就**现取** —— 否则这一行是**死代码**（写了永远不触发）
    if (!an) { try { an = pickAgentName().name } catch { an = '' } }
    if (an) lines.push(`⚡ ${an}，你想的有问题 ——`)
    lines.push('⚠️ 检出以下几处（来自本次对话较早的位置）：')
    if (value?.report) lines.push(value.report)                       // 总装报告（各检测器分段）
    else for (const it of value?.items ?? []) lines.push(`- ${it}`)   // 兼容旧的纯 items 形态
    lines.push('')
    lines.push('自查一下：**对就改，错就忽略**。不必中止回答或重写整篇。')
    if (value?.meta?.skipped?.length) {
      lines.push(`（另有 ${value.meta.skipped.length} 项未运行：${value.meta.skipped.slice(0, 3).join('；')}）`)
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * `recall` 的渲染（**抽成独立函数**，以便 leak-check 直接调用 —— 纪律同 `renderAlertTool`）。
 *
 * ⚠️ 为什么要有这个工具（作者 2026-10-17 的口径）：
 *   「**相似度留在反馈里，只是和异常一起触发，不是单独触发；
 *     如果 AI 主动想去搜索，那就去用工具。**」
 *   ⇒ 分工：
 *     · `alert_check` = **被动** —— 只在有"疑惑/重复/陌生术语"时**连带**给位置（见 report.js 的 shouldRecall）
 *     · `recall`      = **主动** —— 模型自己想知道"我说过这个吗"时才调
 *   ⚠️ 为什么不自动触发：相似度是**稳定事件**（每轮都有），按预测误差机制会被忽略
 *     （见 `DESIGN-evidence.md` 第四节）。所以它不该当背景播报，只该在被需要时查询。
 *   ⚠️ 本模板每个字都要过 leak-check。
 */
export function renderRecallTool(value) {
  if (!value?.ok) {
    const lines = [`⚠️ 查询没跑成：${value?.error || '未知原因'}`]
    if (value?.hint) lines.push(`   ${value.hint}`)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const q = String(value.query || '').slice(0, 60)
  if (!value.hits?.length) {
    /**
     * ⚠️ 硬规则 4：「找不到」≠「不存在」。
     *   这里必须把**检索面**说出来（扫了多少条、覆盖多少），
     *   否则"没找到"会被读成"从没发生过"。
     */
    const lines = [`🔍 查「${q}」：**没有相近的位置**。`]
    if (value.scanned !== undefined) {
      lines.push(`   （扫了 ${value.scanned} 条 / 覆盖 ${value.coverage === null || value.coverage === undefined ? '?' : (value.coverage * 100).toFixed(0) + '%'}）`)
    }
    lines.push('   ⇒ 这是**查过了没找到**，不等于"从来没发生过" —— 索引可能还没覆盖到那段。')
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const lines = [`🔍 查「${q}」：${value.hits.length} 处相近位置`]
  for (const h of value.hits) {
    const pct = typeof h.sim === 'number' ? (h.sim * 100).toFixed(0) + '%' : '?'
    const from = h.source ? ` · 来自【${h.source}】` : ''
    lines.push(`- pos=${h.pos} · ${h.kind} · 相似度 ${pct}${from}`)
  }
  lines.push('pos 是第几条痕迹的指针；要原文可按它回取，这里不附内容。')
  return [{ type: 'text', text: lines.join('\n') }]
}
export function renderExtractTool(value) {
  const lines = []
  if (!value?.ok) {
    lines.push(`⚠️ 抽取未成功：${value?.error || '未知原因'}`)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.mode === 'prompt') {
    lines.push(`📄 已取到文档（${value.chars} 字）：${value.file}`)
    lines.push('')
    lines.push(value.prompt)
    lines.push('')
    lines.push(value.next || '按提示词产出 JSON 后，调本工具 mode="verify" 交回来。')
  } else {
    const s = value.stats || {}
    lines.push(value.report || `📥 抽取校验：通过 ${s.nodesOk || 0} 节点 / ${s.edgesOk || 0} 边`)
    if (value.stored >= 0) lines.push(`已入待审：${value.stored} 条（**尚未生效**，需复核后才进知识库）`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * ⚠️⚠️ 工具返回值必须是【无损 JSON】（2026-10-15 挂载后首次调用即暴露）⚠️⚠️
 *
 * 实测报错：`tool "alert_check" returned invalid output: value is not lossless JSON`
 * 根因：首版写过 `{ clean:true, note: skipped.length ? '…' : undefined }`
 *   —— **`undefined` 不是合法 JSON**，DSH 会拒收整个返回值。
 * ⇒ 这一类问题**离线测不出来**（本地调用不经过 DSH 的序列化），
 *   **只有真正挂载后才会暴露** —— 这正是"必须挂载跑一次"的价值。
 * ⇒ 故：凡 `execute` 的返回值一律过这道闸（丢掉 undefined／函数／循环引用）。
 */
function toLosslessJson(v) {
  try { return JSON.parse(JSON.stringify(v === undefined ? null : v)) }
  catch { return { error: 'return value was not serializable' } }
}

export async function apply(ctx) {
  // ⚠️ `@deepseek-ai/dsh-tools` **按需载入**（见文件头说明）：
  //   顶层静态 import 会让整个模块在非 DSH 环境下加载失败，
  //   而本插件大部分功能其实不需要 DSH。
  //   ⇒ 载不到就**只跳过工具注册**，前置指令与其他功能照旧。
  let defineTool = null
  try { defineTool = await getDefineTool() } catch { /* 非 DSH 环境：跳过工具注册 */ }

  // ══════════════════════════════════════════════════════════════════════
  // v3（2026-10-15 作者定）：注册一个【真正的工具】+ 一句前置指令
  //
  // 为什么要这样（前面三版都栽了，逐个记）：
  //   v1 `systemPrompt.context` 每轮注入 → 打断前缀缓存；且读 reasoning 通道 → 招来瘟疫。
  //   v2 `agent/pre-step` 插消息 → 消息插在【最前面】，system 之后全体错位一格，
  //      而 DeepSeek 硬盘缓存要求「从第 0 个 token 起完整匹配」⇒ 整段前缀缓存全废。
  //   （⚠️ dsh-openviking 的自动召回也这么写，它每轮都在打断缓存。）
  //   v3 换成本方案：
  //     · 工具注册 —— 真调用，不伪造 tool/call（伪造＝篡改历史）
  //     · 前置指令 —— 静态文本，**落在缓存前缀里，不打断缓存**
  //     · 全程不碰 reasoning 通道 —— 不制造回声
  //
  // ⚠️ 已知代价：它依赖"我按指令去调"。这不是靠自觉，是靠每轮都在的规则。
  // ══════════════════════════════════════════════════════════════════════
  if (defineTool) try {
    ctx.tools.register(
      defineTool({
        name: 'alert_check',
        description:
          '正式回答前先自查一次：把你【即将给出】的结论同这个世界已有的设定对一遍，' +
          // ⚠️ 用词纪律：原句用了「矛盾」「站不住」—— **两者都是判据「疑惑」的信号词**，
          //    等于把触发词写进工具描述（第三次踩同类坑）。改用中性表达，改完跑 leak-check。
          '看有没有需要留意的地方、或引用了不存在的东西。没有异常也要调，返回"无异常"即可。',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (args, value) => renderAlertTool(value),   // ⚠️ 逻辑在外部，便于 leak-check 直接调用
        },
        execute: async () => {
          try {
            // ⚠️ 已知局限：execute 里拿不到 context（见 PLUGIN.md），故 cwd 由以下顺序推断 ——
            //    环境变量 → 配置文件 → **本会话 cwd**（由 systemPrompt.variable 的回调喂进来）
            //    → 进程 cwd。**不能只靠进程 cwd**：那是 DSH 的启动目录，不是当前项目，
            //    找不到会话时会让整个自查静默空转（见 `_sessionCwd` 的注释）。
            const cwd = resolveCwdForTool()
            // ⚠️ **动态 import**：report.js 会 import 本模块（取 alertText 等），
            //    顶层静态互相 import 会形成循环依赖；在函数内动态载入即可避开。
            const { buildReport } = await import('./report.js')
            const rep = await buildReport(cwd)

            if (!rep.text) {
              // 没有命中也要把"跳过了什么"带回去——否则使用者会以为"全查过了、没问题"。
              const skipped = rep.meta?.skipped || []
              // ⚠️ 不能写 `note: …… : undefined` —— undefined 不是合法 JSON，
              //    DSH 会拒收整个返回值（实测：`value is not lossless JSON`）。
              const out = { clean: true }
              const notes = []
              // ★ 2026-10-15 新增：`acts=0` = 根本没读到本会话痕迹 ⇒ **必须说出来**。
              //   否则"没查"会被读成"查过且干净"，而这正是本工具此前长期空转却不自知的原因。
              if (!rep.meta?.acts) notes.push('未读到本会话痕迹')
              if (skipped.length) notes.push(`另有 ${skipped.length} 项未运行`)
              if (notes.length) out.note = notes.join('；')
              return toLosslessJson(out)
            }
            return toLosslessJson({
              clean: false,
              items: rep.sections.map((s) => s.name),
              report: rep.text,
              meta: { sections: rep.sections.length, used: rep.used, skipped: rep.meta?.skipped || [] },
            })
          } catch (e) {
            // ⚠️⚠️ 不能静默伪装成"无异常"（2026-10-15 修）——那会让使用者以为"全查过了、没问题"，
            //    而实际是**工具坏了**。透明性是本工具反复写下的纪律
            //    （见 renderAlertTool：「必须说清'有几项没跑'」）。
            // ⚠️ 但**不回显错误详情**：错误消息内容不可控，可能带判据触发词，
            //    回显就等于再喂给下一轮（本项目第五次踩同类坑）。详情走 stderr/console。
            console.warn('[alert-inject] alert_check 未运行：', e instanceof Error ? e.message : String(e))
            return toLosslessJson({ clean: true, note: '自查未运行' })   // ⚠️ 不带括号：renderAlertTool 会包
          }
        },
      })
    )
  } catch (e) {
    console.warn('[alert-inject] alert_check 注册失败：', e instanceof Error ? e.message : String(e))
  }

  // ══════════════════════════════════════════════════════════════════════
  // recall —— **主动查**（2026-10-17 加，作者口径）
  //
  // ⚠️ 与 `alert_check` 的分工（**不要合并**，它们触发方式相反）：
  //    · `alert_check` = **被动**：只在"疑惑/重复/陌生术语"时**连带**给相似位置
  //    · `recall`      = **主动**：模型自己想知道"我说过这个吗"时才调
  //   作者原话：「相似度留在反馈里，只是和异常一起触发，不是单独触发；
  //              **如果 AI 主动想去搜索，那就去用工具。**」
  //
  // ⚠️ 为什么值得单独做一个工具（而不是让 alert_check 每次都给）：
  //   相似度是**稳定事件** —— 每轮都有、每轮都差不多。按预测误差机制，
  //   稳定的东西会被忽略（`DESIGN-evidence.md` 第四节）。
  //   ⇒ 放在背景里播报 = 噪音；被主动要时才给 = 信息。
  //
  // ⚠️ 诚实边界：文献实测 LLM **很少主动调用**（Knowing but Not Showing, 2026）。
  //   所以光有这个工具不够 —— 配套是 `alert_check` 在出现疑惑时给一句"可以调 recall"。
  // ══════════════════════════════════════════════════════════════════════
  if (defineTool) try {
    ctx.tools.register(
      defineTool({
        name: 'recall',
        description:
          '主动查一件事在这段对话里有没有出现过（返回相近位置）。' +
          'alert_check 只在出现异常时才给位置；想主动多查、或想确认"我是不是说过 X"时用它。' +
          '查不到会说明扫了多少条，那表示"查过没找到"，不等于"没发生过"。',
        parameters: {
          query: { type: 'string', description: '要查什么（一句话；越具体越准）' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (args, value) => renderRecallTool(value),
        },
        execute: async (args) => {
          try {
            const q = String(args?.query || '').trim()
            if (!q) return toLosslessJson({ ok: false, error: 'query 不能为空' })
            const cwd = resolveCwdForTool()
            const sf = latestSessionFile(cwd)
            if (!sf) return toLosslessJson({ ok: false, error: '找不到当前会话（cwd 可能不是会话工作区）' })
            // ⚠️ 动态 import：避免与 librarian.js 形成循环依赖（同 alert_check 的理由）
            const { loadCache, cacheState, query } = await import('./librarian.js')
            const idx = loadCache(sf)
            if (!idx) {
              const st = cacheState(sf)
              return toLosslessJson({
                ok: false,
                error: `索引还没就绪（${st.state}：${st.detail}）`,
                hint: '下一轮自查会在后台建；也可以稍后再调一次。',
              })
            }
            const r = await query(idx, q, { topK: 5 })
            return toLosslessJson({
              ok: true,
              query: q,
              hits: (r.top || []).map((t) => ({ pos: t.pos, kind: t.kind, sim: t.sim })),
              scanned: r.scanned,
              coverage: r.coverage,
              indexedTotal: r.indexedTotal,
              candidateTotal: r.candidateTotal,
            })
          } catch (e) {
            // ⚠️ 不回显错误详情（可能带触发词）；详情走 stderr —— 同 alert_check 的纪律
            console.warn('[alert-inject] recall 未运行：', e instanceof Error ? e.message : String(e))
            return toLosslessJson({ ok: false, error: '查询没跑成（详情见控制台）' })
          }
        },
      })
    )
  } catch (e) {
    console.warn('[alert-inject] recall 注册失败：', e instanceof Error ? e.message : String(e))
  }

  // ══════════════════════════════════════════════════════════════════════
  // knowledge_extract —— 知识抽取（2026-10-15 接线）
  //
  // ⚠️ 为什么是【一个工具、两种模式】而不是两个工具：
  //   工具描述会**常驻**占上下文。实测教训就在本机：`dsh-openviking` 的 15 个 MCP 工具
  //   占约 1.7k token，作者最后把它们全关掉了（见 `cordis.patch.yml` 第 69 行注释）。
  //   ⇒ 故合并：`mode='prompt'` 给提示词，`mode='verify'` 交校验。
  //
  // ⚠️ 分工不可颠倒：**插件不调 LLM**（它没有那个能力）。
  //   工具给"提示词 + 校验"，抽取本身由模型做：
  //     ① 调 knowledge_extract(mode='prompt', doc=路径)  → 拿到提示词与原文
  //     ② 模型自己产出 JSON
  //     ③ 调 knowledge_extract(mode='verify', json=...)  → 程序逐条核对证据，通过的自动入待审
  //   ⇒ 关键在③：**模型可以编，但编的会被逐字比对拦下来**（详见 `extract.js`）。
  // ══════════════════════════════════════════════════════════════════════
  if (defineTool) try {
    ctx.tools.register(
      defineTool({
        name: 'knowledge_extract',
        description:
          '从一份设定文档里抽取知识（节点与共现边），供知识库生长。' +
          '两种模式：mode="prompt" 给定文档路径，返回抽取提示词与原文；' +
          'mode="verify" 提交你按提示词产出的 JSON，由程序逐条核对证据后把合格项转入待审。',
        /**
         * ⚠️ `parameters` **不是 JSON Schema**，而是 dsh-tools 的 `ParameterSchemaSpec`
         *   （`{ 字段名: {type, description, required?, enum?} }`）。
         *   首版按 JSON Schema 写（`{type:'object', properties:{…}, required:[…]}`），
         *   注册时报 `unsupported JSON schema: parameters.type must be a value schema object`。
         *   ⇒ **照本机既有工具（`dsh-tool-ask-user`）的写法**才是对的。
         */
        parameters: {
          mode: { type: 'string', required: true, enum: ['prompt', 'verify'], description: 'prompt=取提示词；verify=交校验' },
          doc: { type: 'string', description: 'mode=prompt 时：文档路径（或相对项目根的 id）' },
          json: { type: 'string', description: 'mode=verify 时：你产出的抽取结果（JSON 字符串）' },
          source: { type: 'string', description: 'mode=verify 时：被抽取的【原文】。⚠️ 不给原文就只能做结构性校验，证据无法核对' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (args, value) => renderExtractTool(value),
        },
        execute: async (args) => {
          try {
            const root = process.env.DSH_ALERT_CWD || config().projectRoot || process.cwd()
            const K = await import('./extract.js')
            const fs2 = (await import('node:fs')).default
            const p2 = (await import('node:path')).default

            if (args?.mode === 'prompt') {
              const rel = String(args.doc || '')
              if (!rel) return { ok: false, error: 'mode=prompt 需要 doc（文档路径）' }
              const cands = p2.isAbsolute(rel) ? [rel] : [
                p2.join(root, rel),
                p2.join(root, '设定档案-JS', rel.endsWith('.js') ? rel : rel + '.js'),
                p2.join(root, rel.endsWith('.js') ? rel : rel + '.js'),
              ]
              let file = null
              for (const c of cands) { try { if (fs2.existsSync(c)) { file = c; break } } catch { /* 试下一个 */ } }
              if (!file) return { ok: false, error: `未找到文档：${rel}` }

              const raw = fs2.readFileSync(file, 'utf8')
              // ⚠️ .js 档是 `const doc = {…}` 形式 ⇒ 剥出字符串内容（照 `工具\_vassal.js` 的 readDoc）
              const text = file.endsWith('.js')
                ? [...raw.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
                    .map((m) => m[1] ?? m[2]).filter((x) => x && !/^(const|module\.exports|\{|\})/.test(x)).join('\n')
                : raw
              return toLosslessJson({
                ok: true, mode: 'prompt', file,
                prompt: K.extractPrompt({ docId: rel.replace(/\.js$/, ''), docTitle: p2.basename(file, '.js'), text }),
                chars: text.length,
                next: '按上面的提示词产出 JSON，然后调本工具 mode="verify" 把 JSON 交回来。',
              })
            }

            if (args?.mode === 'verify') {
              let parsed
              try { parsed = JSON.parse(String(args.json || '')) } catch (e) {
                return { ok: false, error: 'JSON 解析失败：' + e.message }
              }
              // ⚠️ 核对需要原文 ⇒ 由 json 里可选带 source 文本；没有就只做结构性校验
              const src = String(args.source || '')
              const v = K.verifyExtraction(parsed, src)
              const cands = src ? K.toCandidates(v, { source: args.doc || '' }) : []
              let stored = 0
              if (cands.length) {
                const Lr = await import('./learning.js')
                const units = cands.map((c) => Lr.createUnit(null, {
                  doubt: { text: `抽取自：${c.source}`, pos: 0 },
                  conclusion: { text: JSON.stringify(c.payload), pos: 0 },
                  class: '知识',
                }, { origin: 'extract', evidence: c.evidence ? String(c.evidence).slice(0, 400) : null }))
                stored = Lr.appendPending(units)
              }
              return toLosslessJson({ ok: true, mode: 'verify', stats: v.stats, stored, report: K.renderExtraction(v) })
            }

            return { ok: false, error: `未知 mode：${args?.mode}（应为 prompt 或 verify）` }
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) }
          }
        },
      })
    )
  } catch (e) {
    console.warn('[alert-inject] knowledge_extract 注册失败：', e instanceof Error ? e.message : String(e))
  }

  // 前置指令：静态文本（落在缓存前缀里）。只在配置允许的工作区注入。
  try {
    ctx.systemPrompt.variable('dsh_alert_rule', (context) => {
      try {
        const cwd = context?.agent?.session?.header?.cwd
        // ★ 2026-10-15：顺手把会话 cwd 记下来，供 alert_check 的 execute 使用
        //    （那个 execute 拿不到 context，只能靠这里喂 —— 见 `_sessionCwd` 的注释）。
        //    ⚠️ 必须在 `matchesWorkspace` 之前记：否则"配了 workspaces 但本次不在其中"时
        //       `_sessionCwd` 会一直是 null，工具又退化到 `process.cwd()`（**正是要修的那个 bug**）。
        if (cwd) _sessionCwd = cwd
        if (!cwd || !matchesWorkspace(cwd)) return ''
        return (
          // ★★ 2026-10-17：【自查规矩】已从这里**移走**，成为独立的 `user:alert-mandatory` section。
          //
          //   为什么移走（这是一个**实测出来的失效**，不是措辞优化）：
          //     扫了本机 69 场会话、3722 次工具调用，`alert_check` 只被调用过 **6 次（0.161%）**，
          //     而且**只有 1 场用过**。其中「世界模拟2」那场：工具在 tools 数组第 1 位、
          //     系统提示白纸黑字要求调用、11 个 step 里工具调用 14 次 —— `alert_check` **0 次**。
          //   ⇒ 结论：命令和【记录教训】混在同一个 section 里，强度被冲淡了。
          //     拆出来单独一段、独立名字、更靠前的 order，让它在提示里**显眼**。
          //
          // ⚠️ 用词纪律（已踩三次）：本段避开「不要」「不用」——它们是判据「落档纪律」的信号词。
          '【记录教训】每轮结束前，**先判断这一轮有没有值得复用的教训**，再决定记不记：\n' +
          '- **有** → 按这五段写。⚠️ **先写现象，再写原因**（顺序别倒过来 —— 倒着写会先编一个原因，再回头凑现象）：\n' +
          '    · **症状**：能核对的具体现象（哪一句、哪一步；**别写感想**）\n' +
          '    · **根因**：为什么会这样。⚠️ **先自由写，套预设分类会削掉真实分布**\n' +
          '    · **正确做法**：下次该怎么做\n' +
          '    · **判据**：一句话 —— **怎么判断这次做到了**（要能核对）\n' +
          '    · **配套**：与哪条旧教训是一对（没有就写「无」）\n' +
          '  另标两样：**谁错了**（`ai` 我做错／`user` 使用者说错／`judge` 判据误报／`none`）、**什么时候不适用**（少了它就会过度泛化）。\n' +
          '- **没有** → 明确说一句「**本轮没有需要复用的教训**」。⚠️ 凑格式编出来的会被视为无效。\n' +
          '判断标准只有一条：**这件事以后还会不会遇到**？只会遇到一次的（某个编号、某个路径），不是教训。'
        )
      } catch { return '' }
    })
    ctx.systemPrompt.section({
      name: 'user:alert-lessons',
      order: 45,                     // persona(0) 之后、工具说明(100+) 之前；排在强制命令之后
      text: '{{dsh_alert_rule}}',
    })

    /**
     * ★★ 强制自查指令 —— **独立的前置注入**（2026-10-17 加）
     *
     * 为什么要有单独的 section，而不是并在上面那段里：
     *   实测 69 场会话 / 3722 次工具调用，`alert_check` 只被调用 **6 次（0.161%）**，
     *   且只有 1 场用过。最典型的反例是「世界模拟2」：工具在 tools 第 1 位、
     *   系统提示明确要求、14 次工具调用 —— `alert_check` **0 次**。
     *   ⇒ 混在长段落里的"规矩"顶不住具体任务。**单独一段、独立变量、更靠前的 order**，
     *     让它在 prompt 里成为一条独立的、必须处理的话。
     *
     * ⚠️ 为什么还敢写"实测 0.16%"这种数字进去：
     *   模型不会因为这行字而多花钱（它只是文本），而**具体数字比形容词更能表达严重性**。
     *   但这也意味着：**这个数字过时了就该改**，别让它变成一句不成立的修辞。
     *
     * ⚠️ 用词纪律：本段避开「不要」「不用」（判据「落档纪律」的信号词，已踩三次）。
     */
    ctx.systemPrompt.variable('dsh_alert_mandatory', (context) => {
      try {
        const cwd = context?.agent?.session?.header?.cwd
        if (cwd) _sessionCwd = cwd          // 双保险：两个 variable 都喂 cwd
        if (!cwd || !matchesWorkspace(cwd)) return ''
        return (
          '【硬性要求 · 不可跳过】**在给出正式回答之前，必须先调用 `alert_check` 工具**，拿到它的返回值，再开始写回答。\n' +
          '- 这不是建议，也不是可选步骤。**没有调用就开始回答，等于这个功能完全不存在。**\n' +
          '  这不是修辞：实测 69 场会话 / 3722 次工具调用里，它只被调用过 **6 次（0.16%）**，只有 1 场用过。\n' +
          '- 不管问题看起来多简单、多确定、多像"这次显然不需要查"，都先调。返回"无异常"只花几百毫秒。\n' +
          '- 调用之后：返回"无异常" ⇒ 直接按原计划回答，这次自查不必在回复里提及；\n' +
          '  返回有问题的项 ⇒ 对就改、错就忽略，不必中止回答，也不必逐条转述。'
        )
      } catch { return '' }
    })
    ctx.systemPrompt.section({
      name: 'user:alert-mandatory',
      order: 30,                     // 紧跟 persona，排在所有具体规则之前
      text: '{{dsh_alert_mandatory}}',
    })
  } catch (e) {
    console.warn('[alert-inject] 前置指令注册失败：', e instanceof Error ? e.message : String(e))
  }

  // ══════════════════════════════════════════════════════════════════════
  // 浏览器半侧的只读接口（2026-10-16 加）
  //
  // ⚠️ 为什么加：`AGENTS.md` 的第一条要求是「**使用者不从代码验证，只从行为验证**」，
  //    而此前"确认它在不在跑"的唯一办法是**跑命令行** ——
  //    作者原话「我本身就是黑箱编程，我不知道什么原理或是功能」⇒ 命令行等于把确认权交回给代码。
  //    ⇒ 设置页里给一张卡，一进去就看见三件事：**它在不在跑 / 哪些没测 / 有几件待你处置**。
  //
  // ⚠️ 数据源**只有一个**：直接调 `health.js` 的 `runHealth()` ——
  //    不在 web 层再写一套判定（两套判定必然漂移，那就成了新的"输出与真相不符"）。
  //    ⇒ 界面上的数字与 `node tools/health.mjs` **逐字同源**。
  //
  // ⚠️ 本接口**只读**：不做首次引导、不采样本、不建索引。
  //    （`runHealth` 内部只 `bootstrapState()` 读标记，不写任何东西。）
  //
  // ⚠️ 无 webServer 的组装（headless）**自动跳过**，不让插件加载失败。
  // ══════════════════════════════════════════════════════════════════════
  try {
    let registered = false
    let disposeRoute = null
    let disposeRouteContexts = null
    let tries = 0
    const tryRegister = () => {
      if (registered) return
      // ⚠️ loader 并发挂载：apply 执行时 webServer 可能**还没激活** ⇒ 要重试（照 dsh-openviking 的成熟做法）
      const webServer = ctx.get('webServer')
      if (!webServer) {
        if (++tries > 40) {
          // ★ 不静默放弃：这属于"配了但不生效"那一类，必须留痕（硬规则 2：降级要留痕）。
          //   排查入口：浏览器直接打开 /api/alert-inject/status —— 404 就说明这条没注册上。
          console.warn('[alert-inject] ⚠️ 状态接口未注册：等了约 20 秒仍拿不到 webServer。' +
            '表现是「设置 → 插件 → 警觉注入」里读不到状态（界面会显示"读不到状态"）。' +
            '排查：浏览器打开 /api/alert-inject/status，若 404 即本条。')
          return
        }
        setTimeout(tryRegister, 500)
        return
      }
      registered = true

      // ⚠️⚠️ 路由 handler 的签名是 **(req, res) => void**（`dsh-host-webserver` 的 `WebRoute.handler`），
      //    **必须自己写响应**（`res.writeHead` + `res.end`）。
      //    我第一版写成 `return {...}` —— 那不会报错，只会**让请求一直挂到超时**，
      //    界面表现为"读不到状态"，而日志里一句抱怨都没有（同 §239 那一族）。
      //    规范照抄本机已验证的 `dsh-openviking/lib/config-http.js:131`。
      const sendJson = (res, status, payload) => {
        try {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(payload))
        } catch { try { res.destroy() } catch { /* 忽略 */ } }
      }
      const readBody = async (req, limit = 1 << 20) => {
        let s = ''
        for await (const chunk of req) {
          s += chunk
          if (s.length > limit) return { tooLarge: true }
        }
        return { text: s }
      }

      disposeRoute = webServer.register({
        kind: 'exact',
        path: '/api/alert-inject/status',
        handler: async (req, res) => {
          // ⚠️ 不 catch 之后返回成功值（硬规则 2）：出错就**明说错了**，界面才能显示红字
          try {
            if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(); return }
            const { runHealth } = await import('./health.js')
            const t0 = Date.now()
            const r = await runHealth({ projectRoot: resolveCwdForTool() })
            sendJson(res, 200, {
              ok: true,
              tookMs: Date.now() - t0,           // ★ 把自查耗时也报出来（§241 那个反馈环的可见化）
              at: r.at,
              projectRoot: r.root,
              verdict: r.verdict,
              checks: r.checks.map((c) => ({ name: c.name, status: c.status, detail: c.detail, how: c.how })),
              todo: r.todo,
              samples: r.samples || null,
            })
          } catch (e) {
            console.warn('[alert-inject] 状态接口失败：', e instanceof Error ? e.message : String(e))
            sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      })
      console.log('[alert-inject] 状态接口已注册：GET /api/alert-inject/status')

      // ══════════════════════════════════════════════════════════════
      // 语境区（2026-10-16 加）—— 作者要求：
      //   「建立一个分区，确定它查哪个会话」／「要有一个『在那个语境搜索』的选项，
      //     并要求选出这个语境区最新的是哪个，**在选好之前不启动**」
      //
      // ⚠️ 这是**两条**接口：GET 只读（界面加载用）、POST 写（保存勾选）。
      //    写的那条有硬约束：**落点没选好 ⇒ 开关不许打开** —— 校验在 `contexts.js` 里，
      //    不放在这里（同一个不变量只允许有一个实现）。
      // ══════════════════════════════════════════════════════════════
      disposeRouteContexts = webServer.register({
        kind: 'exact',
        path: '/api/alert-inject/contexts',
        handler: async (req, res) => {
          try {
            const M = await import('./contexts.js')
            const url = new URL(req.url || '/', 'http://localhost')
            // ⚠️ 当前会话 id：界面没带就**自己推**（`latestSessionFile`）。
            //    为什么要有这个兜底：实测第一次接上时 `currentSessionId` 是 `null`
            //    ⇒ 界面上"（现在就这场）"那个标记**永远不出现**，
            //    而使用者会以为"它没认出我正在聊的这一场"（实测踩到）。
            let currentId = url.searchParams.get('current') || null
            if (!currentId) {
              try {
                const cwd = resolveCwdForTool()
                const sf = cwd ? latestSessionFile(cwd) : null
                if (sf) currentId = sf.split(/[\\/]/).slice(-2)[0]
              } catch { /* 推不出来就留 null —— 界面会自己降级 */ }
            }

            // ── GET：读状态（只读，不改任何东西）──
            if ((req.method || 'GET').toUpperCase() === 'GET') {
              const st = await M.contextState(currentId)
              sendJson(res, 200, {
                ok: true,
                enabled: st.enabled,
                anchor: st.anchor,
                // ⚠️ 落点的**人类可读名字**（例 `阅读 HANDOVER.md 理解项目`）——
                //    界面上绝不要显示裸 id：使用者认不出那是哪场对话（2026-10-16 实测）。
                anchorName: st.anchorName || null,
                ready: st.ready,
                selected: st.selected,
                missing: st.missing,
                currentSessionId: st.currentSessionId,
                why: st.why,
                file: st.file,
                configExists: st.configExists,
                // ⚠️ 只发界面要用的字段：132 场 × 全字段会让响应没必要地大
                sessions: st.sessions.map((s) => ({
                  id: s.id, cwd: s.cwd,
                  // ⚠️ `workspace` = DSH 自己记的工作区名（`dswork`），不是路径（`D:\dswork`）。
                  //    界面必须按它分组，才与使用者侧边栏里看到的一致（2026-10-16 补）。
                  workspace: s.workspace || '',
                  title: s.title || '',
                  mb: s.mb, updatedAt: s.updatedAt,
                  hasIndex: s.hasIndex, indexEntries: s.indexEntries, indexBuiltAt: s.indexBuiltAt,
                })),
              })
              return
            }

            // ── POST：保存勾选 / 开关 / 落点 ──
            if ((req.method || '').toUpperCase() === 'POST') {
              const b = await readBody(req)
              if (b.tooLarge) { sendJson(res, 413, { ok: false, error: '请求体过大' }); return }
              let patch = {}
              try { patch = b.text ? JSON.parse(b.text) : {} } catch (e) {
                sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${e?.message || e}` })
                return
              }
              const r = M.writeContexts(patch)
              if (!r.ok) { sendJson(res, 400, { ok: false, error: r.why }); return }
              const st = await M.contextState(currentId)
              sendJson(res, 200, {
                ok: true, saved: true, enabled: st.enabled, anchor: st.anchor,
                ready: st.ready, why: st.why, selected: st.selected,
              })
              return
            }

            sendJson(res, 405, { ok: false, error: `不支持的方法：${req.method}` })
          } catch (e) {
            console.warn('[alert-inject] 语境区接口失败：', e instanceof Error ? e.message : String(e))
            sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      })
      console.log('[alert-inject] 语境区接口已注册：GET/POST /api/alert-inject/contexts')
    }
    tryRegister()
    if (typeof ctx.effect === 'function') ctx.effect(() => () => {
      // ⚠️ 两条路由都要注销 —— 漏一条就是内存里挂着一个**没人认领的 handler**
      try { disposeRoute?.() } catch { /* 忽略 */ }
      try { disposeRouteContexts?.() } catch { /* 忽略 */ }
    })
  } catch (e) {
    console.warn('[alert-inject] 状态接口注册失败：', e instanceof Error ? e.message : String(e))
  }
}

// 便于自测（不影响 cordis 加载）
export { alertText, loadJudges, latestSessionFile, recentActivity, createAlertMessage, peek, renderPointer }
