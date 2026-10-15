/**
 * leak-check.mjs — 触发词泄漏检查（**不打印词表**）
 *
 * 背景：本插件的铁律之一是【输出不许回显判据触发词】——报了就等于把样本注回上下文，
 *   而判据下一轮会重新匹配它们（自我喂食，见 REPORT.md §二·v4）。
 *
 * 实测踩过的坑：v4 输出模板初版写了"较早位置的可疑痕迹"，而"可疑"正是判据表里的
 *   一个信号词 ⇒ 自己泄漏自己。**靠眼睛看是发现不了的**（因为写模板的人不知道全部词）。
 * ⇒ 故本脚本：把【所有对外输出】的文本喂进来，逐个比对判据词，
 *   只报「命中第几个判据的第几个词 + 上下文片段」，**绝不打印词表本身**。
 *
 * 用法：node leak-check.mjs [sessionFile]
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

/**
 * ⚠️ 路径解析（2026-10-15 发布前修正）：原先**硬编码**指向开发者机器上的 `node_modules`，
 *   导致**别人 clone 之后根本跑不了**。
 *   ⇒ 改为**相对于本文件**解析 + 环境变量覆盖。
 */
const lib = process.env.ALERT_LIB
  ? new URL(process.env.ALERT_LIB, import.meta.url).href
  : new URL('./lib/', import.meta.url).href
const alert = await import(lib + 'index.js')
const librarian = await import(lib + 'librarian.js')

/**
 * ⚠️ 配置化（2026-10-15）后，`loadJudges()` / `loadTermWords()` **需要项目根** ——
 *   否则找不到判据表，会静默返回 0 条判据，**导致泄漏检查形同虚设**（比对 0 条 = 永远通过）。
 *   这正是本脚本首轮跑出的现象，故此处的 projectRoot 必须显式给出。
 *   取值顺序：命令行参数 → 环境变量 → 配置文件 → 常见默认。
 */
const PROJECT_FOR_CHECK = process.argv[2]
  || process.env.DSH_ALERT_PROJECT
  || process.env.ALERT_PROJECT
  || (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'alert-inject.json'), 'utf8')).projectRoot } catch { return null } })()
  || process.cwd()

if (!alert.loadJudges(PROJECT_FOR_CHECK).judges.length) {
  console.log(`⚠️ 在「${PROJECT_FOR_CHECK}」下没找到判据表 ⇒ 本次检查无判据可比对（结果不可信）。`)
  console.log('   请把项目根作为第一个参数传入：node leak-check.mjs <projectRoot>')
  process.exit(2)
}

/** 收集所有会送到模型眼前的文本 */
async function collectTexts() {
  const texts = []
  const { judges } = alert.loadJudges()

  // ① alert_check 工具描述与前置指令
  // ⚠️⚠️ 覆盖漏洞（2026-10-15 发现）：初版用正则从源码里"猜"这两段文本，
  //   而前置指令是【多个字符串拼接】的，正则只抓到第一行 ⇒ **漏掉了「返回可疑项」这句泄漏**。
  //   ⇒ 改成**直接调用 apply() 并 mock ctx，抓真实文本** —— 单一真相源，不会再与实际脱节。
  let ruleText = '', toolDesc = ''
  const fakeCtx = {
    tools: { register: (def) => { toolDesc = def?.description || def?.spec?.description || def?.tool?.description || '' } },
    systemPrompt: {
      variable: (n, fn) => { try { ruleText = fn({ agent: { session: { header: { cwd: 'D:\\dswork' } } } }) || '' } catch { /* ignore */ } },
      section: () => {},
    },
  }
  try { await alert.apply(fakeCtx) } catch { /* 注册失败不影响后续检查 */ }
  if (toolDesc) texts.push({ where: 'alert_check 工具描述（apply 实抓）', text: toolDesc })
  if (ruleText) texts.push({ where: '前置指令（apply 实抓）', text: ruleText })

  // 回退：若 apply 没抓到（DSH 运行时不可用），再用源码正则兜底
  if (!ruleText || !toolDesc) {
    // ⚠️ 同样改为相对路径（原为硬编码的开发者机器路径 ⇒ 别人跑不了）
    const src = fs.readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
    if (!toolDesc) {
      const m = src.match(/description:\s*\n?\s*((?:'[^']*'|\s|\+)+)/s)
      if (m) texts.push({ where: 'alert_check 工具描述（源码兜底）', text: m[1].replace(/['+\s]/g, '') })
    }
    if (!ruleText) {
      const m = src.match(/return \(\s*\n((?:\s*'[^']*'\s*\+?\s*\n?)+)/)
      if (m) texts.push({ where: '前置指令（源码兜底）', text: m[1].replace(/['+\s]/g, '') })
    }
  }

  // ② alert_check 的【工具输出】—— ⚠️ 曾漏检这一处，导致"可疑"长期泄漏。
  //    现在渲染逻辑抽成了 renderAlertTool()，这里直接调用，保证不会与实现脱节。
  for (const v of [{ clean: true }, { clean: false, items: ['我的老毛病 · 检出 12 处'] }]) {
    const r = alert.renderAlertTool(v)
    const txt = r.map((x) => x.text).join('\n')
    if (txt) texts.push({ where: `alert_check 输出(${v.clean ? '无异常' : '有条目'})`, text: txt })
  }

  // ③ alertText 的真实输出（用真实会话跑）
  const f = process.argv[2] || defaultSession()
  if (f && fs.existsSync(f)) {
    const out = alert.alertText('D:\\dswork', f)
    if (out) texts.push({ where: 'alertText 输出', text: out })
  }

  // ④ renderPointer / librarian.render / repetition.render
  const rp = alert.renderPointer([{ pos: 266, kind: '思考', sim: 0.83 }])
  if (rp) texts.push({ where: 'renderPointer 输出', text: rp })

  for (const sim of [0.95, 0.80, 0.65]) {
    const r = librarian.render({ top: [{ pos: 5, kind: '思考', sim }], excluded: 2 })
    if (r) texts.push({ where: `librarian.render(相似度${(sim * 100).toFixed(0)}%)`, text: r })
  }
  const r0 = librarian.render({ top: [{ pos: 5, kind: '思考', sim: 0.95 }] })
  if (r0) texts.push({ where: 'librarian.render(无排除)', text: r0 })

  // ⑤ repetition.render —— 两档都要覆盖（stuck 与 watch 的文案不同）
  const rep = await import(lib + 'repetition.js')
  const stuck = rep.detectRepetition('需要继续处理。'.repeat(20))
  const rs = rep.renderRepetition(266, stuck)
  if (rs) texts.push({ where: 'repetition.render(stuck)', text: rs })

  // ⑥ reference-check.render
  const ref = await import(lib + 'reference-check.js')
  const rr = ref.renderMissingRefs(123, { checked: 3, found: 2, missing: [{ ref: '工具\\_x.js' }] })
  if (rr) texts.push({ where: 'reference-check.render', text: rr })

  // ⑦ fok.render —— 三档文案都要覆盖
  const fok = await import(lib + 'fok.js')
  for (const lv of [
    ['certain', { level: 'certain', confidence: 0.79, advice: '有一处明确对应。', pointers: [{ pos: 932, kind: '正文', sim: 0.79 }] }],
    ['fuzzy', { level: 'fuzzy', confidence: 0.65, advice: '未出现明确对应，但有 4 处分数接近。建议回看确认。', pointers: [{ pos: 870, kind: '思考', sim: 0.65 }] }],
    ['unknown', { level: 'unknown', confidence: 0.46, advice: '本次痕迹里未找到明显相近的位置。', pointers: [] }],
  ]) {
    const x = fok.renderFok(lv[1])
    if (x) texts.push({ where: `fok.render(${lv[0]})`, text: x })
  }

  // ⑧ novelty.render —— 三档
  const nv = await import(lib + 'novelty.js')
  for (const lv of [
    ['novel', { level: 'novel', novelty: 0.53, advice: '本会话中未出现相近内容，且几乎未触及已知术语。', metrics: { maxSim: 0.47, termHits: 0 } }],
    ['partly', { level: 'partly', novelty: 0.61, advice: '属于已知领域，但具体内容是新出现的。', metrics: { maxSim: 0.39, termHits: 4 } }],
    ['known', { level: 'known', novelty: 0.21, advice: '与既有内容高度相近，不算新。', metrics: { maxSim: 0.79, termHits: 0 } }],
  ]) {
    const x = nv.renderNovelty(lv[1])
    if (x) texts.push({ where: `novelty.render(${lv[0]})`, text: x })
  }

  // ⑨ learning.renderUnits
  const ln = await import(lib + 'learning.js')
  const lu = ln.renderUnits([{
    class: '知识', doubt: { pos: 285 }, conclusion: { pos: 285 },
    verification: { evidenced: true },
  }])
  if (lu) texts.push({ where: 'learning.renderUnits', text: lu })

  // ⑩ novelty.renderNoveltyHint（"疑似新知识"提示）
  for (const lv of [
    ['novel', { level: 'novel', metrics: { maxSim: 0.39, termHits: 4 } }],
    ['partly', { level: 'partly', metrics: { maxSim: 0.55, termHits: 2 } }],
  ]) {
    const x = nv.renderNoveltyHint(lv[1])
    if (x) texts.push({ where: `novelty.renderNoveltyHint(${lv[0]})`, text: x })
  }

  // ⑪ knowledge.renderTraverse + renderTree
  const kn = await import(lib + 'knowledge.js')
  const kr = kn.traverse('示例查询', { projectRoot: PROJECT_FOR_CHECK })
  const kt = kn.renderTraverse(kr)
  if (kt) texts.push({ where: 'knowledge.renderTraverse', text: kt })
  const kg = kn.loadGraph(PROJECT_FOR_CHECK)
  if (kg) { const tt = kn.renderTree(kg, { maxDepth: 1, maxPerLevel: 4 }); if (tt) texts.push({ where: 'knowledge.renderTree', text: tt }) }
  // ⑫ report 总装输出 + alert_check 的工具渲染（含 report 形态）
  const repMod = await import(lib + 'report.js')
  try {
    const rep = await repMod.buildReport(PROJECT_FOR_CHECK, { useRetrieval: false })
    if (rep.text) texts.push({ where: 'report.buildReport', text: rep.text })
    const v = { clean: false, items: [], report: rep.text, meta: { skipped: ['x'] } }
    const rr = alert.renderAlertTool(v).map((x) => x.text).join('\n')
    if (rr) texts.push({ where: 'renderAlertTool(含 report)', text: rr })
  } catch (e) { console.log('  (report 检查跳过:', e.message, ')') }
  // ⑬ anchor.renderAnchor
  const an = await import(lib + 'anchor.js')
  const aObj = { goal:{objective:'x',phase:'active'}, todos:{total:3,pending:2,in_progress:0,completed:1,pendingList:['a']}, constraints:{rules:['规则一','规则二']}, recentActions:['edit','pwsh'], hasAnchor:true }
  const at = an.renderAnchor(aObj)
  if (at) texts.push({ where: 'anchor.renderAnchor', text: at })
  const ft = kn.renderFormatSpec({ layout: true })
  if (ft) texts.push({ where: 'knowledge.renderFormatSpec', text: ft })
  // ⑭ blocks.renderBlocks
  const bl = await import(lib + 'blocks.js')
  const bActs = [{kind:'用户',text:'做A'},{kind:'思考',text:'x'},{kind:'用户',text:'做B'},{kind:'思考',text:'y'}]
  const bbs = bl.splitBlocks(bActs)
  const bt = bl.renderBlocks(bbs, { max: 3 })
  if (bt) texts.push({ where: 'blocks.renderBlocks', text: bt })
  // ⑮ knowledge_extract 工具的两种模式渲染
  const ex1 = alert.renderExtractTool({ ok: true, mode: 'prompt', file: 'x.js', chars: 100, prompt: '（提示词）', next: '按提示词产出 JSON 后交回来。' })
  if (ex1) texts.push({ where: 'renderExtractTool(prompt)', text: ex1.map((x) => x.text).join('\n') })
  const ex2 = alert.renderExtractTool({ ok: true, mode: 'verify', stats: { nodesIn: 2, edgesIn: 2, nodesOk: 2, edgesOk: 1, fabricatedRate: 0.25 }, stored: 2, report: '📥 抽取：通过 3 条' })
  if (ex2) texts.push({ where: 'renderExtractTool(verify)', text: ex2.map((x) => x.text).join('\n') })
  const ex3 = alert.renderExtractTool({ ok: false, error: '未找到文档' })
  if (ex3) texts.push({ where: 'renderExtractTool(错误)', text: ex3.map((x) => x.text).join('\n') })
  return texts
}

function defaultSession() {
  const dir = path.join(os.homedir(), '.dsh', 'sessions', '--D-dswork--')
  try {
    const withR = fs.readdirSync(dir).map((sid) => {
      const f = path.join(dir, sid, 'session.jsonl.zstd')
      if (!fs.existsSync(f)) return null
      const n = (fs.readFileSync(f).length)   // 用文件大小当"内容多"的代理，避免解压
      return { f, n }
    }).filter(Boolean).sort((a, b) => b.n - a.n)
    return withR[0]?.f || null
  } catch { return null }
}

// ── 检查 ──
const { judges } = alert.loadJudges(PROJECT_FOR_CHECK)
const texts = await collectTexts()
console.log(`检查 ${texts.length} 处对外输出，比对 ${judges.length} 条判据\n`)

let totalLeaks = 0
for (const { where, text } of texts) {
  const leaks = []
  for (let ji = 0; ji < judges.length; ji++) {
    const j = judges[ji]
    for (const w of [...(j.signals || []), ...(j.anomalies || [])]) {
      if (w && text.includes(w)) leaks.push({ judge: j.id, len: String(w).length })
    }
  }
  if (leaks.length) {
    totalLeaks += leaks.length
    console.log(`❌ ${where}`)
    for (const l of leaks) {
      // ⚠️ 只报"第几条判据、词长几位"，不打印词本身 —— 打印词表就是二次泄漏
      console.log(`     → 命中判据「${l.judge}」中的某词（长度 ${l.len}）`)
    }
  } else {
    console.log(`✅ ${where}`)
  }
}

console.log(`\n${'═'.repeat(50)}`)
console.log(totalLeaks ? `❌ 共 ${totalLeaks} 处泄漏 —— 必须修` : '✅ 无泄漏')
process.exit(totalLeaks ? 1 : 0)
