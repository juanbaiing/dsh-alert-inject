/**
 * training.js — 训练就绪度评估：**「现在够不够训、缺什么、下一步做什么」**
 *
 * ══ 为什么需要它（作者 2026-10-15 要求）═══════════════════════════
 *   「判断并确定样本量是否足够并确认是否训练」
 *   ⇒ 不能靠感觉说"攒得差不多了" —— 那是本项目反复栽过的坑
 *     （教训 §238：样本库半年只有 53 条却没人发现）。
 *   ⇒ 这里把"够不够"变成**可读、可核、可复算**的判据。
 *
 * ══ 门槛的出处 ═══════════════════════════════════════════════════
 *   **SetFit 公开门槛「每类 8 条」**（8 条/类 ≈ 3000 条全量微调的效果）。
 *   官方原话："with only 8 labeled examples per class … competitive with
 *   fine-tuning RoBERTa Large on the full training set of 3k examples"
 *   ⇒ 本模块一律用 `8 × 类别数` 作门槛。**它不是我的估计，是有出处的。**
 *
 * ══ ⚠️ 三条必须说清的形态问题（光看数量会判断错）══════════════════
 *   ① `user_correction` 的 label 是**自由文本**（作者的纠正原话），**不是类别**
 *      ⇒ 它**不能**直接训分类器；正确用法是把它当**正例**（"这段与设定冲突"），
 *        负例另找。**只数"有多少条"会得出错误的结论。**
 *   ② `doc_route_weak` 的目标**不能是 72 选 1** ——
 *      Laya 的 choice 候选共享 256-token 头预算，官方建议 **< 20 个选项**
 *      （实测：超限则 accuracy falls sharply）。
 *      ⇒ 正确形态是 **noul × 每档一个二元判断**（每档的候选只有 2 个）。
 *   ③ `unit_classify` 的 label **恒为 null** ⇒ 在标完之前，**样本数再多也没用**。
 */

import { stats, buildDataset } from './samples.js'
import { verifyTask } from './verify-samples.js'

/** 每类需要的样本数 —— SetFit 公开门槛，**有出处，不要凭感觉改** */
export const PER_CLASS = 8

/** 各任务的目标形态。`classes` = 该形态的类别数，决定门槛 = PER_CLASS × classes */
export const TASK_SPEC = {
  user_correction: {
    shape: 'noul（二元）',
    question: '这段内容与已有设定冲突吗？',
    classes: 2,
    // ⚠️ 正例 = 作者纠正所对应的 AI 发言；**负例必须另行提供**（本表只统计正例）
    positiveOnly: true,
    // ⚠️ 2026-10-16 更正：本行原写「负例可由档文片段自动生成……不必人工」——**该说法已被实测否掉**。
    //    · A 组（档文 → 让模型按 AI 口吻改写）：**实测失败**。小模型只会照抄，
    //      或只删掉 `【】`／`**`，**没起到"换文体"的作用** ⇒ 得到的负例与档文原文无异
    //      ⇒ 又掉回"文体混用"的坑（模型会去学**文体**，不是学**冲突**）。详见 `tools/gen-negatives.mjs` 头部。
    //    · B 组（**真实会话**里"在谈设定、且没被作者纠正过的 AI 发言"）：**同文体、零幻觉**，是现在的路。
    //      但"作者没纠正"只是**弱证据**（也可能是他当时没看到）⇒ **必须人工判一眼**。
    //      详见 `tools/negatives-from-session.mjs`。
    note: '正例来自作者纠正。负例**不能**由档文自动生成（实测失败，见 tools/gen-negatives.mjs 头部）；走 B 组：真实会话里"没被纠正的 AI 发言"，**需人工判一眼**。',
  },
  doc_route_weak: {
    shape: 'noul × 每档二元',
    question: '这段内容涉及「某档」吗？',
    classes: 2,          // **每档**都是一个独立的二元问题
    perDoc: true,        // 门槛要按"每一档"算，不是整体算
    docs: 72,
    note: '⚠️ 不做 72 选 1（Laya 候选上限 <20，实测）。每档独立二元；负例 = 其它档的文本。',
  },
  unit_classify: {
    shape: 'choice（多类）',
    question: '这条结论是「知识」还是「操作」？',
    classes: 3,
    note: '⚠️ label 恒为 null ⇒ 标完之前样本数再多也不能训。',
  },
}

/**
 * 评估训练就绪度。
 * @returns {{tasks:Array, verdict:string, nextAction:string}}
 */
export function assessTraining({ file, projectRoot } = {}) {
  const st = stats({ file })
  const tasks = []

  for (const [task, d] of Object.entries(st.dataset)) {
    const spec = TASK_SPEC[task] || { shape: '未登记', classes: null, note: '（未在 TASK_SPEC 里登记形态）' }
    const labeled = d.labeled
    const total = d.total

    if (spec.perDoc) {
      // 按"每一档"分别统计（这些样本的标签在 prediction 里，不在 label 里）
      const ds = buildDataset(task, { file })
      const byDoc = new Map()
      for (const x of ds) {
        const key = x.prediction ?? x.label
        if (key) byDoc.set(key, (byDoc.get(key) || 0) + 1)
      }
      const rows = []
      for (const [k, v] of byDoc) rows.push({ doc: k, n: v })
      rows.sort((a, b) => b.n - a.n)
      const need = PER_CLASS * 2                          // 每档：8 正 + 8 负
      const ready = rows.filter((r) => r.n >= PER_CLASS).length

      // ★ 用知识库交叉验证（作者 2026-10-15 要求）——只有能载入知识图时才做
      let verified = null
      if (projectRoot) {
        try { verified = verifyTask(task, { projectRoot, file })?.summary } catch { /* 无图/出错就不做 */ }
      }

      tasks.push({
        task, spec, total, labeled, need,
        docsCovered: rows.length, docsTotal: spec.docs,
        docsReady: ready,
        top: rows.slice(0, 8),
        verified,
        verdict: ready ? `${ready} 档的正例已够 ${PER_CLASS} 条，可做最小验证` : '远不够：先挑 1~2 档做最小验证',
      })
      continue
    }

    const need = PER_CLASS * (spec.classes || 2)
    let verdict
    if (!spec.classes) verdict = '形态未登记，无法判断'
    else if (labeled >= need && !spec.positiveOnly) verdict = `✅ 可训（${labeled} ≥ ${need}）`
    else if (spec.positiveOnly && labeled >= PER_CLASS) verdict = `⚠️ 正例已够一类（${labeled} ≥ ${PER_CLASS}），但**负例尚未生成** ⇒ 补齐即可训`
    else verdict = `还差 ${need - labeled} 条`
    tasks.push({ task, spec, total, labeled, need, verdict })
  }

  // ── 总判决 ──
  const canTrainNow = tasks.filter((t) => /✅ 可训/.test(t.verdict))
  let verdict, nextAction
  if (canTrainNow.length) {
    verdict = `现在能训：${canTrainNow.map((t) => t.task).join('、')}`
    nextAction = '可以直接开始训练'
  } else {
    const closest = tasks
      .filter((t) => t.spec.positiveOnly)
      .sort((a, b) => (b.labeled / b.need) - (a.labeled / a.need))[0]
    if (closest) {
      verdict = '现在还不能训：没有哪个任务达到门槛。'
      nextAction =
        `最快的一条路是「${closest.task}」——正例已有 ${closest.labeled} 条（一类只用 ${PER_CLASS} 条），**只缺负例**。\n`
        + `    ⚠️ 负例**不能**由档文自动生成（A 组实测失败，见 tools/gen-negatives.mjs 头部）。\n`
        + `    下一步：跑  node tools/negatives-from-session.mjs --project <项目根> --n 6  —— 它**只预览、不写库**，\n`
        + `    你把列出来的候选判一眼（"作者没纠正过"只是**弱证据**），过了再走 samples.js 的标准路径入库。`
    } else {
      verdict = '现在还不能训：没有哪个任务达到门槛。'
      nextAction = '先补齐标注，或换用更易获得负例的任务形态。'
    }
  }
  return { tasks, verdict, nextAction, unusableCorr: st.unusableCorr, events: st.events }
}

/** 渲染成人可读的文本（CLI / 诊断用） */
export function renderPlan(a) {
  const L = []
  L.push('══ 训练就绪度 ══')
  L.push(`样本事件总数：${a.events}`)
  if (a.unusableCorr) L.push(`⚠️ 其中 ${a.unusableCorr} 条纠正样本缺输入（无 wrong），已剔除、不参与统计`)
  L.push('')
  for (const t of a.tasks) {
    L.push(`── ${t.task}`)
    L.push(`   目标形态：${t.spec.shape}`)
    if (t.spec.question) L.push(`   要回答  ：${t.spec.question}`)
    if (t.spec.perDoc) {
      L.push(`   样本总数：${t.total}（其中已人工确认 ${t.labeled}）`)
      L.push(`   覆盖档数：${t.docsCovered} / ${t.docsTotal}`)
      L.push(`   正例足够的档：${t.docsReady}（门槛：每档 ${PER_CLASS} 条正例）`)
      if (t.verified) {
        const v = t.verified
        L.push(`   ★ 知识库筛选：✅支持 ${v['支持'] || 0}　🟡弱支持 ${v['弱支持'] || 0}　🔴存疑 ${v['存疑'] || 0}　⬜无法判定 ${v['无法判定'] || 0}`)
        L.push(`      （「无法判定」≠ 无效 —— 知识表的覆盖有缺口，口语文本本来就常命中不到）`)
      }
      L.push(`   样本最多的档：`)
      for (const r of t.top) L.push(`      ${String(r.n).padStart(3)} 条  ${r.doc}`)
    } else {
      L.push(`   样本总数：${t.total}　已可用：${t.labeled}　门槛：${t.need}（${PER_CLASS} × ${t.spec.classes} 类）`)
    }
    if (t.spec.note) L.push(`   注意    ：${t.spec.note}`)
    L.push(`   判定    : ${t.verdict}`)
    L.push('')
  }
  L.push('══ 结论 ══')
  L.push(a.verdict)
  L.push(`下一步：${a.nextAction}`)
  return L.join('\n')
}
