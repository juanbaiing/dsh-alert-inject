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
 *   · **有副作用**：学习循环（写样本/待审）→ **默认关**，由调用方显式开
 *     （否则每次自查都往待审队列灌数据）
 *
 * ⚠️ 全部输出遵守同一条铁律：**不回显触发词／不返回档正文／只给指针与理由**。
 */

import { alertText, recentActivity, latestSessionFile, loadTermWords, loadJudges } from './index.js'
import { detectRepetition, renderRepetition } from './repetition.js'
import { detectMissingRefs, renderMissingRefs, defaultBases, projectBases } from './reference-check.js'
import { traverse, renderTraverse } from './knowledge.js'
import { query as librarianQuery, loadCache, render as renderLibrarian } from './librarian.js'
import { assess as fokAssess, renderFok } from './fok.js'
import { assess as noveltyAssess, renderNoveltyHint } from './novelty.js'
import { runLearning } from './learning.js'
import { buildAnchor, renderAnchorBrief } from './anchor.js'
import { splitBlocks, renderBlocksBrief } from './blocks.js'
import { config } from './config.js'

export const REPORT_OPTS = {
  /** 总预算（字符）—— 超过就按优先级丢后面的段 */
  budget: +(process.env.ALERT_BUDGET || 2400),
  /** 是否跑需要 embed 的部分 */
  useRetrieval: process.env.ALERT_NO_RETRIEVAL !== '1',
  /** 是否跑学习循环（**有副作用**：写样本 + 入待审） */
  useLearning: process.env.ALERT_LEARNING === '1',
  /** 取多少条痕迹参与检测 */
  scan: +(process.env.ALERT_SCAN || 0),      // 0 = 全量
}

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

  const cur = currentContent(acts)
  out.meta.current = cur ? { pos: cur.pos, kind: cur.kind, len: cur.text.length } : null

  const safe = (name, fn, cost = 'free') => {
    try {
      const text = fn()
      if (text) out.sections.push({ name, text, cost })
    } catch (e) {
      out.meta.skipped.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ① 判据扫描（零成本）—— ⚠️ 传 acts 复用（省 ~450ms）；⚠️ scope 默认 current（语境过滤）
  //    实测：不过滤时报 45 处、其中当前语境 0 处 ⇒ **全是跨语境误报**。
  safe('判据扫描', () => (sessionFile ? alertText(cwd, sessionFile, acts, { scope: O.scope || 'current' }) : ''), 'free')

  // ② 锚点（零成本）—— 「你本来在干什么」
  //    ⚠️ **用简报版**（2026-10-15 验收测试后改）：完整版会把常驻背景铺成一张清单，
  //       实测占 608 字里的绝大多数、76% 是列表项 ⇒ **像报告不像提醒**。
  //       「端上来的**是不是他点的那盘**」——这是验收测试要问的问题。
  if (sessionFile) {
    safe('锚点', () => renderAnchorBrief(buildAnchor(sessionFile, acts)), 'free')
    // ②b 语境 —— 同样用简报版：只回答"现在在谈什么"（一行）
    safe('语境', () => {
      const jj = loadJudges(root)
      const maskList = []
      for (const j of jj.judges || []) {
        maskList.push(...(j.signals || []), ...(j.anomalies || []))
        for (const m of (jj.meta || [])) maskList.push(m)
      }
      return renderBlocksBrief(splitBlocks(acts), { mask: maskList })
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
    // ⚠️ 不在自查路径上建索引：embed 全量要几分钟（实测 120 条 12.9s、全量 8 分钟）
    //    ⇒ 没有缓存就跳过，由使用者另行建索引（`librarian.js` CLI）。
    if (!idx) {
      out.meta.skipped.push('语义检索: 无索引缓存（未建索引，跳过 → 可用 librarian.js CLI 建）')
    } else {
      let qr = null
      try {
        // 一次 embed，三个解读器（检索/FOK/新颖性）共用同一份结果
        qr = await librarianQuery(idx, cur.text, { topK: 5 })
      } catch (e) { out.meta.skipped.push(`检索: ${e.message}`) }

      if (qr) {
        safe('知晓感', () => renderFok(fokAssess(qr)), 'embed')
        safe('新颖性', () => renderNoveltyHint(noveltyAssess(qr, cur.text, loadTermWords(root))), 'embed')
        safe('回忆指针', () => renderLibrarian(qr), 'embed')
      }
    }
  } else if (!O.useRetrieval) {
    out.meta.skipped.push('语义检索: 已被 ALERT_NO_RETRIEVAL=1 关闭')
  }

  // ⑧ 学习循环（**默认关**：有副作用）
  if (O.useLearning && acts.length && sessionFile) {
    try {
      const r = runLearning(acts, sessionFile, { dryRun: opts.learningDryRun !== false })
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
