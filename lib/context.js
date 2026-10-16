/**
 * context.js — **上下文整理**：把会话从「原始」压成「整齐」，供各消费者按需取用
 *
 * ══ 它解决什么（作者 2026-10-15 定）══════════════════════════════════
 *   作者原话：
 *     > 「这就是**数据的简化流程**，**数据量变小或损失**，但**整齐度上升**，
 *     >   **按需选择数据层查询**」
 *
 *   此前每次 `alert_check` 都要：解压整个会话（实测 **2354 ms** / 3134 条）→ 现场筛 → 用完就扔。
 *   而 `harvest`（样本采集）**又把同一批会话重新解压了一遍**（115 个会话 / 48 秒）。
 *   ⇒ **同一件重活，各干各的，谁也不复用。**
 *
 * ══ 分层（作者要的"按需选择数据层"）══════════════════════════════════
 *     L0  会话 JSONL            ← **真源**，不删、不改；任何一条都能回这里核对
 *      ↓  整理（**有损**：截断超长、剥注入物、去重；**但每条留 srcPos**）
 *     L1  结构化上下文（本模块）  ← 整齐、小、带语境块号；日常查询走这里
 *      ↓  投影
 *     L2  样本 / 检索索引 / 告警材料
 *
 * ══ 三条纪律（违反任何一条都会退化成"看起来没问题"）══════════════════
 *   ① **有损但必须可回溯**：每条带 `srcPos`（L0 行号）+ `srcLen`（原文长度）。
 *      被截断的能看出来，要原文随时回 L0 取。
 *   ② **绝不静默降级**：L1 缺失/损坏 ⇒ 回退 L0，**并在返回值里记录回退原因**。
 *   ③ **增量**：会话是追加式的 ⇒ 只整理**新增的字节**，用 `srcBytes` 记水位线。
 *      不做增量的话，整理本身就会变成新的瓶颈（那就是把问题搬了个家）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { frameStarts, stripInjections, NON_HUMAN, textOf } from './harvest.js'
import { splitBlocks, indexBlockMap } from './blocks.js'

export const CONTEXT_DIR = process.env.DSH_CONTEXT_DIR
  || path.join(os.homedir(), '.dsh', 'memory', 'contexts')

/**
 * 一条痕迹最多留多少字。
 *
 * ⚠️ 上限从 1200 提到 **4000**（作者 2026-10-15 定「可以延长」）。
 *   原值 1200 的实测后果：**1689 条里 583 条被截断**（超三分之一）。
 *   而 L2 总共才 2.33 MB —— **拿"省空间"去换"丢信息"是划不来的**：
 *   被截的是正文/思考的长内容，那里面往往正是设定讨论的细节。
 *   ⇒ 仍然保留截断（防极端长文），但**放宽到几乎不会碰到**；`srcLen` 照旧记录原长。
 */
const MAX_TEXT = +(process.env.DSH_CTX_MAX_TEXT || 4000)
/** 工具的详细内容通常用不上，只留工具名 —— 这是主要的"有损"处 */
const KEEP_TOOL_TEXT = process.env.DSH_CTX_KEEP_TOOL === '1'

/**
 * 平台自己产生的提示（**不是作者说的**）—— 作者 2026-10-15 要求滤掉。
 *
 * ⚠️ 判据必须用**精确句式**，绝不能用"英文占比高"这种粗判据 ——
 *   实测：英文占比 >0.7 的【用户】条目有 4 条，**其中 3 条是作者真人发言**
 *   （`dsh-ops-file是干什么的`、含 `D:\...\venv-laya\ 817 MB` 的安装说明、
 *   `这是界面Token Saver v2`）—— 粗判据会**误杀**。
 *   ⇒ 宁可漏（留一条噪音），不可错（删掉一句真话）。§242 的教训。
 */
const PLATFORM_MSG = [
  /^The approval policy changed from /i,
  /^Approval (policy|mode) (changed|set)/i,
  /^\[?(System|Platform) (notice|message)\]/i,
]

export function contextFile(sessionFile) {
  const id = path.basename(path.dirname(sessionFile))
  return path.join(CONTEXT_DIR, `${id}.jsonl`)
}

function readMeta(file) {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0]
    const o = JSON.parse(first)
    return o?.type === 'ctx-meta' ? o : null
  } catch { return null }
}

/**
 * 把一段痕迹转成 L1 记录。
 *
 * ══ ⚠️ 块号就在这里算出来，而**样本采集此前绕过了这里**（2026-10-16 · 作者指出的 bug）══
 *   作者原话：「**是的，分语境是我一直强调的**」，以及更早的一条：
 *     > 「我要做**基于上下文的知识分块参考召回**，你好像忘了，这个是解决**不同语境下的误报**，
 *     >  即，**这个语境对，但另外一个语境没必要报**的情况」
 *
 *   而 `harvestUserCorrections()` 收到的 `acts` 来自 `recentActivity(sessionFile, 0)` —— **直读 L0**，
 *   于是这里算好的 `block` **在源头就丢了**，而且**是静默丢的**
 *   （样本的**条数**是对的，**看不出少了什么** —— 丢的不是数据，是**一个维度**）。
 *   ⇒ 后果：**不同语境的"纠正"被混成一类**（绘画的、写代码的、世界模拟的、MC 的……），
 *     那不再是有意义的标签 —— 模型只能学到"这个人换话题时会说什么"，学不到"什么不对劲"。
 *
 *   ⇒ 修法：调用点自己用 `splitBlocks` + `indexBlockMap` 算块号，交给
 *     `harvestUserCorrections(acts, file, { blockOf, blockCount })`（见 `report.js` / `bootstrap.js`）。
 *
 * ⚠️ 本函数里 `blockOf.get(i) ?? -1` 用的是 **-1 哨兵** —— 那是 **L1 的内部约定**，保持原样。
 *    但**样本库里不能用 -1**：样本要给人看、给模型用，一旦把"未知"写成数字就再也分不开
 *    （`learning.js` 的 `extractCorrections` 因此填 `null`）。硬规则 3：判据必须能表达「我不知道」。
 *
 * ⚠️ 块号用现成的 `indexBlockMap(blocks)` —— 这里原本是一段**重复实现**的 for 循环（2026-10-16 消除）。
 *
 * @returns {Array} 记录数组（**未写盘**）
 */
export function toRecords(acts, { startLine = 1, stats = null } = {}) {
  const blocks = splitBlocks(acts)
  const blockOf = indexBlockMap(blocks)

  const out = []
  const seen = new Set()
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]
    let text = String(a.text || '')
    const srcLen = text.length
    const clean = []

    // ★ 平台提示：精确句式匹配，**且计数**（不能静默丢）
    if (PLATFORM_MSG.some((re) => re.test(text.trim()))) {
      if (stats) stats.platform = (stats.platform || 0) + 1
      continue
    }

    if (a.kind === '工具' && !KEEP_TOOL_TEXT) {
      // 工具只留名字（这是最主要的"有损"）
      const m = /^\[工具调用\]\s*(\S+)/.exec(text)
      text = m ? `[工具] ${m[1]}` : '[工具]'
      clean.push('工具内容省略（只留名字）')
    } else {
      const stripped = stripInjections(text)
      if (stripped !== text) { clean.push('剥平台注入物'); text = stripped }
    }
    // ⚠️ 剥掉平台注入物后变空 —— **必须计数，不能静默丢**（教训 §245）
    //   2026-10-16 补：此前这个分支**没有任何计数**（四个出口只有三个计数），
    //   于是对账时那 189 条找不到归属。凡有"丢弃计数"，就必须能写出 `进 = 出 + 丢`。
    if (!text) { if (stats) stats.emptyAfterStrip = (stats.emptyAfterStrip || 0) + 1; continue }
    if (NON_HUMAN.test(text.trim())) {
      if (stats) stats.nonHuman = (stats.nonHuman || 0) + 1
      clean.push('系统通知，丢弃')
      continue
    }
    if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); clean.push(`截断至 ${MAX_TEXT} 字`); if (stats) stats.truncated = (stats.truncated || 0) + 1 }

    const h = createHash('sha1').update(text).digest('hex').slice(0, 12)
    if (seen.has(h)) { if (stats) stats.dedup = (stats.dedup || 0) + 1; continue }   // 完全重复只留一条
    seen.add(h)

    out.push({
      srcPos: startLine + i,                 // ★ L0 行号 —— 可回溯
      block: blockOf.get(i) ?? -1,
      kind: a.kind,
      text,
      h,
      srcLen,                                // ★ 原文长度 —— 可看出是否被截
      ...(clean.length ? { clean } : {}),
    })
  }
  return out
}

/**
 * **按语境块分组**（作者 2026-10-15 定：第 2 层按语境块分）。
 *
 * ⚠️ 为什么分组而不是线性流水：
 *   作者原话：「按**语境块**分」。语境块 = 他的一次发言 + 之后的 AI 活动，
 *   也就是「**这一段在谈什么**」的自然单位。线性流水读起来是无边界的，
 *   分组之后每一块是**可单独取用**的一片 —— 这正是"按需选择数据层查询"的前提。
 *
 * ⚠️ 每条仍保留 `srcPos` ⇒ **分组不损失可回溯性**。
 */
export function groupByBlock(records) {
  const m = new Map()
  for (const r of records) {
    const k = r.block ?? -1
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  const groups = []
  for (const k of [...m.keys()].sort((a, b) => a - b)) {
    const items = m.get(k)
    // 块头 = 该块第一条**用户发言**（没有就取第一条）—— 让每块"一眼知道在谈什么"
    const head = (items.find((x) => x.kind === '用户') || items[0])
    groups.push({
      block: k,
      head: String(head?.text || '').replace(/\s+/g, ' ').slice(0, 80),
      n: items.length,
      kinds: items.reduce((acc, x) => { acc[x.kind] = (acc[x.kind] || 0) + 1; return acc }, {}),
      items,
    })
  }
  return groups
}

/**
 * 整理一个会话（**增量**）。
 *
 * @returns {{ok:boolean, file:string, added:number, total:number, reused:boolean, reason?:string}}
 */
export function normalizeSession(sessionFile) {
  const out = { ok: false, file: contextFile(sessionFile), added: 0, total: 0, reused: false }
  try {
    const st = fs.statSync(sessionFile)
    const prev = readMeta(out.file)
    // 增量水位线：源文件没长 ⇒ 直接复用
    if (prev && prev.srcBytes === st.size) {
      // ⚠️ 复用分支**也要把 blocks 带出来**（2026-10-16 修）：
      //   原先只返回 total ⇒ 调用方打印成「1689 条 / **undefined 块**」——
      //   那是"我手上没这个数"被显示成"它是 undefined"，属"输出与真相不符"。
      return { ...out, ok: true, reused: true, total: prev.records ?? 0, blocks: prev.blocks ?? 0, acts: prev.acts }
    }

    const buf = fs.readFileSync(sessionFile)
    const starts = frameStarts(buf)
    // ⚠️ 目前整解（帧级增量留待下一步：需要按字节偏移对齐帧头）。
    //    先把"结构"跑通并量化收益，再决定要不要做帧级增量 —— 避免一次性上太多。
    const chunks = []
    for (let k = 0; k < starts.length - 1; k++) {
      try { chunks.push(zstdDecompressSync(buf.subarray(starts[k], starts[k + 1]))) } catch { /* 跳坏帧 */ }
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const lines = raw.split('\n')

    // 解析成 acts（与 alert_check 同构，但**只保留上下文**）
    const acts = []
    for (const line of lines) {
      if (!line || line[0] !== '{') continue
      let o; try { o = JSON.parse(line) } catch { continue }
      if (o.type === 'user/message') {
        const t = textOf(o.data?.content)
        if (t) acts.push({ kind: '用户', text: t })
      } else if (o.type === 'assistant/chunk') {
        const b = o.data?.chunk?.block
        if (!b) continue
        if (b.type === 'reasoning') acts.push({ kind: '思考', text: String(b.text || '') })
        else if (b.type === 'text') acts.push({ kind: '正文', text: String(b.text || '') })
        else if (b.type === 'tool-call') acts.push({ kind: '工具', text: `[工具调用] ${b.name || '?'}` })
      }
    }

    const stats = {}
    const records = toRecords(acts, { stats })
    const groups = groupByBlock(records)
    fs.mkdirSync(CONTEXT_DIR, { recursive: true })
    const meta = {
      type: 'ctx-meta', src: sessionFile, srcBytes: st.size,
      records: records.length, blocks: groups.length, acts: acts.length,
      at: new Date().toISOString(),
      // ★ 损失必须可见（作者要的"数据量变小或损失"——变小可以，失真不行）
      lossy: { maxText: MAX_TEXT, toolText: KEEP_TOOL_TEXT },
      dropped: stats,          // 平台提示 / 系统通知 / 截断 / 去重 各几条
    }
    // ★ 按语境块分组写（一块一行，块内是 items）
    const body = groups.map((g) => JSON.stringify(g)).join('\n')
    fs.writeFileSync(out.file, JSON.stringify(meta) + '\n' + body + '\n', 'utf8')

    return { ...out, ok: true, added: records.length, total: records.length, acts: acts.length, blocks: groups.length, srcBytes: st.size, dropped: stats }
  } catch (e) {
    out.reason = String(e?.message || e)
    return out
  }
}

/**
 * 读 L2；**缺失或损坏时说明原因**（纪律②：不静默降级）。
 * @returns {{groups:Array, records:Array, meta:object|null, fromL2:boolean, note:string}}
 */
export function loadContext(sessionFile) {
  const f = contextFile(sessionFile)
  try {
    const meta = readMeta(f)
    if (!meta) return { groups: [], records: [], meta: null, fromL2: false, note: 'L2 不存在（还没整理过）' }
    const st = fs.statSync(sessionFile)
    if (meta.srcBytes !== st.size) {
      return { groups: [], records: [], meta, fromL2: false, note: `L2 已过期（源从 ${meta.srcBytes} 字节长到 ${st.size}）⇒ 需重新整理` }
    }
    const groups = fs.readFileSync(f, 'utf8').split('\n').slice(1).filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const records = groups.flatMap((g) => g.items || [])
    return { groups, records, meta, fromL2: true, note: `来自 L2（${groups.length} 块 / ${records.length} 条）` }
  } catch (e) {
    return { groups: [], records: [], meta: null, fromL2: false, note: `L2 读取失败：${e.message}` }
  }
}

/** 整理状态（供体检报告用 —— **每一项都要能被核对**） */
export function contextStatus() {
  try {
    const files = fs.readdirSync(CONTEXT_DIR).filter((x) => x.endsWith('.jsonl'))
    let bytes = 0, records = 0
    for (const f of files) {
      const p = path.join(CONTEXT_DIR, f)
      const st = fs.statSync(p)
      bytes += st.size
      const m = readMeta(p)
      records += m?.records ?? 0
    }
    return { dir: CONTEXT_DIR, files: files.length, bytes, records }
  } catch { return { dir: CONTEXT_DIR, files: 0, bytes: 0, records: 0 } }
}
