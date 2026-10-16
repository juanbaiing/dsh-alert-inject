/**
 * bootstrap.js — **首次运行引导**：把本机上已有的历史会话一次性利用起来
 *
 * ══ 为什么要有它（作者 2026-10-15 要求）═══════════════════════════
 *   「首次装时自动补充一次数据，然后判断并确定样本量是否足够并确认是否训练」
 *   ⇒ 没有它，新装的插件**从零开始攒样本**，前面所有历史都白放着。
 *     而历史里其实已经有几百上千条作者发言 —— 这是最便宜的一批原料。
 *
 * ══ ⚠️⚠️ 与「注意病毒」的边界（这条是设计约束，不是建议）════════════
 *   作者同时提醒「**注意病毒**」= 错样本 → 训出差模型 → 差模型产生错判断 → 又变新样本。
 *   ⇒ 本模块**只做"补数据"，绝不做"训练"**：
 *     · 写入的每一条都带 `labelSource` / `confidence` / `session+pos`（可筛、可回溯）
 *     · **不同任务物理隔离**（独立 `task` 名）⇒ 不会自动混训
 *     · **训练与否由 `training.js` 评估后交人确认**，本模块不碰
 *   ⇒ 一句话：**数据可以自动补，训练必须经审。**
 *
 * ══ 三条工程约束 ═════════════════════════════════════════════════
 *   ① **只跑一次** —— 完成后写标记文件；**失败也写**（且记原因），
 *      否则会每次调用都重试一遍几十秒的活。
 *   ② **有预算** —— 历史可能有几百 MB；限制会话数与字节数，超了就只取最近的。
 *   ③ **绝不影响主流程** —— 整段包在 try/catch 里，任何失败都只记不抛
 *      （工具绝不能让回答失败；但**必须留痕**，见教训 §239）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverProjects, harvestSession } from './harvest.js'

export const BOOTSTRAP_MARK = path.join(os.homedir(), '.dsh', '.alert-inject-bootstrapped.json')

/** 读引导状态（不存在 = 从未引导过） */
export function bootstrapState() {
  try { return JSON.parse(fs.readFileSync(BOOTSTRAP_MARK, 'utf8')) } catch { return null }
}

export function needsBootstrap() {
  return bootstrapState() === null
}

function writeMark(obj) {
  try {
    fs.mkdirSync(path.dirname(BOOTSTRAP_MARK), { recursive: true })
    fs.writeFileSync(BOOTSTRAP_MARK, JSON.stringify({ at: new Date().toISOString(), ...obj }, null, 2), 'utf8')
    return true
  } catch (e) {
    // ⚠️ §239：标记写不成 ⇒ **下次又会跑一遍「首次引导」**（扫全量会话、实测几十秒），
    //    而使用者完全不知道（2026-10-16 修，见 TODO §17）。
    console.warn('[alert-inject/bootstrap] ⚠️ 引导标记写入失败（下次会重复引导一次）：', e?.message || e)
    return false
  }
}

/**
 * 跑一次引导。
 *
 * @param dryRun      true ⇒ 只统计不写（默认 false，因为作者要的是"自动补"）
 * @param maxSessions 最多处理多少个会话（按最近优先）
 * @param maxBytes    最多解压多少字节的历史（默认 120MB，防卡死）
 * @returns 摘要对象（**永远返回，不抛**）
 */
export async function runBootstrap({ dryRun = false, maxSessions = 60, maxBytes = 120 * 1024 * 1024 } = {}) {
  const t0 = Date.now()
  const out = { projects: [], weak: 0, weakDup: 0, corrections: 0, corrDup: 0, sessions: 0, bytes: 0, errors: [], dryRun }

  try {
    // ① 发现所有有历史会话的项目（不需要事先知道有哪些项目）
    const projects = discoverProjects()
    out.projectCount = projects.length

    // ② 按"最近优先 + 字节预算"挑会话
    const picked = []
    let bytes = 0
    const mod = await import('./harvest.js')
    for (const p of projects) {
      let dirs = []
      try { dirs = mod.findSessionDirs(p.cwd) } catch { continue }
      const keep = []
      for (const d of dirs) {
        if (picked.length >= maxSessions || bytes + d.size > maxBytes) break
        bytes += d.size
        keep.push(d)
        picked.push({ ...d, project: p.cwd })
      }
      if (keep.length) out.projects.push({ cwd: p.cwd, sessions: keep.length, bytes: keep.reduce((a, x) => a + x.size, 0) })
      if (picked.length >= maxSessions || bytes > maxBytes) break
    }
    out.sessions = picked.length
    out.bytes = bytes

    // ③ 弱标注（作者发言 ↔ 同轮读过的档）
    const samplesMod = dryRun ? null : await import('./samples.js')
    for (const s of picked) {
      let r
      try { r = harvestSession(s.file, { maxPerTurn: 3 }) } catch (e) { out.errors.push(`weak:${e.message}`); continue }
      for (const x of r.samples) {
        out.weak++
        if (!samplesMod) continue
        const ok = samplesMod.recordPrediction({
          task: x.task, input: x.input, prediction: x.label, confidence: x.confidence,
          by: 'weak_session', ref: x.ref, extra: { labelSource: x.labelSource, docCount: x.ref.docCount },
        })
        if (!ok) out.weakDup++
      }
    }

    // ④ 作者纠正（自带标签，质量最高）—— 历史会话里也有，一并收
    if (!dryRun) {
      try {
        const { recentActivity } = await import('./index.js')
        const { harvestUserCorrections } = await import('./learning.js')
        for (const s of picked) {
          try {
            const acts = recentActivity(s.file, 0)          // 0 = 全量
            if (!acts?.length) continue
            // ★ 语境块号（2026-10-16 修）：样本必须能按语境分开，否则不同语境的"纠正"
            //   混成一类是**废样本**（作者亲自指出的 bug，详见 `lib/context.js` 的说明）。
            const { splitBlocks, indexBlockMap } = await import('./blocks.js')
            const blocks = splitBlocks(acts)
            const before = samplesMod.stats().dataset?.user_correction?.labeled ?? 0
            harvestUserCorrections(acts, s.file, { blockOf: indexBlockMap(blocks), blockCount: blocks.length })
            const after = samplesMod.stats().dataset?.user_correction?.labeled ?? 0
            out.corrections += Math.max(0, after - before)
            out.corrDup += Math.max(0, 0)
          } catch (e) { out.errors.push(`corr:${e.message}`) }
        }
      } catch (e) { out.errors.push(`corr-import:${e.message}`) }
    }

    out.ms = Date.now() - t0
    if (!dryRun) {
      const st = samplesMod.stats()
      out.after = st.dataset
      out.events = st.events
      writeMark({ ok: true, ...out })
    }
    return out
  } catch (e) {
    out.errors.push(String(e?.message || e))
    out.ms = Date.now() - t0
    // ⚠️ 失败也写标记 —— 否则每次调用都会重试这个几十秒的活
    if (!dryRun) writeMark({ ok: false, reason: String(e?.message || e), ...out })
    return out
  }
}

/** 渲染引导结果（人可读） */
export function renderBootstrap(r) {
  const L = []
  L.push('🌱 首次引导' + (r.dryRun ? '（预览，未写入）' : ''))
  if (!r.sessions) {
    L.push('本机没有可用的历史会话 ⇒ 从零开始攒。')
    L.push('（这是正常的：引导靠的是**已有会话**，新机器上第一次自然没有。）')
    return L.join('\n')
  }
  L.push(`扫描到项目 ${r.projectCount} 个，本次处理会话 ${r.sessions} 个（${(r.bytes / 1048576).toFixed(1)} MB）`)
  L.push(`补入弱标注 ${r.weak - r.weakDup} 条${r.weakDup ? `（跳过重复 ${r.weakDup} 条）` : ''}`)
  if (r.corrections) L.push(`补入作者纠正 ${r.corrections} 条（自带标签，质量最高）`)
  if (r.after) L.push(`样本库现在：${JSON.stringify(r.after)}`)
  if (r.errors?.length) L.push(`⚠️ 有 ${r.errors.length} 处小错误（未影响主流程）：${r.errors.slice(0, 2).join('；')}`)
  L.push(`耗时 ${(r.ms / 1000).toFixed(1)} s`)
  L.push('')
  L.push('下一步：跑 `lib/training.js` 的就绪度评估，看够不够训（**训练需你确认**）。')
  return L.join('\n')
}
