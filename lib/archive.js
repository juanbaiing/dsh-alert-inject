/**
 * archive.js — 「**档案检索**」：把项目**之外**的文档（教训库、笔记、设定档…）接进提醒
 *
 * ══ 为什么要有它（2026-10-16 · 一次真实的失败）═════════════════════════
 *   作者问「**有没有人做过这个**」。`alert_check` 报了：
 *       🤔 【知晓感】没找到相近记录
 *   而**答案确实存在** —— 就在 `dsh-lessons/10-external-ai-projects.md`（`§199` 起）
 *   里，十天前调研过，记录了更直接的同类项目。
 *
 *   ⇒ 根因：**提醒系统的检索只覆盖「会话痕迹」，而档案（教训库）根本不在它的检索范围内。**
 *   ⇒ 这正是硬规则 1 说的：**「没找到」与「我没在找」是两回事** ——
 *     当时报的是"没找到"，实际是**没在找**。
 *
 * ══ ⚠️ 设计上的三条硬约束（全部来自已付过的代价）══════════════════════
 *   ① **独立成一路，绝不混进会话检索**。
 *      作者反复强调「**分语境是我一直强调的**」——档案是**另一个语境**。
 *      把它与会话痕迹混在一起排序，等于用"语境 A 的相似度"去解释"语境 B 的问题"。
 *      ⇒ 本模块有**自己的**索引、自己的缓存、自己的输出段，条目一律标 `file:line`。
 *
 *   ② **未配置就明说「没在找」，绝不静默返回空**（硬规则 1）。
 *      `dir` 空 ⇒ 返回 `{state:'unconfigured'}`，渲染出「**没有配置档案目录 ⇒ 这一路没在找**」。
 *      这三态（`ok` / `unconfigured` / `unreadable`）是本项目 §248 那套修法的沿用。
 *
 *   ③ **输出的每一句都能被核对**（硬规则 5）⇒ 每条命中都带**文件路径 + 行号 + 小节标题**。
 *
 * ══ 与 `librarian.js` 的关系（**复用，不重造**）════════════════════════
 *   向量与余弦**完全复用** `librarian` 的 `embed()` / `cosine()`（进而走 `provider.js`）。
 *   本模块只做 librarian 不做的那件事：**读文件、按小节切块、用文件坐标代替痕迹坐标**。
 *   ⚠️ 为什么不直接用 `buildIndex`：它的 `globalPos` 是**痕迹序号**、
 *      `query` 的 `anchor`/`minDist` 是"**当前写作位置**"的概念 —— 对档案都无意义。
 *      照搬会把一套坐标套到另一套对象上（同 §128"跨单位比较"那一类错误）。
 *
 * ══ ⚠️ 措辞纪律（§199 的代价）════════════════════════════════════════
 *   本项目历史上**因为转述同类项目的宣传修辞，整个窗口被安全分类器拦过**
 *   （`Content Exists Risk`）。⇒ 本模块输出的文本**一律用中性技术语言**：
 *   说「检索到」「参考资料」，不说任何"后台往上下文里塞东西"式的修辞。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { embed, cosine } from './librarian.js'

/**
 * 用来 `require` **设定档 .js**（见 `settingDocText`）。
 * ⚠️ 本文件是 ESM，`require` 不存在 ⇒ 用 `createRequire` 借一个。
 */
const require_ = createRequire(import.meta.url)
// ⚠️ 静态导入：`archiveDir()` 要读配置文件（`~/.dsh/alert-inject.json` 的 `archiveDir`）。
//    实测过：`config.js` 只 import node 内置 ⇒ 与 archive 之间没有循环依赖，静态导入是安全的。
import { config } from './config.js'

export const ARCHIVE_OPTS = {
  /**
   * ⚠️⚠️ **切块规则版本**（2026-10-17 加）。
   *
   *   **为什么必须有它**（实测抓到的真 bug）：
   *     我把 `.js` 设定档的每块正文改成"冠上档名"之后再跑，结果输出
   *     `reused: true`、耗时 **0 秒** —— **改动一行都没生效**，
   *     而报告照样说「索引覆盖 100%」。
   *   根因：缓存有效性只比 **源目录的文件数 + 最新 mtime**（见 `dirStamp`），
   *     **完全不看这份索引是哪种切块规则建出来的**。
   *     而我只改代码不碰档案 ⇒ 指纹不变 ⇒ 旧索引被判为最新。
   *
   *   ⇒ 这正是本项目 §六 那句话的又一个实例：
   *     **「凡是用来做判断、过滤、检测的东西，它自己也要被检查。」**
   *     索引"是否最新"的判据漏掉了一个维度（规则版本），于是一次真实修复被静默吞掉。
   *
   * ⚠️ **凡是改了 `settingDocText` / `chunkMarkdown` / 读文件的后缀与清洗规则，
   *     必须把这个数字 +1**，否则旧索引会继续冒充最新。
   */
  indexRev: 2,
  /**
   * 档案目录 —— ⚠️ **不要在这里读 `process.env`**（2026-10-16 改）。
   *
   * 原实现是 `dir: process.env.DSH_ALERT_ARCHIVE_DIR || ''`，在**模块加载时**取一次。
   * 实测后果（本机，作者本人）：
   *   用 `setx` 设了环境变量、重启了 DSH，**档案检索仍然是"没测"** ——
   *   因为**用户级环境变量的更新只对"从新生 explorer 起的进程"生效**：
   *   桌面快捷方式启动的 DSH 继承的是**旧环境**，`setx` 写了注册表也没用。
   *   ⇒ 而本项目的使用者是**不碰命令行的人**：要他们 `setx` + 重启资源管理器 = **这功能等于不可用**。
   * ⇒ 故改为**每次现读**，且支持**配置文件**（`~/.dsh/alert-inject.json` 的 `archiveDir`），
   *   环境变量保留为**最高优先级**（向后兼容，脚本/CI 仍可用）。
   * ⇒ 用 `archiveDir()` 取；**不要**再读这个字段（留着只为兼容旧引用）。
   */
  dir: undefined,
  /** 索引缓存目录 */
  cacheDir: process.env.DSH_ALERT_ARCHIVE_CACHE
    || path.join(os.homedir(), '.dsh', 'archive-cache'),
  /** 最多读多少个文件（防止误指到一个巨型目录） */
  maxFiles: 300,
  /**
   * 最多保留多少个块。
   *
   * ⚠️⚠️ 【2026-10-17 从 400 提到 2000】**实测该库规模 1634~1709 块** ——
   *   原值 400 ⇒ **只索引 24.5%**（跳掉 1234 块），而这个数字会在自查里如实报出来
   *   （「索引覆盖 24%：400/1634 块」）。作者就是看到那句提示才发现的。
   *
   * ⚠️ **实测成本（2026-10-17，本机 CPU + Ollama bge-m3）**：
   *     档案块 **1.35 秒/块**（276 秒嵌 204 块）—— 比"450ms/块"的旧估计**慢 3 倍**。
   *     原因：`snip = 400` 字（会话痕迹是 50 字，长 8 倍 ⇒ 慢得多）。
   *     ⇒ 1709 块全量重建 **约 38 分钟**。
   *   ⚠️ 这是**一次性**成本：档案目录是**静态**的（教训库偶尔加一篇），
   *     重建后每轮增量只涉及新增块 ⇒ 秒级。
   *   ⚠️ 但 38 分钟**必须让使用者看得见**（`onLog` 会报进度）—— 不能静默跑。
   *
   * ⚠️ 设成 2000 而不是"不限"：`maxFiles`/`maxChunks` 的**本来目的**是
   *   "防止误指到一个巨型目录"（见上面 maxFiles 的注释）—— 那个保护要留着，
   *   只是 400 对**本库自己的规模**都太小了。
   * ⚠️ 覆盖度**永远要如实报**（见下面 buildArchiveIndex 里的 onLog）——
   *   截断本身不是罪，"截断了却不说"才是。
   */
  maxChunks: +(process.env.DSH_ALERT_ARCHIVE_MAX_CHUNKS || 2000),
  /** 每块截断长度（复用 librarian 的思路：越长越慢） */
  snip: 400,
  /** 判为"相关"的最低余弦。
   *  ⚠️ 2026-10-16 实测从 0.45 提到 **0.5**：
   *    0.45 太松 —— 「今天午饭吃什么」这种完全无关的查询**命中了**
   *    `minecraft/f-ops-cheatsheet.md:9`（恰好 45%）。
   *    而真命中的那几条（`10-external-ai-projects.md` 的 55%/54%/53%）在 0.5 之下**仍然保留**。
   *
   *  ⚠️⚠️ 2026-10-26 **从 0.5 提到 0.65**（作者原话：「现在还是在返回不相干的」）：
   *    本机实测：档案是**创作设定**，而日常对话是**插件开发** —— 两边共用「意识/记忆/计算」这类词，
   *    于是 `计划·协议/重置.js` 在**每次自查**里都以 **59%~64%** 命中，而它跟当前话题毫无关系。
   *    ⇒ 0.5 对「另一个语境」太松：**词汇拓扑邻近 ≠ 领域相关**。
   *    ⇒ 0.65 是保守值：真正讨论设定时（同一语境）命中会明显更高；不到 0.65 的一律**不展开**。
   *    ⚠️ 可用 `DSH_ALERT_ARCHIVE_MIN_SCORE` 覆盖 —— 觉得误杀就调低，不要再改死值。
   */
  minScore: +(process.env.DSH_ALERT_ARCHIVE_MIN_SCORE || 0.65),
  /**
   * 只读这些后缀。
   *
   * ⚠️【2026-10-17 加 `.js`】**世界设定档**就是用 JS 模块存的，形如：
   *     `const doc = { title, intro:[…], sections:[{ h1, blocks:[{ h2 } | { lines:[…] }] }] }`
   *   ⇒ 若把 `.js` 当普通文本读，`const doc = {`、`'`、`{ h1:` 这些**语法噪音**全会进索引，
   *     而 markdown 切块会切在**语法结构**上而不是**设定边界**上。
   *   ⇒ 故 `.js` 先解析出 `doc` 对象、**还原成 markdown 文本**再切块（见 `settingDocText`）。
   */
  exts: ['.md', '.txt', '.js'],
}

/**
 * **现读**档案目录（不缓存 —— 配置改了下一轮就该生效）。
 *
 * 优先级（高 → 低）：
 *   ① `DSH_ALERT_ARCHIVE_DIR` 环境变量（向后兼容；脚本/CI 用）
 *   ② `DSH_ALERT_PROJECT` 下 `alert-inject.json` 的 `archiveDir`
 *   ③ `~/.dsh/alert-inject.json` 的 `archiveDir`      ← **给不看命令行的人用**
 *   ④ 空 ⇒ `unconfigured`（**明说"没在找"**，不是静默当成"没有档案"）
 *
 * ⚠️ 为什么②③要分开试：`config()` 的 `projectRoot` 常常是 null
 *    （由会话 cwd 推断），那时它只会读③。把它写成"先看项目配置、再看全局"，
 *    是为了让**同一个档案目录**既能按项目配、也能全局配。
 * @returns {{dir:string, why:string}} `why` 说明这个值是谁给的（**可核对**）
 */
export function archiveDir() {
  const env = String(process.env.DSH_ALERT_ARCHIVE_DIR || '').trim()
  if (env) return { dir: env, why: '来自环境变量 DSH_ALERT_ARCHIVE_DIR' }
  try {
    // ⚠️ 用**静态** import 进来的 `config()`（顶部已导入）——
    //    我第一版在这里写 `await import(...)`，而这个函数是**同步**的 ⇒ 语法直接不通过。
    const c = config() || {}
    const fromFile = String(c.archiveDir || '').trim()
    if (fromFile) return { dir: fromFile, why: `来自配置文件 ${c._source || 'alert-inject.json'} 的 archiveDir` }
  } catch { /* 配置读不动 ⇒ 当成没配（下面明说） */ }
  return { dir: '', why: '既没有环境变量，配置文件里也没有 archiveDir' }
}

/** 缓存文件路径（按目录取稳定 key，避免路径里的分隔符进文件名） */
export function cachePathFor(dir) {
  let h = 0
  const s = String(dir || '')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return path.join(ARCHIVE_OPTS.cacheDir, `archive-${(h >>> 0).toString(16)}.json`)
}

/**
 * **三态**：`ok` / `unconfigured`（没配 ⇒ 有意静默）/ `unreadable`（坏了 ⇒ 必须出声）。
 * ⚠️ 这与 `librarian.cacheState` 同一套语义（§248 的修法）。
 */
export function archiveStatus(dir = archiveDir().dir) {
  const d = String(dir || '').trim()
  if (!d) {
    // ⚠️ 把"为什么没配"也说清楚（**环境变量和配置文件都试过了**）——
    //    否则使用者设了环境变量却没生效时，只会看到"没有配置档案目录"，无从下手。
    const a = archiveDir()
    return { state: 'unconfigured', dir: '', why: `没有配置档案目录（${a.why}）` }
  }
  try {
    const st = fs.statSync(d)
    if (!st.isDirectory()) return { state: 'unreadable', dir: d, why: '配置的档案路径不是一个目录' }
    return { state: 'ok', dir: d }
  } catch (e) {
    return { state: 'unreadable', dir: d, why: `读不到这个目录：${e?.message || e}` }
  }
}

/**
 * 把一个 markdown 文件切成块。
 * **切块单位 = 小节（`##` 标题）**，因为那是作者写教训时自然的"一个意思"的单位。
 * ⚠️ 太长的小节再按段落切，并**记录行号**（可核对）。
 */
export function chunkMarkdown(text, file, { snip = ARCHIVE_OPTS.snip } = {}) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  let cur = { title: '(开头)', startLine: 1, buf: [] }

  const flush = () => {
    const body = cur.buf.join('\n').trim()
    if (!body) return
    // 太长 ⇒ 按空行再切
    const paras = body.split(/\n\s*\n/)
    let acc = ''
    let accStart = cur.startLine
    for (const p of paras) {
      if (acc && (acc + '\n\n' + p).length > snip * 2) {
        out.push({ file, line: accStart, title: cur.title, text: acc.slice(0, snip) })
        acc = p
        accStart = cur.startLine
      } else {
        acc = acc ? acc + '\n\n' + p : p
      }
    }
    if (acc.trim()) out.push({ file, line: accStart, title: cur.title, text: acc.slice(0, snip) })
  }

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]
    if (/^#{1,3}\s+/.test(L)) {
      flush()
      cur = { title: L.replace(/^#+\s*/, '').trim().slice(0, 60), startLine: i + 1, buf: [] }
      continue
    }
    cur.buf.push(L)
  }
  flush()
  return out.filter((c) => c.text.replace(/\s+/g, '').length >= 20)   // 太短的块没语义价值
}

/** 递归收集档案文件（跳过大目录与隐藏目录） */
export function walkDocs(dir, out = [], depth = 0) {
  if (depth > 6 || out.length >= ARCHIVE_OPTS.maxFiles) return out
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (out.length >= ARCHIVE_OPTS.maxFiles) break
    if (e.name.startsWith('.')) continue
    if (e.name === 'node_modules') continue
    /**
     * ⚠️ **排除备份/历史目录**（2026-10-16 实测抓到）。
     *   目录里有一个 `_backup_拆分前_20261002-203026/`，里面的文件与正式文件**同名同内容**，
     *   于是同一个文件在索引里出现**两份** ⇒ 检索结果里两条几乎一样的命中互相挤占名额（假阳性／挤掉真命中）。
     *   ⇒ 它不改变文件总数（`files:29` 里就含它），但会让"命中列表"看起来重复且可信度下降。
     */
    if (/backup/i.test(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkDocs(p, out, depth + 1)
    else if (ARCHIVE_OPTS.exts.some((x) => e.name.toLowerCase().endsWith(x))) out.push(p)
  }
  return out
}

/**
 * 把一份**设定档 `.js`** 解析成 markdown 风格的纯文本（供 `chunkMarkdown` 切块）。
 *
 * 为什么值得这么绕：
 *   · 设定档的字段是固定的 `{title, intro[], sections[{h1, blocks[{h2} | {lines[]}]}]}`
 *     ⇒ 用它自己的结构还原成 `#` / `##` / `###`，切块就正好落在**设定边界**上；
 *   · 走 `require` 拿真实对象，比正则抠字符串可靠（不会漏掉转义与拼接）。
 *
 * ⚠️ **必须清 require 缓存** —— 设定档是活的，作者改完要能立刻读到新内容；
 *    不清缓存就会一直读到第一次加载的旧版。
 * ⚠️ 解析失败返回 `null` ⇒ 调用方退回"按原文读"。
 *    **降级但要留痕**：`readChunks` 会把这种情况计数（不静默）。
 *
 * @returns {{title:string, text:string}|null}
 */
function settingDocText(absPath) {
  try {
    const resolved = require_.resolve(absPath)
    delete require_.cache[resolved]
    const m = require_(absPath)
    const doc = m?.doc || m?.default?.doc
    if (!doc || typeof doc !== 'object') return null
    const out = []
    const title = doc.title ? String(doc.title).trim() : ''
    const push = (s) => { if (typeof s === 'string' && s.trim()) out.push(s.trim()) }
    if (title) out.push(`# ${title}`)
    for (const x of (doc.intro || [])) push(x)
    for (const s of (doc.sections || [])) {
      if (s?.h1) out.push(`## ${String(s.h1)}`)
      for (const b of (s?.blocks || [])) {
        if (b?.h2) out.push(`### ${String(b.h2)}`)
        for (const l of (b?.lines || [])) push(l)
      }
    }
    return out.length ? { title, text: out.join('\n') } : null
  } catch { return null }
}

/** 读目录 → 块数组（**不写盘**，纯函数式） */
export function readChunks(dir, { onLog } = {}) {
  const files = walkDocs(dir)
  const chunks = []
  let failed = 0
  let jsParsed = 0          // 设定档解析成功数
  const jsFallback = []     // ⚠️ 解析失败、退化成"按原文读"的文件（要报出来）
  for (const f of files) {
    try {
      let txt = fs.readFileSync(f, 'utf8')
      /** 设定档的**档名** —— 要拼进每块正文（原因见下面 `settingNamePrefix` 的注释） */
      let docTitle = ''
      if (f.toLowerCase().endsWith('.js')) {
        const parsed = settingDocText(f)
        if (parsed === null) jsFallback.push(path.relative(dir, f).replace(/\\/g, '/'))
        else { txt = parsed.text; docTitle = parsed.title; jsParsed++ }
      }
      const rel = path.relative(dir, f).replace(/\\/g, '/')
      for (const c of chunkMarkdown(txt, rel)) {
        /**
         * ⚠️⚠️ **每块正文都冠上档名**（2026-10-17 实测抓到的真缺陷）。
         *
         *   症状：查「依诗是谁」**命不中 `人物/依诗.js`** —— 而那个档明明存在。
         *   根因：设定档（尤其人物档）的正文里**通篇用「她」指称本体**，
         *        `依诗` 三个字只出现在标题行；而 `chunkMarkdown` 把标题行当分隔符**丢掉**，
         *        只用它当 `title` 字段 ⇒ **这个档的每一块正文都不含「依诗」**。
         *        「标题» 不在检索文本里，于是"用名字查名字"查不到自己。
         *   ⇒ 这与 §128 那类错误同族：**索引键里的信息没进检索文本**。
         *   ⇒ 修法：`.js` 设定档的每块正文前冠 `档名｜`。
         *      这不只是补漏 —— 设定档的每一块本来就**都是关于这个档的**，
         *      档名进向量是**正确语义**，不是权宜。
         * ⚠️ 只对 `.js` 设定档做：`.md` 教训库的标题不是实体名，冠上去反而制造噪音。
         */
        if (docTitle) c.text = `${docTitle}｜${c.text}`
        chunks.push(c)
      }
    } catch { failed++ }        // ⚠️ 读不动的文件**要计数**，不能当它不存在
  }

  /**
   * ⚠️⚠️ 选块必须**跨文件轮转**，不能 `slice(0, N)`（2026-10-16 实测抓到的 bug）。
   *
   *   第一版写的是 `chunks.slice(0, maxChunks)` —— 而 `chunks` 是**按文件遍历顺序**堆起来的。
   *   实测后果：2230 块里取前 120 块，`00-INDEX.md`（1286 行）**一个文件就吃光了配额**，
   *   于是 `10-external-ai-projects.md` **根本没进索引** ——
   *   而那正是我们要让它能被检索到的那个文件。
   *   ⇒ 更坏的是：检索不到时**只会说"没找到"**，没人看得出是"没进去"。
   *
   *   ⇒ 改成**轮转**：每轮从每个文件各取一块，保证**每个文件都有机会进索引**。
   */
  const byFile = new Map()
  for (const c of chunks) {
    if (!byFile.has(c.file)) byFile.set(c.file, [])
    byFile.get(c.file).push(c)
  }
  const lists = [...byFile.values()]
  const max = ARCHIVE_OPTS.maxChunks
  const picked = []
  for (let round = 0; picked.length < max; round++) {
    let added = 0
    for (const list of lists) {
      if (list[round]) { picked.push(list[round]); added++ }
      if (picked.length >= max) break
    }
    if (!added) break
  }

  // ⚠️ **覆盖率必须算出来并报出去**（不能只算不用 —— 那是第一版的错）
  const coverage = chunks.length ? +(picked.length / chunks.length).toFixed(4) : 1
  if (onLog) {
    onLog(`档案：${files.length} 个文件 / ${chunks.length} 块`
      + `；**索引覆盖 ${(coverage * 100).toFixed(0)}%**（取 ${picked.length} 块，跨文件轮转）`
      + (jsParsed ? `；${jsParsed} 个设定档按结构解析` : '')
      + (jsFallback.length ? `；⚠️ ${jsFallback.length} 个设定档解析失败、按原文读了（${jsFallback.slice(0, 3).join('、')}${jsFallback.length > 3 ? '…' : ''}）` : '')
      + (failed ? `；${failed} 个文件读不动（已计数）` : ''))
  }
  return {
    files: files.length,
    chunks: picked,
    /**
     * ⚠️ 【必须把"全部块"也带出去 —— 2026-10-17 加】
     *   `chunks` 只是**按 maxChunks 截断后**选中的那一批；
     *   而"索引覆盖了多少"和"增量该补哪些"都要看**全部**。
     *   原来只有 `total`（一个数字），信息不够 ⇒ 增量无从下手。
     */
    all: chunks,
    total: chunks.length,
    skipped: chunks.length - picked.length,
    filesCovered: new Set(picked.map((c) => c.file)).size,
    coverage,
    failed,
    jsParsed,
    jsFallback,
  }
}

/** 块的**稳定键**：同一文件同一行 ⇒ 同一块 ⇒ 向量可复用 */
const chunkKey = (c) => c.file + '\u0000' + c.line

/**
 * 建索引（要 embed，慢）—— **不写盘**
 *
 * ★★ 增量（2026-10-17 加）★★ —— 为什么必须有它：
 *   实测档案 **1.35 秒/块**（`snip=400` 字），本库 1709 块 ⇒ **全量一次约 38 分钟**。
 *   而 `dirStamp` 是按**最新 mtime** 算的 ⇒ **只要动过任意一个文件就判 stale**，
 *   于是"加一篇教训"会触发**又一轮 38 分钟**。那不可接受。
 *   ⇒ 复用键用 `(file, line)`：文件没变 ⇒ 那些块的向量**逐条可复用**。
 *     （与会话索引同一套思路，见 `librarian.js` 的 `buildIndexIncremental`。）
 *   ⚠️ 但**不能按 line 复用"内容"**：在文件中间插一行，其后所有行的 `line` 都会平移
 *     ⇒ 用 `(file, line)` 对齐后还要**比 snip**，文本变了就重算（向量是文本的函数）。
 */
export async function buildArchiveIndex(dir, { onProgress, old = null } = {}) {
  /**
   * ⚠️⚠️ 2026-10-26 修复：**这里少解构了 `jsParsed` 与 `jsFallback`**。
   *
   *   症状：`node tools/rebuild-archive.mjs` 跑满 174/174 块（307 秒）后报
   *     `state = unreadable` / `why = 建档失败：jsParsed is not defined`，
   *     而缓存文件**一个字节都没变**（还是旧索引）。
   *
   *   根因：2026-10-17 给 `readChunks` 的返回加了 `jsParsed`／`jsFallback`，
   *     也改了下面 `stats` 里的引用，**唯独漏了这里的解构**。
   *   ⇒ 于是每次重建都抛 ReferenceError ⇒ 索引**永远建不成**；
   *     而 `alert_check` 只读缓存、看到的只是「档案有改动，索引尚未重建」——
   *     读者会以为是"数据旧"，实际是**重建这条路一直是坏的**。
   *   ⇒ 这是本项目最戒备的 `fail-plausible`：提示看起来完全合理。
   *
   *   ⚠️ 判据（防复发）：**凡 `readChunks` 的返回字段被引用，解构里必须出现同名键**。
   *     `tools/check-setting-docs.mjs` 的 20 条断言里应该有一条守这个——
   *     没有的话，加一条：`buildArchiveIndex` 能跑通（不抛）。
   */
  const { files, chunks, all, total, skipped, coverage, filesCovered, failed, jsParsed, jsFallback } = readChunks(dir)
  const texts = chunks.map((c) => c.text.replace(/\s+/g, ' '))

  // 旧向量索引：键 = 文件+行，值 = {snip, vec}
  const oldMap = new Map()
  if (old && Array.isArray(old.entries) && Array.isArray(old.vecs)) {
    old.entries.forEach((e, i) => {
      if (e && old.vecs[i]) oldMap.set(e.file + '\u0000' + e.line, { snip: e.snip, vec: old.vecs[i] })
    })
  }

  const vecs = new Array(texts.length)
  const todo = []
  for (let i = 0; i < texts.length; i++) {
    const hit = oldMap.get(chunkKey(chunks[i]))
    // ⚠️ 必须比文本：同一 (file,line) 的内容可能已经改过（编辑会让其后所有行平移）
    if (hit && hit.snip === texts[i]) vecs[i] = hit.vec
    else todo.push(i)
  }

  const BATCH = 12
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    const part = await embed(batch.map((k) => texts[k]))
    batch.forEach((k, j) => { vecs[k] = part[j] })
    onProgress?.(Math.min(i + BATCH, todo.length), todo.length)
  }

  return {
    version: 1,
    /**
     * ⚠️ 切块规则版本 —— 与 `ARCHIVE_OPTS.indexRev` 比对。
     *   缺这个字段（旧索引）一律当"规则已变"处理，**必须重建**。
     */
    rev: ARCHIVE_OPTS.indexRev,
    kind: 'archive',
    dir,
    entries: chunks.map((c, i) => ({ file: c.file, line: c.line, title: c.title, snip: texts[i] })),
    vecs,
    // ⚠️ 覆盖率连着索引一起存 —— 换了机器/改了目录后仍然能说清"这份索引只覆盖多少"
    // ⚠️ `jsParsed` 也存：渲染层要靠它判断**这个档案是设定档（有权威）还是普通笔记**（见 renderArchive）
    stats: { files, filesCovered, chunks: chunks.length, total, skipped, coverage, failed, jsParsed, jsFallback: jsFallback.length },
    // ⚠️ 增量要留痕：复用多少、新嵌多少（否则"增量生效了吗"只能靠感觉）
    incremental: { reused: texts.length - todo.length, embedded: todo.length },
    builtAt: new Date().toISOString(),
  }
}

/** 目录内容指纹（用文件数和最新 mtime，够用且便宜） */
function dirStamp(dir) {
  const files = walkDocs(dir)
  let newest = 0
  for (const f of files) { try { const m = fs.statSync(f).mtimeMs; if (m > newest) newest = m } catch { /* 跳过 */ } }
  return { n: files.length, m: Math.round(newest) }
}

/**
 * ★ **只读缓存，绝不建索引**。
 *
 * ⚠️ 为什么必须与 `ensureArchiveIndex` 分开（2026-10-16）：
 *   建一次索引实测要 **6 分钟**（400 块 × 约 0.9 秒/块；40 块实测 35 秒）。
 *   而项目里**已有明确结论**（`report.js` 的注释）：
 *     > 「**不能 await 重建：要 35 秒~数分钟，await 会把自查卡死。**」
 *   ⇒ 自查路径上**只允许读缓存**；没缓存就**明说"索引还没就绪"**，
 *     再由调用方在后台 fire-and-forget 去建（与 ⑦b2 整理稿、`bootstrap` 同一套做法）。
 *
 * @returns {{state:'ok'|'building'|'unconfigured'|'unreadable', index:object|null, why?:string, stale?:boolean}}
 *   `state==='ok'` 但 `stale===true` ⇒ 档案有改动，索引还是旧的（**要说出来**，不能装作最新）
 */
export function readCachedIndex(dir) {
  const st = archiveStatus(dir)
  if (st.state !== 'ok') return { state: st.state, why: st.why, index: null }
  /**
   * ⚠️⚠️ 用 **`st.dir`（`archiveStatus` 解析后的值）**，不要用进来的 `dir`（2026-10-16 实测踩到）。
   *
   *   `archiveStatus()` **不传参时自己现读配置**（走 `archiveDir()`，见其注释）；
   *   但 `cachePathFor(dir)` 里若仍用**原始入参**，`dir` 就是 `undefined`
   *   ⇒ `String(undefined || '')` = `''` ⇒ 哈希的是**空串** ⇒ **永远读不到那个缓存文件**。
   *
   *   症状极具欺骗性：**建索引成功、缓存也确实写盘了**，但读回永远说「还没建过索引」
   *   ⇒ 输出永远显示"索引还没就绪"，而每轮自查都重新建一次 ——
   *   **看起来像"慢"，实际是"坏了"。**（硬规则 2 的典型违反面）
   */
  const cacheFile = cachePathFor(st.dir)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  } catch {
    return { state: 'building', why: '还没建过索引（缓存不存在）', index: null }
  }
  if (!Array.isArray(raw?.vecs) || !raw.vecs.length) {
    return { state: 'building', why: '缓存里没有索引内容', index: null }
  }
  /**
   * ⚠️⚠️ **规则版本必须先比**（2026-10-17，见 `indexRev` 的注释）。
   *
   *   只比"源目录有没有改动"是不够的：**改切块规则不碰档案** ⇒ 指纹不变 ⇒
   *   旧索引被判为最新 ⇒ 一次真实修复被静默吞掉（实测踩过，`reused: true`、耗时 0 秒）。
   *   ⇒ 规则版本不一致 ⇒ 判为**需要重建**（不是"还能凑合用"：向量对应的文本已经是旧语义了）。
   */
  if (raw.rev !== ARCHIVE_OPTS.indexRev) {
    return {
      state: 'building',
      why: `索引是按旧切块规则建的（rev ${raw.rev ?? '未标注'} → ${ARCHIVE_OPTS.indexRev}），需要重建`,
      index: null,
      revMismatch: true,
    }
  }
  // 档案是否改过（改了就标 stale —— 但仍可用，只是要说明）
  //
  // ⚠️⚠️ **这里是同一个坑的第三次**（2026-10-16，前两处在 `cacheFile` 与 `ensureArchiveIndex`）：
  //   同一个函数里三处都该用 `st.dir`，我改了两处就以为改完了。
  //   后果：`dirStamp(undefined)` ⇒ `walkDocs` 抛错被 catch 吞 ⇒ 返回 `{n:0,m:0}`
  //   ⇒ **永远判定"档案有改动"** ⇒ 每次自查都说「索引尚未重建」（而它刚建过）。
  //   ⇒ **教训：一个"解析后变量"引入后，要 grep 该函数里所有用到原入参的地方**，改一处不算改。
  try {
    const stamp = dirStamp(st.dir)
    if (raw?.stamp?.n !== stamp.n || raw?.stamp?.m !== stamp.m) {
      return { state: 'ok', index: raw, stale: true, why: '档案有改动，索引尚未重建' }
    }
  } catch { /* stat 失败不影响使用旧索引 */ }
  return { state: 'ok', index: raw }
}

/**
 * 拿索引：缓存有效则复用，否则重建并落盘。
 * ⚠️ **不静默**：任何一步失败都写进返回值的 `why`，由渲染层说出来。
 * ⚠️ **热路径别用这个** —— 它会真的建索引（可能 6 分钟）。自查路径请用 `readCachedIndex`。
 */
export async function ensureArchiveIndex(dir, { onLog } = {}) {
  const st = archiveStatus(dir)
  if (st.state !== 'ok') return { state: st.state, why: st.why, index: null }

  const cacheFile = cachePathFor(st.dir)      // ⚠️ 用解析后的 st.dir（同上，别用原始入参）
  const stamp = dirStamp(st.dir)
  /**
   * ⚠️ 先把**旧缓存读出来留着当 `old`**（2026-10-17 加，配合增量）。
   *   原来是"能复用就 return，不能复用就丢掉" ⇒ 丢掉的那份**明明大部分还有效**
   *   ⇒ 每次档案改动都要重嵌全部 1709 块（实测 38 分钟），而其中绝大多数块根本没变。
   *   ⇒ 现在：过期时把它交给 `buildArchiveIndex` 当复用源。
   */
  let old = null
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    if (raw?.stamp?.n === stamp.n && raw?.stamp?.m === stamp.m
        && raw?.rev === ARCHIVE_OPTS.indexRev
        && Array.isArray(raw.vecs) && raw.vecs.length) {
      return { state: 'ok', index: raw, reused: true }
    }
    // 规则版本不一致 ⇒ 不拿它当复用源（(file,line) 对齐已无意义，块边界都变了）
    if (raw?.rev === ARCHIVE_OPTS.indexRev && Array.isArray(raw?.vecs) && raw.vecs.length) old = raw
  } catch { /* 缓存缺失/损坏 ⇒ 从头建，不算错 */ }

  try {
    const idx = await buildArchiveIndex(st.dir, {
      old,
      onProgress: (i, n) => onLog?.(`档案索引重建 ${i}/${n}`),
    })
    if (old && idx.incremental) {
      onLog?.(`档案索引增量：复用 ${idx.incremental.reused} 块 / 新嵌 ${idx.incremental.embedded} 块`)
    }
    idx.stamp = stamp
    try {
      fs.mkdirSync(ARCHIVE_OPTS.cacheDir, { recursive: true })
      /**
       * ⚠️⚠️ 必须把向量转成**普通数组**再序列化（2026-10-16 实测踩到，是个真 bug）。
       *
       *   `embed()` 返回的是 **`Float32Array`**，而 `JSON.stringify(Float32Array)`
       *   会把它变成 `{"0":0.1,"1":0.2,…}` 这样的**对象**（不是数组）。
       *   ⇒ 读回时 `Array.isArray(raw.vecs)` 为 **false** ⇒ `readCachedIndex` 判为"缓存里没有索引内容"
       *   ⇒ **缓存永远无效** ⇒ 每轮自查都 fire-and-forget 重建一次（6 分钟），**永远建不完**，
       *     而输出只会说「索引还没就绪」—— **看起来像"慢"，实际是"坏了"**。
       *
       *   ⚠️ 这正是本项目最戒备的那类缺陷：**它不报错，它只是永远不生效。**
       */
      const toSave = { ...idx, vecs: idx.vecs.map((v) => Array.from(v)) }
      fs.writeFileSync(cacheFile, JSON.stringify(toSave), 'utf8')
    } catch (e) {
      /**
       * ⚠️ **原来这里是个裸 `catch {}`（静默吞错）—— 2026-10-16 修**。
       *
       *   后果很隐蔽：写缓存失败（权限/路径/序列化）时**什么都不说**，
       *   于是 `readCachedIndex` 永远返回 `building`，输出永远说「索引还没就绪」，
       *   而**每一轮自查都重新 fire-and-forget 建一次索引**（6 分钟）——
       *   **看起来像"慢"，实际是"坏了"，而且永远修不好**。
       *   ⇒ 正是硬规则 2 说的：「**降级可以，降级必须留痕**」。
       */
      console.warn('[alert-inject/archive] ⚠️ 索引缓存写不进去（每轮都会重建，直到修好）：',
        e instanceof Error ? e.message : String(e))
      return { state: 'ok', index: idx, reused: false, cacheWriteFailed: e instanceof Error ? e.message : String(e) }
    }
    return { state: 'ok', index: idx, reused: false }
  } catch (e) {
    return { state: 'unreadable', why: `建档失败：${e?.message || e}`, index: null }
  }
}

/**
 * 用一段文本去查档案。
 * @returns {{hits:Array, state:string, why?:string, note?:string}}
 */
export async function queryArchive(index, queryText, { topK = 4, minScore = ARCHIVE_OPTS.minScore } = {}) {
  // ⚠️ 所有返回分支都带 `stats` —— 否则渲染层说不出"这份索引覆盖了多少"（硬规则 1）
  const stats = index?.stats || null
  if (!index?.vecs?.length) return { hits: [], state: 'empty', stats, note: '档案索引里没有条目' }
  const q = String(queryText || '').trim()
  if (!q) return { hits: [], state: 'empty', stats, note: '没有可用的查询文本' }
  let qv
  try {
    const [v] = await embed([q.replace(/\s+/g, ' ').slice(0, ARCHIVE_OPTS.snip)])
    qv = v
  } catch (e) {
    return { hits: [], state: 'unreadable', stats, why: `查询向量取不到：${e?.message || e}` }
  }
  const scored = index.entries.map((en, i) => ({ ...en, score: cosine(qv, index.vecs[i]) }))
  scored.sort((a, b) => b.score - a.score)
  const hits = scored.slice(0, topK).filter((h) => h.score >= minScore)
  return {
    hits,
    state: 'ok',
    stats,
    note: hits.length ? null : `最相近的一条也只有 ${(scored[0]?.score ?? 0).toFixed(2)}，低于门槛 ${minScore}`,
  }
}

/**
 * 渲染成给人看的一段。
 * ⚠️ 四条纪律：
 *   · 每条都带 `文件:行` 与**小节标题** ⇒ 可核对（硬规则 5）
 *   · 没命中时**说明门槛与最高分**，不静默留白（硬规则 1）
 *   · **必须报出索引覆盖率** —— "没找到"与"只查了 5%"是两回事（实测踩过：一个文件吃光配额，
 *     目标文件根本没进去，而输出只会说"没找到"）
 *   · 措辞中性（§199）—— 说「参考资料」，不写任何渲染性修辞
 */
export function renderArchive(result, { dir = undefined, max = 3 } = {}) {
  // ⚠️ `dir` 的默认值**不能在解构参数里调用 `archiveDir()`**（那仍会在解构时求值一次），
  //    所以拿不到时才现取 —— 这样"配置改了、渲染话术跟着变"才成立（2026-10-16）。
  const dirShown = dir === undefined ? archiveDir().dir : dir
  const s = result.stats
  const cover = s && s.total
    ? `　（**索引覆盖 ${(s.coverage * 100).toFixed(0)}%**：${s.chunks}/${s.total} 块，跨 ${s.filesCovered}/${s.files} 个文件）`
    : ''
  // ⚠️ 档案改过、索引还是旧的 ⇒ **必须说出来**（降级要留痕，硬规则 2）
  const stale = result.stale ? `　⚠️ 档案有改动，索引尚未重建（${result.staleWhy || ''}）` : ''
  if (result.state === 'unconfigured') {
    return '📁 档案检索：**没有配置档案目录 ⇒ 这一路没在找**（不是"没有相关档案"）'
  }
  if (result.state === 'building') {
    return `📁 档案检索：**索引还没就绪** —— ${result.why}（**这一路暂时没在查**，不是"没有相关档案"）`
  }
  if (result.state === 'unreadable') {
    return `📁 档案检索：⚠️ **读不到** —— ${result.why}`
  }
  if (result.state === 'empty') {
    return `📁 档案检索：${result.note || '索引为空'}${cover}`
  }
  if (!result.hits?.length) {
    /**
     * ⚠️ **没命中 ⇒ 不输出**（2026-10-26 改）。
     *
     *   原句是「在 xx 里查过，**没有达到门槛的条目**」——
     *   那句话遵守硬规则 1（空要说明原因），但它**每轮都会出现**，而且对读者毫无信息量：
     *   读者已经知道「没找到」，他要的是「找到了什么有用的」。
     *
     *   ⇒ 这不是"静默返回空"（那样是被禁止的），而是**降级不展示**：
     *     命中数、覆盖率、门槛、stale 全部照旧记进 `report.js` 的 `meta.archive`，
     *     体检/UI 仍然能回答「它到底查到没有」。**不吵，但不隐瞒。**
     */
    return ''
  }
  const L = []
  L.push(`📁 **档案里有过相关记录**（${result.hits.length} 条，来自 ${dirShown}）${cover}${stale}：`)
  for (const h of result.hits.slice(0, max)) {
    L.push(`   · \`${h.file}:${h.line}\`　《${h.title}》　相似度 ${(h.score * 100).toFixed(0)}%`)
    L.push(`     ${String(h.snip).slice(0, 110)}…`)
  }
  /**
   * ⚠️⚠️ **尾句必须按"这个档案是哪种东西"分开写**（2026-10-17 改）。
   *
   *   原句一律是「这是**别的语境**里记下的东西，是否适用要你自己判」。
   *   那句话是给**教训库**写的（我的笔记，确实要使用者自己判）。
   *   但接上**设定档**之后它就**反过来了**：设定档是作者亲手写下的权威，
   *   而作者要解决的问题**恰恰就是"AI 不照我写的世界条件运行"** ——
   *   这时还告诉 AI「是否适用要你自己判」，等于**请它自行改写设定**。
   *
   *   ⇒ 判据：`stats.jsParsed > 0` 就是设定档（`.js` 结构化模块），
   *     走**权威**口径；否则仍走原来的中性口径。
   *   ⚠️ **兜底**：早先建的缓存里 `stats` 没有 `jsParsed`（那时还没这个字段）。
   *     若只认 `jsParsed`，那些缓存就会**静默退回中性口径** —— 又是一处"降级不留痕"。
   *     故再看**命中条目的后缀**：全是 `.js` ⇒ 认定是设定档。
   *     （这样不必为了一个统计字段把索引重建一遍。）
   *   ⚠️ 这是"权威=唯一"那条原则的落地（见 DESIGN-evidence.md 第一节）。
   */
  const hits = result.hits || []
  const jsHits = hits.filter((h) => String(h.file).toLowerCase().endsWith('.js')).length
  const isSettingCorpus = (s?.jsParsed || 0) > 0 || (hits.length > 0 && jsHits === hits.length)
  L.push(isSettingCorpus
    ? '   ⇒ 这是**使用者亲手写下的原档条文**（不是 AI 的推测）。**当前讨论与它冲突时，以档案为准**——不要自行改写、也不要跳过。'
    : '   ⇒ 这是**别的语境**里记下的东西，是否适用要你自己判。')
  return L.join('\n')
}
