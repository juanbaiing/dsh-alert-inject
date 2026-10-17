/**
 * report.js — 总装：**把各检测器汇总成一次自查的输出**
 *
 * ══ 为什么需要它 ══════════════════════════════════════════════════
 *   2026-10-15 接线前状态：11 个模块各自能跑，**只有判据扫描接进了 `alert_check`**，
 *   其余全是"有实现、没接线"。本模块把它们汇总成一份报告。
 *
 * ══ 两条设计纪律 ══════════════════════════════════════════════════
 *   ① **单项失败不影响整体**：每个检测器独立 try/catch —— 工具绝不能让回答失败，
 *      而且**一个坏了不该把其他的一起带下水**（这是本项目反复的教训）。
 *   ② **输出要克制**：一次给模型十段文本 = 淹没。故设总预算，按优先级截断。
 *
 * ══ 昂贵/廉价的分工（决定哪些默认开）══════════════════════════════
 *   · **零成本（毫秒）**：判据扫描、重复检测、引用检查、知识层遍历 → **默认全开**
 *   · **需要 embed（~110ms）**：librarian 检索、FOK、新颖性 → **默认开**（可关）
 *   · **只追加、不改状态**：样本采集（⑦b）→ **默认开**
 *     ⚠️ 2026-10-15 修正：此前样本采集与"入待审"绑在同一个 `useLearning` 开关上，
 *        而那个开关默认关 ⇒ **样本从未被采集**（半年 53 条、路由样本 0 条）。
 *        两者的区别不是"贵不贵"，而是**"写完会不会改变后续行为"**：
 *        样本只是日志（不会），待审队列是状态（会）。
 *   · **改状态**：入待审队列（⑧）→ **默认关**，由调用方显式开
 *     （否则每次自查都往待审队列灌数据）
 *
 * ⚠️ 全部输出遵守同一条铁律：**不回显触发词／不返回档正文／只给指针与理由**。
 */

import { alertText, recentActivity, latestSessionFile, loadTermWords, loadJudges } from './index.js'
import { detectRepetition, renderRepetition } from './repetition.js'
import { detectMissingRefs, renderMissingRefs, defaultBases, projectBases } from './reference-check.js'
import { traverse, renderTraverse } from './knowledge.js'
import { query as librarianQuery, loadCache, cacheState, render as renderLibrarian } from './librarian.js'
import { assess as fokAssess, renderFok } from './fok.js'
import { assess as noveltyAssess, renderNoveltyHint } from './novelty.js'
import { runLearning, harvestUserCorrections, harvestLessons } from './learning.js'
import { needsBootstrap } from './bootstrap.js'
import { buildAnchor, renderAnchorBrief } from './anchor.js'
import { splitBlocks, renderBlocksBrief, currentBlock, indexBlockMap } from './blocks.js'
import { archiveStatus, readCachedIndex, queryArchive, renderArchive } from './archive.js'
import { config } from './config.js'
// ★ 判据池（目标对齐）—— 只追加、权威仅来自用户。见 lib/criteria.js 的模块说明与教训 §267。
import { criteriaPrompt } from './criteria.js'
// ⚠️ 2026-10-16 补：新加的"整理稿自动更新"用了 `path.basename(dirname(sessionFile))`，
//    而本文件此前**根本没 import path** —— `node --check` 只查语法、**查不出未定义变量**，
//    运行时才抛（被 .catch 接住 ⇒ 不崩，但功能不工作）。**加进来。**
import path from 'node:path'

export const REPORT_OPTS = {
  /** 总预算（字符）—— 超过就按优先级丢后面的段 */
  budget: +(process.env.ALERT_BUDGET || 2400),
  /** 是否跑需要 embed 的部分 */
  useRetrieval: process.env.ALERT_NO_RETRIEVAL !== '1',
  /** 是否跑学习循环（**有副作用**：入待审队列，会改变后续行为） */
  useLearning: process.env.ALERT_LEARNING === '1',
  /**
   * 是否采集样本（**append-only 日志，无副作用** ⇒ **默认开**）。
   *
   * ⚠️ 2026-10-15 与 `useLearning` 拆开。此前二者是同一件事，后果是：
   *   `useLearning` 默认 false ⇒ **整个样本采集从未执行** ⇒ 样本库半年只有 53 条、
   *   且**路由样本 0 条**（见作者目标「自动生成样本」）。
   * 区别在"写完会怎样"：
   *   · **样本**：只追加一行 JSONL，**不改任何后续行为** —— 关掉它等于永远攒不到样本；
   *   · **待审**：改 `learning-pending.json`，会进入"待审→收录"流程 —— 这才需要人把关。
   *   ⇒ 故：**样本默认开，待审保持默认关**（提炼可以自动，生效必须经审）。
   * 关掉：`ALERT_NO_SAMPLES=1`
   */
  useSamples: process.env.ALERT_NO_SAMPLES !== '1',
  /** 取多少条痕迹参与检测 */
  scan: +(process.env.ALERT_SCAN || 0),      // 0 = 全量
}

/**
 * ⚠️ 首次引导的"进行中"标记（模块级内存态）。
 *   标记文件要等引导**跑完**才写，中间这段时间可能被调用多次 ⇒
 *   没有它就会**并发启动多次几十秒的引导**。
 *   （进程重启后失效 —— 无妨，那时标记文件通常已写好。）
 */
let _bootstrapping = false
/** ⚠️ 整理稿自动更新的防并发标记（同 `_bootstrapping` 的思路） */
let _normalizing = false

/**
 * 「当前内容」= **最近一条非工具痕迹**。
 * ⚠️ 这是所有"对当前内容做判断"的检测器共用的输入（检索、重复、引用、知识层）。
 *    为什么用最近一条而非拼接多段：**拼接会让语义发散**，而且长文本 embed 更慢。
 * ⚠️ **maxLen 默认 200**（不是 600）：实测 embed 200 字 ≈ 388ms、600 字 ≈ 1207ms，
 *    而 200 字已足够让 bge-m3 判断主题。**自查路径上的延迟必须省。**
 */
export function currentContent(acts, { maxLen = +(process.env.ALERT_CUR_LEN || 200) } = {}) {
  for (let i = acts.length - 1; i >= 0; i--) {
    const a = acts[i]
    if (a.kind === '思考' || a.kind === '正文') {
      return { text: a.text.slice(0, maxLen), pos: i + 1, kind: a.kind }
    }
  }
  return null
}

/**
 * 组装完整报告。
 * @returns {{sections:{name,text,cost}[], text:string, meta:object}}
 */
export async function buildReport(cwd, opts = {}) {
  const O = { ...REPORT_OPTS, ...opts }
  const root = config().projectRoot || cwd
  const out = { sections: [], meta: { cwd, root, skipped: [] } }

  // 读会话痕迹（一次，各检测器共用）
  let acts = []
  let sessionFile = null
  try {
    sessionFile = opts.sessionFile || latestSessionFile(cwd)
    if (sessionFile) acts = recentActivity(sessionFile, O.scan)
  } catch { /* 读不到就只跑不需要会话的部分 */ }
  out.meta.acts = acts.length
  out.meta.session = sessionFile ? sessionFile.split(/[\\/]/).slice(-2)[0] : null

  /**
   * ★★ 没开思考的防护（2026-10-17 加）
   *
   *   事实：`reasoningEffort=off` 时 reasoning 块为 **0** —— 这是作者自己实测记下的
   *   （`lib/index.js` 里那句「哨兵全瞎」）。而在这次改动之前，**没有任何地方在运行时报出这件事**：
   *   「思考」类痕迹为 0 ⇒ 依赖它的几路检测全部空转，而输出看起来一切正常。
   *   ⇒ 这正是本项目第一条硬规则要防的情形：「**没找到**」与「**我没在找**」是两回事。
   *
   * ⚠️ 为什么每轮都报、而不是只报一次：它是**持续失效**，不是一次性事件。
   *   但要短 —— 一行说完，否则用户会去关掉它（那时它就成了要治的那个病）。
   */
  const kindCount = {}
  for (const a of acts) kindCount[a.kind] = (kindCount[a.kind] || 0) + 1
  out.meta.kinds = kindCount
  if (acts.length > 0 && !kindCount['思考']) {
    out.meta.noReasoning = true
    out.sections.push({
      name: '痕迹',
      text: `⚠️ 本场「思考」痕迹为 **0 条**（多半是 reasoningEffort=off）`
        + `　已读到：${Object.entries(kindCount).map(([k, v]) => `${k} ${v}`).join('／')}`
        + '\n  ⇒ 重复检测／引用检查／知识层遍历**这几路没在查**，这是「我没在找」，不是「没有异常」。'
        + '想让它生效就在 DSH 里打开思考强度、重开一场。',
      cost: 'free',
    })
  }

  // ══════════════════════════════════════════════════════════════════
  // ★ 按上下文范围取样（作者设想 · 2026-10-13 01:55）
  //
  //   > **按语境来确认取这棵树上的哪一个节点，并向两侧递减**
  //
  //   ⚠️ 为什么必须做（2026-10-15 实测）：
  //     `buildReport` 原本把**全量痕迹**喂给每一个检测器。profile 显示两大开销：
  //       · `recentActivity` 读+解压全量      **2750 ms**
  //       · `readConstraints` 扫全部用户发言   **2312 ms** ← 全量 acts 的直接后果
  //     而**判据扫描只要 120 ms** —— 因为它内部已经按语境过滤了。
  //     ⇒ **贵的不是"读"，是"拿着全量去扫"**（作者指出这一点时我理解反了）。
  //
  //   ⚠️ 保留策略（**两段都要留，缺一不可**）：
  //     · **会话开头** —— 目标/约束在这里（锚点的立身之本）
  //     · **当前语境块** —— 正在谈的事在这里
  //     中间那段才是可省的。（只留当前块会丢目标；只留开头会丢语境。）
  // ══════════════════════════════════════════════════════════════════
  const KEEP_EARLY = +(process.env.ALERT_KEEP_EARLY || 80)         // 会话开头保留多少条
  const KEEP_BLOCKS = +(process.env.ALERT_KEEP_BLOCKS || 3)        // 当前语境块 + 前 N 块
  let scopedActs = acts
  let scopeNote = ''
  try {
    if (acts.length > KEEP_EARLY * 2) {
      const bl = splitBlocks(acts)
      const last = currentBlock(bl)
      const keep = new Set()
      for (let i = 0; i < Math.min(KEEP_EARLY, acts.length); i++) keep.add(i)
      for (const b of bl) if (b.index >= last - KEEP_BLOCKS + 1) for (const i of b.items) keep.add(i)
      scopedActs = acts.filter((_, i) => keep.has(i))
      scopeNote = `按上下文范围取样：${acts.length} → ${scopedActs.length} 条` +
        `（开头 ${KEEP_EARLY} 条［目标/约束］＋ 当前语境 ${Math.min(KEEP_BLOCKS, bl.length)} 块）；中间段未参与扫描`
    }
  } catch (e) {
    // ⚠️ 降级要留痕（§239）：取样失败就退回全量，**但必须说出来**
    out.meta.skipped.push(`上下文取样失败，已退回全量: ${e.message}`)
  }
  if (scopeNote) out.meta.scope = scopeNote
  out.meta.scopedActs = scopedActs.length

  // ⚠️ 语境块用**全量 acts** 切（1 ms，很便宜）——
  //    若用筛过的 acts 再切，块号与"换过几段话题"会失真。
  let blocks = []
  try { blocks = splitBlocks(acts) } catch { /* 忽略 */ }

  const cur = currentContent(scopedActs)
  out.meta.current = cur ? { pos: cur.pos, kind: cur.kind, len: cur.text.length } : null

  const safe = (name, fn, cost = 'free') => {
    try {
      const text = fn()
      if (text) out.sections.push({ name, text, cost })
    } catch (e) {
      out.meta.skipped.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * ★★ **「这次该不该连带出相似位置」—— 2026-10-17 加（作者口径）**
   *
   * 作者原话：「**相似度留在反馈里，只是和异常一起触发，不是单独触发；
   *   如果 AI 主动想去搜索，那就去用工具。**」
   *
   * ══ 第一版错在哪（必须记下来）══════════════════════════════════
   *   我一开始把"异常"定义成一张五段的集合（判据池/判据扫描/重复/引用/新颖性），
   *   结果实测：**「判据池有一条待确认」把相似位置也带出来了**。
   *   但**判据池的问题和"回忆"毫无关系** —— 那是"目标没定清"，不是"你以前说过类似的话"。
   *   ⇒ **连带必须限于语义相关的那几类异常**，否则相似度会被无关异常反复牵引出来，
   *     又变回噪音（与本节目的正好相反）。
   *
   * ══ 正确划分 ══════════════════════════════════════════════════
   * 只有这些异常**与"回忆"有关**，值得附上相似位置当佐证：
   *   · **重复检测** —— 说的和之前高度重合 ⇒ 相似位置正是证据（"你第 N 条就说过"）
   *   · **新颖性** —— 出现陌生术语 ⇒ 可能之前提过/有相关档
   *   · **知晓感 fuzzy 且 top1≥0.70** —— 真正的"疑惑"（单独在 ⑤ 判，不进这张表）
   * ⚠️ **不连带**：判据池（目标问题）、判据扫描（违反规则）、引用检查（文件不存在）——
   *   它们都是异常，但**跟"以前说过没"无关**，连带相似度只会稀释真正的信号。
   */
  const RECALL_TRIGGERS = new Set(['重复检测', '新颖性'])
  const shouldRecall = () => out.sections.some((s) => RECALL_TRIGGERS.has(s.name) && String(s.text || '').trim())
  /** 知晓感判为「说不准」（fuzzy）且知道感够强 —— 它本身也算一次"疑惑" */
  let isFuzzy = false

  // ⓪ **判据池（目标对齐）—— 放在最前面，且只在真需要时出声**
  //
  //   ⚠️ 为什么排第一：它管的是「**你正在做的事，服务于哪个目标**」——
  //     比"哪句话重复了""哪里像过"高一个层面。§267 那个错（连做四轮都不是作者要的）
  //     正是"没有目标可对齐"导致的。
  //   ⚠️ ⚠️ 但它**不每轮说话**：`criteriaPrompt()` 只在
  //     ① 判据池是空的（⇒ AI 在无目标状态下工作）② 有提议未确认 时才返回文本。
  //     正常状态下返回空串 —— 依据是 ECLAIR(AAAI) 的结论：**precision 比 recall 重要**，
  //     不必要的澄清问题会显著破坏体验。平时一个字都不多。
  safe('判据池', () => criteriaPrompt(), 'free')

  // ① 判据扫描（零成本）—— ⚠️ 传 acts 复用（省 ~450ms）；⚠️ scope 默认 current（语境过滤）
  //    实测：不过滤时报 45 处、其中当前语境 0 处 ⇒ **全是跨语境误报**。
  safe('判据扫描', () => (sessionFile ? alertText(cwd, sessionFile, scopedActs, { scope: O.scope || 'current' }) : ''), 'free')

  // ② 锚点（零成本）—— 「你本来在干什么」
  //    ⚠️ **用简报版**（2026-10-15 验收测试后改）：完整版会把常驻背景铺成一张清单，
  //       实测占 608 字里的绝大多数、76% 是列表项 ⇒ **像报告不像提醒**。
  //       「端上来的**是不是他点的那盘**」——这是验收测试要问的问题。
  if (sessionFile) {
    safe('锚点', () => renderAnchorBrief(buildAnchor(sessionFile, scopedActs)), 'free')
    // ②b 语境 —— 同样用简报版：只回答"现在在谈什么"（一行）
    safe('语境', () => {
      const jj = loadJudges(root)
      const maskList = []
      for (const j of jj.judges || []) {
        maskList.push(...(j.signals || []), ...(j.anomalies || []))
        for (const m of (jj.meta || [])) maskList.push(m)
      }
      return renderBlocksBrief(blocks, { mask: maskList })
    }, 'free')
  }

  // ② 重复检测（零成本）—— 对【当前内容】而不是全库（循环的特征是"局部反复"）
  if (cur) {
    safe('重复检测', () => renderRepetition(cur.pos, detectRepetition(cur.text)), 'free')
  }

  // ③ 引用存在性（零成本）
  if (cur) {
    safe('引用检查', () => {
      const bases = root ? projectBases(root, [cwd].filter(Boolean)) : defaultBases(cwd)
      const r = detectMissingRefs(cur.text, { bases })
      return r.missing.length ? renderMissingRefs(cur.pos, r) : ''
    }, 'free')
  }

  // ④ 知识层遍历（零成本，走图）
  if (cur && root) {
    safe('知识层', () => {
      const r = traverse(cur.text, { projectRoot: root })
      return r.hits?.length ? renderTraverse(r) : ''
    }, 'free')
  }

  // ⑤⑥⑦ 需要 embed 的部分（~110ms 一次）
  if (O.useRetrieval && cur && sessionFile) {
    let idx = null
    try { idx = loadCache(sessionFile) } catch { /* 无缓存 */ }
    if (!idx) {
      // ⚠️⚠️ 必须说清「**为什么**没有索引」（2026-10-16 修）——
      //   实测踩到：当前会话**建过**索引、只是长过了 50%，
      //   而报告写「**未建索引**」⇒ **把人引向错误的排查方向**。
      const cs = cacheState(sessionFile)
      const why = cs.state === 'missing'
        ? '从未建过索引'
        : cs.state === 'unreadable'
          ? `缓存读不动（${cs.detail}）`
          : `索引已过期（${cs.detail}）`
      // ⚠️ 不能 await 重建：要 35 秒~数分钟，await 会把自查卡死。
      //    ⇒ fire-and-forget，本轮先说清、下一轮就能用上（与 `bootstrap` 同一思路）。
      const willRebuild = cs.state === 'missing' || cs.state === 'stale'
      out.meta.skipped.push(`语义检索: ${why}${willRebuild ? ' ⇒ **已在后台重建**，本轮先跳过' : ''}`)
      if (willRebuild) {
        import('./librarian.js')
          .then(({ ensureIndex }) => ensureIndex(sessionFile, {
            onLog: (m) => console.warn(`[alert-inject] 索引${m}`),
          }))
          .then((r) => {
            if (r?.rebuilt) {
              console.warn(`[alert-inject] ✅ 索引已重建：${r.entries} 条 / ${r.regions} 区域，耗时 ${(r.ms / 1000).toFixed(1)}s`)
            } else if (r?.error) {
              console.warn('[alert-inject] ⚠️ 索引重建没成功：', r.error)
            }
          })
          .catch((e) => console.warn('[alert-inject] ⚠️ 索引重建失败：', e?.message || e))
      }
    } else {
      let qr = null
      try {
        // 一次 embed，三个解读器（检索/FOK/新颖性）共用同一份结果
        qr = await librarianQuery(idx, cur.text, { topK: 5 })
      } catch (e) { out.meta.skipped.push(`检索: ${e.message}`) }

      if (qr) {
        // ⑤ 知晓感 —— **"疑惑"信号**：certain 表示"有明确对应"⇒ 不报（那是正常）；
        //    fuzzy／unknown 才报，且它本身算一次异常（会连带触发下面的相似度）。
        let fok = null
        try { fok = fokAssess(qr) } catch { /* 无 FOK 不影响其余检测器 */ }
        /**
         * ⚠️⚠️ 【"疑惑"必须同时满足两条，只满足一条都是误判】—— 2026-10-17 改
         *
         *   第一版写成 `level !== 'certain'` ⇒ 把 unknown 也算疑惑（错，见下）；
         *   第二版改成 `level === 'fuzzy'` ⇒ **仍然每轮都触发**，因为实测：
         *     `top1=63% top2=62% gap=1% near=5`
         *   —— 5 处都在 60% 上下、彼此只差 1%。这不是"有一处快想起来了"，
         *      而是**"哪一处都不突出"**。把它叫"疑惑"是判据选错（同 §248 ①）。
         *
         *   ⚠️ 更关键的标定问题：`fok.js` 的 `fuzzy` 下限是 **0.58**，
         *   而本项目在 CLINC150 上的实测是 **in-scope 中位 0.796 / oos 中位 0.579**
         *   ⇒ **0.58 恰好是"不相关"的中位数** ⇒ fuzzy 区间的下半截装的其实是"没有对应"。
         *
         *   ⇒ 故"疑惑"要同时满足：
         *     ① 等级为 fuzzy（有几分像）
         *     ② **top1 ≥ 0.70**（知道感够强 —— 0.70 是上面那个实测的分离点）
         *   只在两条都成立时才算异常、才连带出相似位置。
         *   ⚠️ 这里**不改 fok.js 的阈值**（它还有别的用途），只在"要不要报"这一层加筛选。
         */
        const FOK_DOUBT_MIN = +(process.env.ALERT_FOK_DOUBT_MIN || 0.70)
        isFuzzy = !!fok && fok.level === 'fuzzy' && (fok.metrics?.top1 ?? 0) >= FOK_DOUBT_MIN
        if (isFuzzy) safe('知晓感', () => renderFok(fok), 'embed')

        // ⑥ 新颖性 —— 陌生术语 = 预期落空，照报
        safe('新颖性', () => renderNoveltyHint(noveltyAssess(qr, cur.text, loadTermWords(root))), 'embed')

        // ⑦ 回忆指针 —— ⚠️⚠️ **只在有异常时连带出**（作者 2026-10-17 口径）
        //   「相似度留在反馈里，只是和异常一起触发，不是单独触发。」
        //   ⇒ 平时不播报（稳定事件会被忽略，见 shouldRecall() 的注释）；
        //     想主动查位置时用工具 `recall`。
        if (isFuzzy || shouldRecall()) {
          safe('回忆指针', () => {
            const t = renderLibrarian(qr)
            // ⚠️ 一句引导：工具**存在** ≠ 模型**知道它能用**。
            //   文献实测 LLM 很少主动调工具（Knowing but Not Showing, 2026），
            //   所以只在"真出了疑惑"时提一句 —— 平时不提，免得又成背景。
            return t ? `${t}\n（想主动查别的内容、或确认"我是不是说过某件事"，可以调 recall 工具。）` : t
          }, 'embed')
        }
      }
    }

    // ⚠️ 先取语境区状态（`ctxState` 必须在使用它**之前**定义）。
    //    ⚠️⚠️ 这一处我改坏过两次，**两次都是 `node --check` 过的**：
    //      第一次把定义和残留的重复块一起删了（`ReferenceError: ctxState is not defined`）；
    //      第二次定义落在了使用之后（`Cannot access 'ctxState' before initialization`）。
    //      ⇒ 语法通过 ≠ 能跑；**搬过代码之后必须真跑一次**（这里靠 `tools/check-cross-e2e.mjs` 抓到）。
    let ctxState = null
    try {
      const { contextState } = await import('./contexts.js')
      ctxState = await contextState(out.meta.session)
    } catch (e) { out.meta.skipped.push(`语境区: 读数失败（${e?.message || e}）`) }

    // ══════════════════════════════════════════════════════════════
    // ★ 跨对话检索（语境区接线，2026-10-16）
    //
    // 作者的设计：「建立一个分区，确定它查哪个会话」／「同语境跨对话」
    //   「在这个语境区里面的对话里面调用工具就会兼顾其他对话，**但要把利弊和用户说清楚**」
    //
    // ⚠️⚠️ **这一段必须在 `if (!idx)` 之外**（第一版写在 else 里，实测踩到）：
    //   当前会话索引**过期**时（本机实测 0.5MB→3.4MB 就判过期），`!idx` 成立 ⇒
    //   走"后台重建、本轮跳过"分支 —— 而跨对话被我写在了那个 else 里
    //   ⇒ **跨对话被"当前会话索引过期"连累，一起静默跳过了**，
    //   而报告当时只会说"语义检索已过期"，**看不出跨对话也没跑**。
    //   而跨对话**根本不需要当前索引**：它拿 `cur.text`（当前在谈的事）去查**别的**对话的索引。
    //   ⇒ 教训：**把"依赖 A"与"依赖 B"的两件事塞进同一个 if/else，会造出假依赖。**
    //
    // ⚠️ 三条硬约束（缺一条就是弊大于利）：
    //   ① **默认关闭**：`enabled` 且 `anchor` 都齐了才走（校验在 `contexts.js`）；
    //   ② **每条命中必须标明来自哪一场** —— 作者点出的"会记串"就是靠这个防的：
    //      三月的决定和今天的结论被一起端上来时，**没有来源标注就变成错误信息**；
    //   ③ **不能 await 重建别的会话索引**（几十秒）⇒ 没索引的**明说"这次没翻它"**，按需后台补。
    // ══════════════════════════════════════════════════════════════
    const others = ctxState?.enabled
      ? (ctxState.sessions || []).filter((s) => ctxState.selected.includes(s.id) && s.id !== out.meta.session)
      : []
    out.meta.contexts = ctxState
      ? { enabled: !!ctxState.enabled, selected: ctxState.selected.length, used: others.length, anchor: ctxState.anchorName || ctxState.anchor || null }
      : null

    if (ctxState?.enabled && others.length) {
      const t0 = Date.now()
      const hits = []
      let noIndex = 0
      for (const s of others.slice(0, 5)) {          // ⚠️ 上限 5 场，防一次自查变成 N 倍 embed
        try {
          const oIdx = loadCache(s.file)
          if (!oIdx) {
            noIndex++
            // 没索引：**说清"这次没翻它"**，并让它在后台补（不阻塞本轮）
            import('./librarian.js')
              .then(({ ensureIndex }) => ensureIndex(s.file, { onLog: (m) => console.error(`[alert-inject] 语境区索引${m}`) }))
              .catch(() => { /* 留痕靠下面那句 skipped */ })
            continue
          }
          const oqr = await librarianQuery(oIdx, cur.text, { topK: 2 })
          const best = oqr?.top?.[0]
          if (best) {
            // ⚠️ 复用现有渲染器，但**先复制再改** —— 直接改会污染原检索结果
            hits.push({ ...best, fromContext: s.title || s.workspace || s.id, fromMb: s.mb, fromAt: s.updatedAt })
          }
        } catch (e) {
          out.meta.skipped.push(`语境区·${(s.title || s.id).slice(0, 12)}: 检索失败（${e?.message || e}）`)
        }
      }
      if (hits.length) {
        hits.sort((a, b) => (b.sim ?? 0) - (a.sim ?? 0))
        safe('跨对话回忆', () => renderLibrarian({ top: hits, cross: true }), 'embed')
      }
      out.meta.crossMs = Date.now() - t0
      if (noIndex) {
        out.meta.skipped.push(`语境区: 有 ${noIndex} 场还没建索引 ⇒ **这次没翻它们**（已在后台补，下一轮可用）`)
      }
    } else if (ctxState?.enabled && !others.length) {
      /**
       * ⚠️⚠️ 这里必须分两种情形说（2026-10-17 实测抓到的误导）：
       *
       *   作者在语境区挂了 2 场（配置里 `selected` 确实是 2 个），
       *   而 `alert_check` 报的是「里面只有当前这一场 ⇒ 没有别的对话可翻」——
       *   这句话让他以为"挂载没生效"。实际是那一刻列表里还没出现它们。
       *
       *   ⇒ 「**你没挂**」与「**挂了但这轮没翻到**」是两件事，
       *     原话把后者说成了前者的语气。这正是硬规则 1 说的：
       *     「没找到」与「我没在找」必须分开讲。
       */
      const nSel = ctxState.selected?.length || 0
      if (nSel > 1) {
        out.meta.skipped.push(
          `语境区: 你挂了 ${nSel} 场，但它们这一轮没进会话列表 ⇒ **这次没翻**`
          + '（刚挂上的那几轮可能还在准备，不是"没有别的对话"）'
        )
      } else {
        out.meta.skipped.push('语境区: 开关已打开，但里面只有当前这一场 ⇒ 没有别的对话可翻')
      }
    }
  } else if (!O.useRetrieval) {
    out.meta.skipped.push('语义检索: 已被 ALERT_NO_RETRIEVAL=1 关闭')
  }

  // ⑨ 档案检索（**另一路**，2026-10-16 加）—— 把项目**之外**的档案接进来
  //
  // ⚠️ 为什么**独立成一段**、不混进上面的会话检索：
  //   作者反复强调「**分语境是我一直强调的**」。档案是**另一个语境**
  //   （教训库/笔记/设定档）。把它与会话痕迹放在一起排序，
  //   等于用"语境 A 的相似度"去解释"语境 B 的问题"。
  //
  // ⚠️ 为什么**只读缓存**：建一次档案索引实测要 **6 分钟**（400 块）。
  //   而本项目已有同一结论（上面 ⑤⑥⑦ 段的注释）：「不能 await 重建……会把自查卡死」。
  //   ⇒ 热路径只读；没就绪就**明说"这一路暂时没在查"**，再后台去建。
  //
  // ⚠️ 三态：`unconfigured`（**没配目录 ⇒ 有意不出声**，每次都念一遍会变噪音）
  //        `unreadable`（配了却读不到 ⇒ **必须出声**）
  //        `ok` 但索引没就绪 ⇒ **必须出声**（否则"没查到"会被误读成"没有"）
  if (cur) {
    try {
      const st = archiveStatus()
      if (st.state === 'unreadable') {
        out.sections.push({
          name: '档案',
          text: renderArchive({ state: 'unreadable', why: st.why }),
          cost: 'free',
        })
      } else if (st.state === 'ok') {
        const c = readCachedIndex()
        if (c.state === 'ok') {
          const r = await queryArchive(c.index, cur.text, { topK: 3 })
          /**
           * ⚠️ 档案**命中结果也是"相似度类"** ⇒ 与 ⑦ 同一口径：**只在有异常时才端出来**。
           *   理由同 shouldRecall() 的注释：稳定的、每轮都有的东西会被忽略，
           *   报出来只增加噪音而不增加信息。
           *   ⚠️ 但 `meta.archive` **照样记录**（含 `suppressed`），
           *     这样体检/UI 仍能回答「它到底查到没有」—— 不静默，只是不吵。
           */
          const show = isFuzzy || shouldRecall()
          const text = renderArchive({ ...r, stale: c.stale, staleWhy: c.why })
          if (text && show) out.sections.push({ name: '档案', text, cost: 'embed' })
          out.meta.archive = {
            dir: st.dir, hits: r.hits.length, coverage: r.stats?.coverage ?? null,
            stale: !!c.stale, suppressed: text ? !show : false,
          }
        } else {
          out.sections.push({
            name: '档案',
            text: renderArchive({ state: 'building', why: c.why }),
            cost: 'free',
          })
          out.meta.archive = { dir: st.dir, state: 'building', why: c.why }
          // fire-and-forget 建索引（与 ⑦b2 整理稿、bootstrap 同一套做法）
          import('./archive.js')
            .then(({ ensureArchiveIndex }) => ensureArchiveIndex(st.dir, {
              onLog: (m) => console.warn(`[alert-inject] ${m}`),
            }))
            .then((r2) => {
              const s2 = r2?.index?.stats
              if (r2?.state === 'ok') {
                console.warn(`[alert-inject] ✅ 档案索引已建：${s2?.chunks} 块 / ${s2?.files} 文件，覆盖 ${((s2?.coverage || 0) * 100).toFixed(0)}%`)
              } else {
                console.warn('[alert-inject] ⚠️ 档案索引没建成：', r2?.why)
              }
            })
            .catch((e) => console.warn('[alert-inject] ⚠️ 档案索引失败：', e?.message || e))
        }
      }
    } catch (e) { out.meta.skipped.push(`档案: ${e.message}`) }
  }

  // ⑦b 样本采集（**默认开**）—— 把作者自己的纠正落成「自带标签」的样本
  //
  // ⚠️ 本段独立于 ⑧，理由见 REPORT_OPTS.useSamples 的注释：
  //   它**只追加一行日志，不改任何后续行为**，所以不该跟着"入待审"一起默认关。
  //   关掉它的代价是**永久的**：没有样本 ⇒ 规则永远是规则 ⇒ 规则不会长成模型。
  //   （作者 2026-10-15：「规则太死，无法长起来」。）
  if (O.useSamples && acts.length) {
    try {
      // ★ 语境块号（2026-10-16 修）—— **不按语境分开的样本是废样本**：
      //   不同语境的"纠正"（绘画的、写代码的、世界模拟的……）混成一类时，标签不再有意义。
      //   这是作者亲自指出的 bug，详见 `lib/context.js` 的 `toRecords` 说明。
      const blocks = splitBlocks(scopedActs)
      const r = harvestUserCorrections(scopedActs, sessionFile, {
        blockOf: indexBlockMap(blocks),
        blockCount: blocks.length,
      })
      if (r.added) {
        out.meta.correctionSamples = r.added
        out.meta.correctionSamplesBlocks = `${r.withBlock}/${r.added} 条带语境块号，共 ${blocks.length} 块`
        // ⚠️ 没拿到块号的条数**必须报出来**，不能吞掉 —— 这正是本 bug 的形态（维度静默丢失）
        if (r.noBlock) {
          out.meta.correctionSamplesNoBlock = `⚠️ ${r.noBlock} / ${r.added} 条**没拿到语境块号**（ref.block = null）`
        }
      }
    } catch (e) { out.meta.skipped.push(`纠正样本: ${e.message}`) }

    // ★ 教训采集（2026-10-16 接线）—— `harvestLessons` 写在 `learning.js:591`，
    //   此前**全项目零调用点**（同 §238「凡声称已实现，先 grep 调用点」的形态）。
    //
    // ⚠️ 为什么它该与 ⑦b 并列、同一个开关：
    //    两者都**只追加日志、不改后续行为**（作者判据：改状态的默认关，只追加的默认开）。
    //
    // ⚠️ 为什么用 `scopedActs` 而不是全量 `acts`：与 ⑦b 的样本**同一批痕迹** ——
    //    否则"样本按上下文范围取样、教训却是全程扫"⇒ 两者对不上，没法互相对照。
    //
    // ⚠️ `lessons` 是**独立库**（作者定：「教训要单开一个……命中教训都要单开一个警报」），
    //    它将来要**升级成直接匹配**，所以不能混进 `cases`（混装会毁掉那次升级）。
    //
    // ⚠️ `noLesson` **必须报出来**：它是"这轮确实没有教训"的**凭证**。
    //    少了它，「加了 0 条」就分不清是"没有教训"还是"提取器坏了"（硬规则 1）。
    try {
      const lr = await harvestLessons(scopedActs, sessionFile, {
        blockOf: indexBlockMap(blocks),
        blockCount: blocks.length,
      })
      out.meta.lessons = { added: lr.added, total: lr.total, noLesson: lr.noLesson }
      if (lr.failed) out.meta.lessonsFailed = `⚠️ ${lr.failed} 条写失败：${lr.error || '（没给原因）'}`
    } catch (e) { out.meta.skipped.push(`教训采集: ${e.message}`) }
  }

  // ⑦b2 整理稿（L2）自动更新 —— **默认开**，fire-and-forget（2026-10-16 加）
  //
  // ⚠️ 为什么必须自动：在此之前 `lib/context.js` **没有任何调用点**（接线审计报的孤岛），
  //    整理稿只能手动跑 ⇒「**新对话自己进整理稿**」这件事从来不存在。
  //
  // ⚠️⚠️ **绝不 await**：整理一个 20.91MB 的会话实测要 **3.0 秒**，
  //    await 会把自查本身拖长（而自查已经在 5~6 秒）。⇒ 与 `bootstrap` 同一套做法：
  //    本轮先跳过、下一轮就能用上。**失败只记日志、绝不抛**（但按 §239 必须留痕）。
  //
  // ⚠️ 成本几乎为零的原因：`normalizeSession` 自带**水位线** ——
  //    源文件没长就直接复用（实测「源没变化 ⇒ 直接复用（没重算）」），
  //    所以**每轮调用它并不会每轮重算**。
  //
  // ⚠️ 与语义检索**无关**：整理不需要 embed ⇒ 别把它绑在 `useRetrieval` 上。
  if (O.useSamples && sessionFile && acts.length && !_normalizing) {
    _normalizing = true
    import('./context.js')
      .then(async ({ normalizeSession, loadContext }) => {
        const r = normalizeSession(sessionFile)
        if (!r.ok) {
          console.warn(`[alert-inject] ⚠️ 整理稿没做成：${r.reason || '（没给原因 —— 这是缺陷）'}`)
          return null
        }
        if (r.reused) return null                    // 源没变 ⇒ 什么都不用做、也不用出声
        console.warn(`[alert-inject] ✅ 整理稿已更新：${r.total} 条 / ${r.blocks} 块`)
        // 顺手把语境块灌进 `cases` 库（**幂等**：靠内容指纹去重，重复跑不会重复灌）
        const c = loadContext(sessionFile)
        if (!c.fromL2) {
          console.warn(`[alert-inject] ⚠️ 整理稿写完却读不回来：${c.note}`)
          return null
        }
        const { appendEntry } = await import('./db.js')
        const sessTag = path.basename(path.dirname(sessionFile))
        let added = 0, failed = 0
        for (const g of c.groups) {
          const res = appendEntry('cases', {
            kind: '案例',
            what: `第 ${g.block} 块：${String(g.head || '').slice(0, 100)}`,
            from: { session: sessTag, pos: g.items?.[0]?.srcPos ?? null, block: g.block },
            when: (c.meta && c.meta.at) || new Date().toISOString(),
            conf: 'derived',
            src: '整理稿',
            ver: 1,
            n: g.n,
            kinds: g.kinds,
          })
          if (res.ok && res.added) added++
          else if (!res.ok) failed++
        }
        console.warn(`[alert-inject] ✅ cases 库：新记 ${added} 条${failed ? `，**失败 ${failed} 条**` : ''}`)
        return { added, failed }
      })
      .catch((e) => console.warn('[alert-inject] ⚠️ 整理稿自动更新失败：', e?.message || e))
      .finally(() => { _normalizing = false })
  }

  // ⑦c 首次引导（**一辈子只跑一次**）—— 把本机已有的历史会话一次性利用起来
  //
  // ⚠️⚠️ **绝不 await**（实测 163 MB / 115 个会话要 **48 秒**）——
  //     awaiting 它会让**第一次调用直接卡住几十秒**，等于把工具变成不可用。
  //     Electron/DSH 主进程常驻 ⇒ fire-and-forget 安全：跑完自己写标记，
  //     下次自查时样本已经在了。**失败只记日志、绝不抛**（工具不能让回答失败，
  //     但按教训 §239，**降级必须留痕**，所以走 console.warn）。
  // ⚠️ 内存标记防重复启动：标记文件要"跑完"才写，中间可能被调用多次。
  if (O.useSamples && !_bootstrapping && needsBootstrap()) {
    _bootstrapping = true
    import('./bootstrap.js')
      .then(({ runBootstrap }) => runBootstrap({ maxSessions: 120, maxBytes: 120 * 1024 * 1024 }))
      .then((r) => console.warn(
        `[alert-inject] 首次引导完成：扫 ${r.sessions} 个会话（${(r.bytes / 1048576).toFixed(0)} MB），` +
        `补入弱标注 ${r.weak - r.weakDup} 条、作者纠正 ${r.corrections} 条，耗时 ${(r.ms / 1000).toFixed(0)}s`))
      .catch((e) => console.warn('[alert-inject] 首次引导失败：', e?.message || e))
      .finally(() => { _bootstrapping = false })
  }

  // ⑧ 学习循环（**默认关**：入待审队列 = 改状态，需人把关）
  if (O.useLearning && acts.length && sessionFile) {
    try {
      const r = runLearning(scopedActs, sessionFile, { dryRun: opts.learningDryRun !== false })
      out.meta.learning = r.stats
      if (r.rendered) out.sections.push({ name: '学习', text: r.rendered, cost: 'side-effect' })
    } catch (e) { out.meta.skipped.push(`学习: ${e.message}`) }
  }

  // ── 按预算组装（顺序即优先级）──
  const parts = []
  let used = 0
  for (const s of out.sections) {
    if (used + s.text.length > O.budget) { out.meta.truncated = (out.meta.truncated || 0) + 1; continue }
    parts.push(s.text); used += s.text.length
  }
  out.text = parts.join('\n\n')
  out.used = used
  return out
}
