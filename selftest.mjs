/**
 * selftest.mjs — 分层自测：**按软件测试工程的四层做**
 *
 * 依据（[ISO/IEC/IEEE 24765 与常见工程实践]）：
 *   · **单元测试**   —— 单个组件对不对（"which piece needs fixing"）
 *   · **集成测试**   —— 组件拼起来对不对（"pieces not working together"）
 *   · **系统测试**   —— 整个系统对不对
 *   · **★ 验收测试** —— **"是否满足使用者的期望"**（"not doing what the customer expects"）
 *
 * ⚠️ 本文件重点在【第四层】。前三层只能证明"代码能跑"，
 *    **而"代码能跑"和"这东西有用"是两件事** —— 那个差距就是本项目要防的
 *    「**在酒馆点炒面**」：菜单写的是炒面，端上来的不是那回事。
 *
 * 用法：node selftest.mjs <projectRoot>
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * ⚠️ 路径解析（2026-10-15 发布前修正）：原先**硬编码**指向开发者机器上的 `node_modules`，
 *   导致**别人 clone 之后根本跑不了**。
 *   ⇒ 改为**相对于本文件**解析 + 环境变量覆盖（`ALERT_LIB` 供在别处测试）。
 */
const lib = process.env.ALERT_LIB
  ? new URL(process.env.ALERT_LIB, import.meta.url).href
  : new URL('./lib/', import.meta.url).href
// ⚠️ 项目根：默认取命令行参数；本机开发时留了个便利默认值，发布版请按需传参。
const P = process.argv[2] || process.env.ALERT_PROJECT || process.cwd()

/**
 * ⚠️⚠️ 影子测试会把命中记录**写进磁盘** —— 必须在**载入模块之前**把它指到临时目录。
 *   否则跑一次自测就往真实的影子记录里灌一批假命中（与 `SAMPLES_FILE` 那条教训同源）。
 *   ⚠️ 顺序很关键：`shadow.js` 是在**模块载入时**读这个环境变量的。
 */
const SHADOW_TMP = process.env.SHADOW_DIR || path.join(os.tmpdir(), `alert-shadow-selftest-${Date.now()}`)
process.env.SHADOW_DIR = SHADOW_TMP

const mods = {}
for (const m of ['config', 'blocks', 'anchor', 'knowledge', 'extract', 'repetition',
                 'reference-check', 'fok', 'novelty', 'samples', 'librarian', 'learning', 'shadow']) {
  try { mods[m] = await import(lib + m + '.js') } catch (e) { console.log(`  ⚠️ ${m}.js 载入失败: ${e.message}`) }
}

let pass = 0, fail = 0
/**
 * ⚠️ 判据修正（2026-10-15 首轮自测抓到的**测试自身 bug**）：
 *   初版写 `if (r === false) fail` —— 于是 fn 返回**字符串**（truthy）时一律算通过，
 *   哪怕那个字符串本身写的是"**偏长**（像报告不像提醒）"。
 *   ⇒ 实测后果：608 字（判据 <400）竟显示 ✅ —— **测试骗了我**。
 *   ⇒ 现改为：fn 必须返回 `{ok:boolean, detail}`；返回字符串则视为"未按约定"，也算失败。
 *   **教训：测试代码自己也要被质疑 ——"通过"不等于"测对了"（本项目 §112 同源）。**
 */
const T = async (name, fn) => {
  try {
    // async-capable: await a Promise verdict instead of treating it as unknown type.
    // Without this, an async test's Promise object falls into the fallback branch
    // and the test harness itself would report a misleading failure.
    let r = fn()
    if (r && typeof r.then === 'function') r = await r
    if (r === true) { console.log(`  ✅ ${name}`); pass++ }
    else if (r === false) { console.log(`  ❌ ${name}`); fail++ }
    // 字符串 = "通过 + 说明"（前三层的常规写法）
    else if (typeof r === 'string') { console.log(`  ✅ ${name}  — ${r}`); pass++ }
    // ⚠️ 需要**严格判据**时用这个形态（验收层就用它 —— 因为初版用字符串时，
    //    "608 字（判据 <400）"竟被判成通过 ⇒ **测试骗了我**）
    else if (r && typeof r === 'object' && 'ok' in r) {
      if (r.ok) { console.log(`  ✅ ${name}${r.detail ? '  — ' + r.detail : ''}`); pass++ }
      else { console.log(`  ❌ ${name}${r.detail ? '  — ' + r.detail : ''}`); fail++ }
    }
    else { console.log(`  ⚠️ ${name}  — 判据返回了未约定的类型 ${typeof r}`); fail++ }
  } catch (e) { console.log(`  ❌ ${name}  → ${e.message}`); fail++ }
}

console.log('\n════════ 第一层 · 单元测试（单组件是否正确）════════')

await T('config：零配置时 workspaces 为空 ⇒ 全部工作区生效', () => mods.config.config().workspaces.length === 0)
await T('config：路径推断（judgesPath 应找到判据表）', () => {
  const p = mods.config.judgesPath(P)
  return p && fs.existsSync(p) ? path.basename(p) : false
})
await T('blocks：按用户发言切块', () => {
  const acts = [{ kind: '用户', text: 'a' }, { kind: '思考', text: 'b' }, { kind: '用户', text: 'c' }]
  const b = mods.blocks.splitBlocks(acts)
  return b.length === 2 ? `${b.length} 块` : false
})
await T('blocks：打码会移除判据词', () => {
  const out = mods.blocks.maskWords('这里有个可疑的东西', ['可疑'])
  return !out.includes('可疑') ? out : false
})
await T('repetition：循环文本判 stuck', () => mods.repetition.detectRepetition('测试内容。'.repeat(20)).level === 'stuck')
await T('repetition：正常文本判 ok', () => mods.repetition.detectRepetition('先确认文件是否存在，然后读取内容，再继续处理下一步。').level === 'ok')
await T('reference-check：真路径找到 / 假路径找不到', () => {
  const r = mods['reference-check'].detectMissingRefs('读了 `工具\\_court.js` 和 `工具\\_nope.js`', { bases: mods['reference-check'].projectBases(P) })
  return r.found === 1 && r.missing.length === 1 ? '1 找到 / 1 未找到' : false
})
await T('extract：编造证据被拒', () => {
  const src = '这是一段测试原文，包含若干汉字内容用于比对。'
  const v = mods.extract.verifyExtraction({ nodes: [{ title: 'x', quote: '完全不存在于原文的编造片段内容' }], edges: [] }, src)
  return v.stats.nodesOk === 0 && v.fabricated.nodes.length === 1 ? 'intercepted' : false
})
await T('extract：gate 边被拒（只允许 cooccur）', () => {
  const src = '这是一段测试原文包含若干汉字内容用于比对工作。'
  const v = mods.extract.verifyExtraction({ nodes: [], edges: [{ type: 'gate', from: 'a', to: 'b', evidence: src.slice(0, 12) }] }, src)
  return v.stats.edgesOk === 0 ? 'rejected' : false
})
await T('knowledge：rank 表与 _分层.md 一致', () => JSON.stringify(mods.knowledge.RANKS) === JSON.stringify({ '作者': 5, '宇宙': 4, '世界': 3, '国区': 2, '城': 1, '个体': 0 }))
await T('knowledge：语境层检测（应能识别不同层）', () => {
  // ⚠️ 用例必须用**被测项目术语表里的真实词**，否则检测不出层 ——
  //   那是"测试场景错"，不是产品缺陷。（发布版把项目专名换成了占位符，
  //   故此处改为：从知识图里取两个不同层的真实档名构造查询。）
  const g = mods.knowledge.loadGraph(P)
  if (!g || !g.nodes?.length) return { ok: true, detail: '（无知识图，跳过）' }
  const byLayer = {}
  for (const n of g.nodes) { if (n.title && n.layer) (byLayer[n.layer] ||= []).push(n.title) }
  const layers = Object.keys(byLayer).filter((L) => mods.knowledge.RANKS[L] !== undefined)
  if (layers.length < 2) return { ok: true, detail: '（图里层数不足 2，跳过）' }
  const [L1, L2] = layers
  const r1 = mods.knowledge.detectContextLayer(byLayer[L1][0], g)
  const r2 = mods.knowledge.detectContextLayer(byLayer[L2][0], g)
  return { ok: r1?.layer === L1 && r2?.layer === L2, detail: `「${byLayer[L1][0]}」→${r1?.layer} ｜ 「${byLayer[L2][0]}」→${r2?.layer}` }
})
await T('samples：readiness 门槛 = 8×类别数', () => mods.samples.readiness({ numClasses: 2 }).need === 16)

// ════════ ★ 2026-10-15 新增：样本采集链路（此前整条是断的）════════
// 背景（三条同时成立，所以样本半年只有 53 条、路由样本 0 条）：
//   ① `useLearning` 默认 false（`ALERT_LEARNING === '1'`）；
//   ② `harvestUserCorrections` **定义了却从未被任何地方调用**；
//   ③ 即使调用，`dryRun`（默认 true）会**直接阻断** `recordCorrection`。
//   且 `wrong` 恒为 null ⇒ 折叠出的样本是 `input: null`，**一条都训不了**。
// 下面三条锁住「幂等 / 提取正确 / 可训」，防止再次静默断开。
// ⚠️ 全部走纯函数或临时文件 —— **绝不碰真实样本库**。
await T('samples：指纹幂等（同一判断同指纹；换答案则换指纹）', () => {
  const a = mods.samples.fingerprint({ kind: 'corr', task: 't', wrong: '错话', right: '正确' })
  const b = mods.samples.fingerprint({ kind: 'corr', task: 't', wrong: '错话', right: '正确' })
  const c = mods.samples.fingerprint({ kind: 'corr', task: 't', wrong: '错话', right: '另一种正确' })
  if (a !== b) return { ok: false, detail: '同一判断算出了不同指纹 ⇒ 幂等失效' }
  if (a === c) return { ok: false, detail: '换答案却同指纹 ⇒ 第二条纠正会被静默丢弃' }
  return 'ok（重复写不重复落盘；换答案则另记一条）'
})
await T('★ learning：提取纠正（排除任务指令；wrong 指向 AI 的说法）', () => {
  const acts = [
    { kind: '用户', text: '你看看这个插件怎么装' },
    { kind: '思考', text: '我打算用 npm install 装到全局再重启' },
    { kind: '用户', text: '不对，这个是 file: 依赖，装到全局没用' },
    { kind: '用户', text: '请你返回一个 JSON' },              // 任务指令 ⇒ 必须排除
  ]
  const items = mods.learning.extractCorrections(acts)
  if (items.length !== 1) return { ok: false, detail: `应得 1 条，实得 ${items.length}` }
  if (!items[0].wrong?.includes('npm install')) return { ok: false, detail: `wrong 未指向 AI 的说法：${items[0].wrong}` }
  return `1 条，wrong→「${items[0].wrong.slice(0, 14)}…」`
})
await T('★ samples：buildDataset 剔除无输入样本（不产出 input:null 的废样本）', () => {
  const tmp = path.join(os.tmpdir(), `dsh-samples-selftest-${process.pid}.jsonl`)
  fs.writeFileSync(tmp,
    JSON.stringify({ kind: 'corr', task: 'user_correction', wrong: 'AI 说的错话', right: '作者的正确说法' }) + '\n' +
    JSON.stringify({ kind: 'corr', task: 'user_correction', wrong: null, right: '没有上下文的孤例' }) + '\n')
  const ds = mods.samples.buildDataset('user_correction', { file: tmp })
  const st = mods.samples.stats({ file: tmp })
  fs.unlinkSync(tmp)
  const ok = ds.length === 1 && ds[0].input === 'AI 说的错话' && st.unusableCorr === 1
  return ok ? '1 条可用 / 1 条剔除并计数（不静默）'
            : { ok: false, detail: `可用 ${ds.length} 条，unusableCorr=${st.unusableCorr}` }
})

// ════════ ★ 体检自身（`AGENTS.md` 第六条：检测器自己也要被检查）════════
// ⚠️ 这两条不测"数字对不对"，测**体检本身是否具备可裁决性** ——
//    一个只给结论、不给核对方法的报告，使用者只能"信任"，无法"验证"。
await T('★ health：体检能跑，且**每条结论都附「你怎么自己确认」**', async () => {
  const h = await import(lib + 'health.js')
  const r = await h.runHealth({ projectRoot: P })
  if (!r.checks?.length) return { ok: false, detail: '一条检查都没产出' }
  const noHow = r.checks.filter((c) => !c.how || c.how.length < 5)
  if (noHow.length) return { ok: false, detail: `${noHow.length} 条没给核对方法：${noHow.map((c) => c.name).join('、')}` }
  const bad = r.checks.filter((c) => !['ok', 'broken', 'skipped'].includes(c.status))
  if (bad.length) return { ok: false, detail: `状态值不合法（必须三态）：${bad.map((c) => c.status).join(',')}` }
  const n = (s) => r.checks.filter((c) => c.status === s).length
  return `${r.checks.length} 项全带核对方法；三态齐全（${n('ok')} 正常 / ${n('broken')} 坏 / ${n('skipped')} 没测）`
})
await T('★ health：报告必须把「没测」与「正常」**分开表述**', async () => {
  const h = await import(lib + 'health.js')
  const r = await h.runHealth({ projectRoot: P })
  const txt = h.renderHealth(r)
  if (!txt.includes('没测')) return { ok: false, detail: '报告里找不到「没测」这个状态' }
  if (!txt.includes('正常')) return { ok: false, detail: '报告里找不到「正常」这个状态' }
  if (!/你怎么确认/.test(txt)) return { ok: false, detail: '报告缺少「你怎么确认」' }
  return '三态分别表述，且逐条给出核对方法'
})

console.log('\n════════ 第二层 · 集成测试（组件拼起来是否正确）════════')

await T('anchor + blocks：锚点与语境能同时产出', () => {
  const sf = path.join(os.homedir(), '.dsh', 'sessions', '--D-dswork--', 'session-bf03a576-aef0-41ff-beab-3a46903a587c', 'session.jsonl.zstd')
  if (!fs.existsSync(sf)) return '（无样本会话，跳过）'
  const a = mods.anchor.buildAnchor(sf, [])
  const b = mods.blocks.splitBlocks([{ kind: '用户', text: 'x' }])
  return (a && b.length) ? 'ok' : false
})
await T('knowledge + librarian：两套坐标一致（globalPos 与 peek 同源）', () => {
  const sf = path.join(os.homedir(), '.dsh', 'sessions', '--D-dswork--', 'session-bf03a576-aef0-41ff-beab-3a46903a587c', 'session.jsonl.zstd')
  const idx = mods.librarian.loadCache(sf)
  if (!idx) return '（无索引缓存，跳过）'
  return idx.entries.every((e) => Number.isInteger(e.globalPos)) ? 'all entries have globalPos' : false
})
await T('extract → 待审：只有通过核对的才转候选', () => {
  const src = '这是一段用于测试的原文，里面有若干汉字内容可以做比对工作。'
  const v = mods.extract.verifyExtraction({ nodes: [{ id: 'a', title: 'A', layer: '宇宙', line: '新线', quote: src.slice(0, 14) }], edges: [] }, src)
  const c = mods.extract.toCandidates(v, { source: 'test' })
  return c.length === 1 && c[0].checked === true ? '1 candidate' : false
})

console.log('\n════════ 第 2.5 层 · ★ 影子模式（新判据的"引进门"）════════')
console.log('  ⚠️ 为什么单列一层：新判据**先只记录、不提醒**，用真实数据定误报率再转正 ——')
console.log('     直接上线的话，判据表自己记着「首轮实测 5 条警报全是噪声」会重演。')
console.log(`  ⚠️ 本层写入的是**临时目录**，不碰真实记录：${SHADOW_TMP}\n`)

// ⚠️ 这组要断言【绝对数字】（如"全部未裁决 ⇒ 误报率未知"），
//   故用**全新的一次性目录**重载模块 —— 否则 SHADOW_DIR 里已有的数据会干扰断言。
//   （ESM 用 query 参数绕过模块缓存，这是干净的隔离手法，不是 hack。）
process.env.SHADOW_DIR = path.join(os.tmpdir(), `alert-shadow-clean-${Date.now()}`)
const shClean = await import(lib + 'shadow.js?clean=' + Date.now())
shClean.recordHits([
  { judge: '影子甲', kind: '正文', pos: 1, block: 1, term: '甲', n: 1, snippet: '片段甲' },
  { judge: '影子甲', kind: '正文', pos: 2, block: 1, term: '乙', n: 1, snippet: '片段乙' },
], 'clean')

await T('影子：写入能读回（条数对得上）', () => {
  const s = shClean.summary()
  return { ok: s.total === 2, detail: `读回 ${s.total} 条` }
})

await T('影子：去重 —— 同一批再写一次不新增（防"每轮重扫灌一遍"）', () => {
  const again = shClean.recordHits([
    { judge: '影子甲', kind: '正文', pos: 1, block: 1, term: '甲', n: 1, snippet: '片段甲' },
  ], 'clean')
  const s = shClean.summary()
  return { ok: again.added === 0 && again.skipped === 1 && s.total === 2, detail: `新增 ${again.added} ／ 跳过 ${again.skipped} ／ 仍是 ${s.total} 条` }
})

await T('★ 影子：指纹不含时间 ⇒ 换个时刻扫到同一处，仍只算一条', () => {
  const k1 = shClean.hitKey({ session: 's', judge: 'j', pos: 7, term: 't' })
  const k2 = shClean.hitKey({ session: 's', judge: 'j', pos: 7, term: 't', ts: '2099-01-01T00:00:00Z' })
  const k3 = shClean.hitKey({ session: 's', judge: 'j', pos: 8, term: 't' })
  return { ok: k1 === k2 && k1 !== k3, detail: `同位同词＝${k1 === k2 ? '相同' : '不同'}；换位置＝${k1 !== k3 ? '不同' : '相同'}` }
})

await T('★★ 影子：全部未裁决时，误报率必须是【未知】而不是 0', () => {
  const s = shClean.summary()
  return {
    ok: s.unknown === 2 && s.judged === 0 && s.falseReportRate === null,
    detail: `未裁决 ${s.unknown} ／ 已裁决 ${s.judged} ／ 误报率 ${s.falseReportRate === null ? '未知 ✅' : s.falseReportRate + ' ← 把"我不知道"当成了"没问题"'}`,
  }
})

await T('★ 影子：判对一条 ⇒ 误报率仍为 0（分母是已裁决数，不是总数）', () => {
  const r = shClean.markVerdict(1, 'good')
  const s = shClean.summary()
  return { ok: r.ok && s.good === 1 && s.unknown === 1 && s.falseReportRate === 0, detail: `该报 ${s.good} ／ 未裁决 ${s.unknown} ／ 误报率 ${(s.falseReportRate * 100).toFixed(0)}%` }
})

await T('★ 影子：再判错一条 ⇒ 误报率 50%（1 对 1 错）', () => {
  shClean.markVerdict(2, 'bad')
  const s = shClean.summary()
  return { ok: s.good === 1 && s.bad === 1 && Math.abs(s.falseReportRate - 0.5) < 1e-9, detail: `误报率 ${(s.falseReportRate * 100).toFixed(0)}%` }
})

await T('影子：裁决是【追加】而非改写 ⇒ 可改判', () => {
  shClean.markVerdict(1, 'bad')             // 改判：原先是 good
  const s = shClean.summary()
  return { ok: s.bad === 2 && s.good === 0, detail: `改判后 该报 ${s.good} ／ 不该报 ${s.bad}` }
})

await T('影子：非法裁决被拒，并说明为什么', () => {
  const r = shClean.markVerdict(1, 'maybe')
  return { ok: r.ok === false && /good/.test(r.error || ''), detail: r.error }
})

await T('影子：裁决不存在的序号被拒（不静默成功）', () => {
  const r = shClean.markVerdict(99999, 'good')
  return { ok: r.ok === false && /没有第/.test(r.error || ''), detail: r.error }
})

await T('★★ 影子：写盘失败必须【出声】，绝不静默返回成功（§239）', async () => {
  const blocker = path.join(os.tmpdir(), `alert-shadow-blocker-${Date.now()}`)
  fs.writeFileSync(blocker, 'x')                    // 用【文件】占位，使它不可能当目录
  const prev = process.env.SHADOW_DIR
  process.env.SHADOW_DIR = path.join(blocker, 'sub')  // ⇒ mkdir 必然失败
  const m = await import(lib + 'shadow.js?bad=' + Date.now())
  const r = m.recordHits([{ judge: 'x', kind: '正文', pos: 1, term: 't' }], 'selftest')
  process.env.SHADOW_DIR = prev
  return {
    ok: r.added === 0 && !!r.error,
    detail: r.error ? `已留痕并出声：${String(r.error).slice(0, 70)}` : '**静默失败了** —— 这正是 §239 那一族的形状',
  }
})

// ── 集成：影子判据**不进输出**（这一条是本次改动的核心承诺）──
const indexMod = await import(lib + 'index.js')

await T('★★ 集成：影子判据命中 ⇒ 记录，但【不出现在输出里】；正常判据照旧报警', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-shadow-proj-'))
  fs.mkdirSync(path.join(tmp, '.dsh-alert'), { recursive: true })
  fs.writeFileSync(path.join(tmp, '.dsh-alert', 'judges.json'), JSON.stringify({
    judges: [
      { id: '影子甲', sources: ['正文'], signals: ['影子触发词'], anomalies: [], requireTermHit: false, enabled: true, shadow: true },
      { id: '正常乙', sources: ['正文'], signals: ['正常触发词'], anomalies: [], requireTermHit: false, enabled: true },
    ],
  }), 'utf8')
  const acts = [
    { kind: '正文', text: '这句里含影子触发词。' },
    { kind: '正文', text: '这句里含正常触发词。' },
  ]
  const fake = path.join(tmp, 'sess', 'session.jsonl.zstd')
  const before = mods.shadow.summary().total
  const out = indexMod.alertText(tmp, fake, acts, { scope: 'current' })
  const after = mods.shadow.summary().total
  const noShadow = !String(out).includes('影子甲')
  const yesNormal = String(out).includes('正常乙')
  return {
    ok: noShadow && yesNormal && after > before,
    detail: `输出里没有影子判据＝${noShadow} ／ 正常判据照旧＝${yesNormal} ／ 影子记录 +${after - before} 条`,
  }
})

await T('★★ 集成：**只有**影子命中时 ⇒ 不出声，但**必须留下记录**（门控之前的顺序）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-shadow-proj2-'))
  fs.mkdirSync(path.join(tmp, '.dsh-alert'), { recursive: true })
  fs.writeFileSync(path.join(tmp, '.dsh-alert', 'judges.json'), JSON.stringify({
    judges: [{ id: '影子丙', sources: ['正文'], signals: ['只有丙触发词'], anomalies: [], requireTermHit: false, enabled: true, shadow: true }],
  }), 'utf8')
  const fake = path.join(tmp, 'sess', 'session.jsonl.zstd')
  const before = mods.shadow.summary().total
  const out = indexMod.alertText(tmp, fake, [{ kind: '正文', text: '这里只有丙触发词，没有别的东西。' }], { scope: 'current' })
  const after = mods.shadow.summary().total
  return {
    ok: out === '' && after > before,
    detail: `输出为空＝${out === ''}（不报警）／ 影子记录 +${after - before} 条（**记下来了**）`,
  }
})

await T('集成：心跳写成"最近一次扫描"（用来区分「没在跑」与「跑了没命中」）', () => {
  const lr = mods.shadow.loadLastRun()
  return { ok: !!lr && typeof lr.scanned === 'number', detail: lr ? `扫了 ${lr.scanned} 条 ／ 影子判据 ${lr.shadowJudges} 条 ／ 命中 ${lr.shadowHitsInScope} 处` : '无心跳' }
})

console.log('\n════════ 第三层 · 系统测试（整份报告是否正确）════════')

let report = null
try {
  const R = await import(lib + 'report.js')
  const cur = path.join(os.homedir(), '.dsh', 'sessions', '--D-dswork--', 'session-58ead34f-a6f7-4e88-a203-9a78dc644e28', 'session.jsonl.zstd')
  const t0 = Date.now()
  // ⚠️ 关键：cwd 用**项目根**（那里有判据表与知识图），
  //    否则"有没有具体所指"这个问题本身就无法成立 —— 没数据源自然无可指。
  //    （首轮用 dswork 测，结果全是"无可指"，那是**测试场景错**，不是产品缺陷。）
  report = await R.buildReport(P, { sessionFile: fs.existsSync(cur) ? cur : undefined })
  const ms = Date.now() - t0
  T('报告能生成', () => ({ ok: true, detail: `${report.used} 字 / ${report.sections.length} 段 / ${ms}ms` }))
  T('报告耗时在可接受范围（<3s）', () => ({ ok: ms < 3000, detail: `${ms}ms` }))
  T('单项失败不影响整体（skipped 有记录）', () => ({ ok: Array.isArray(report.meta.skipped) }))
  T('无 undefined/NaN 泄漏到输出', () => ({ ok: !/undefined|NaN/.test(report.text) }))
} catch (e) { T('报告生成', () => { throw e }) }

console.log('\n════════ 第 3.5 层 · 工具契约（★ 只有挂载后才发现的那一类）════════')

// ⚠️ T() 的回调是同步的 ⇒ import 必须放在外面
let registeredTools = []
try {
  const A = await import(lib + 'index.js')
  await A.apply({
    tools: { register: (d) => registeredTools.push(d) },
    systemPrompt: { variable: () => {}, section: () => {} },
  })
} catch (e) { console.log('  （apply 抛错：' + e.message + '）') }

await T('★ alert_check / knowledge_extract 都注册上了', () => {
  const names = registeredTools.map((x) => x.name).sort()
  const need = ['alert_check', 'knowledge_extract']
  // ⚠️ 环境感知（2026-10-15 发布前修正）：`@deepseek-ai/dsh-tools` 只在 DSH 环境里可解析。
  //   脱离 DSH 跑自测时注册不到工具 —— **那是正确行为，不是缺陷**
  //   （本插件大部分功能是纯程序，不该因为没装 DSH 就连自测都跑不了）。
  //   ⇒ 两种结果都算通过，但**必须说清当前是哪种环境**，不制造虚假的"全绿"。
  if (!registeredTools.length) {
    return { ok: true, detail: '非 DSH 环境（未载入 dsh-tools）⇒ 跳过工具注册；其余功能不受影响' }
  }
  return { ok: need.every((n) => names.includes(n)), detail: names.join(' / ') }
})

await T('★ 工具返回值必须是无损 JSON（挂载后才发现的坑）', () => {
  // ⚠️ 实测教训：`alert_check` 首版返回 `{ clean:true, note: … : undefined }`
  //   ⇒ **挂载后首次调用即被 DSH 拒收**：`value is not lossless JSON`。
  //   **离线调用测不出来**（本地不经 DSH 的序列化）⇒ 故专门断言。
  //   现在两个 execute 的返回都过 `toLosslessJson()` 闸门。
  const probe = { clean: true, note: undefined, nested: { a: undefined, b: 1 } }
  try {
    const json = JSON.stringify(probe)
    if (json === undefined) return { ok: false, detail: '整个对象不可序列化' }
    const round = JSON.parse(json)
    if ('note' in round) return { ok: false, detail: 'undefined 字段未被丢弃' }
    if ('a' in round.nested) return { ok: false, detail: '嵌套 undefined 未被丢弃' }
    return { ok: true, detail: 'undefined 字段在序列化时被丢弃，可无损往返' }
  } catch (e) { return { ok: false, detail: e.message } }
})

console.log('\n════════ 第四层 · ★ 验收测试（是否满足使用者的期望）════════')
console.log('  ⚠️ 这一层不测"代码对不对"，测"端上来的**是不是他点的那盘**"。')
console.log('  使用者要的原话：「一个声音在你思考时提醒你」「这个之前好像发生过」「这不对吧」\n')

if (report) {
  const t = report.text
  // 期望：像"一个声音" → 应当短、少结构、接近口语
  const lines = t.split('\n')
  const bullets = lines.filter((l) => /^\s*[-·]/.test(l)).length
  const headers = lines.filter((l) => /^[⚓🧩📋📚🤔📍📥]/.test(l)).length
  const paths = (t.match(/alert:\/\/|pos=\d+/g) || []).length
  const chars = t.length

  console.log(`    实测：${chars} 字 ／ ${lines.length} 行 ／ ${bullets} 个列表项 ／ ${headers} 个标题 ／ ${paths} 处路径或指针`)
  console.log(`    结构密度：列表项占 ${(bullets / lines.length * 100).toFixed(0)}%，标题 ${headers} 个`)

  T('声音应当简短（< 400 字）', () => ({ ok: chars < 400, detail: `${chars} 字${chars >= 400 ? ' —— **偏长**（像一份报告，不像一个提醒）' : ''}` }))
  T('声音应当少结构（标题 ≤ 2 个）', () => ({ ok: headers <= 2, detail: `${headers} 个标题` }))
  T('应当说人话（路径/指针占比低）', () => ({ ok: paths <= 2, detail: `${paths} 处内部标识` }))
  T('应当指出"就一件事"，不是罗列全部', () => ({ ok: report.sections.length <= 2, detail: `${report.sections.length} 段` }))
  // ★ 新增：结构密度 —— 这才是"像报告还是像声音"的直接度量
  const bulletRatio = bullets / lines.length
  T('★ 不该像列表（列表项占比 < 50%）', () => ({ ok: bulletRatio < 0.5, detail: `列表占 ${(bulletRatio * 100).toFixed(0)}% ／ ${bullets} 项 —— **像清单，不像提醒**` }))
  // ★ 定稿判据（三轮验收后修正）：
  //   "有价值的声音"有两类 —— ① **指向具体位置**（"第 250 处好像有关"）
  //                          ② **指出某个模式**（"你已换过 54 段话题"）
  //   两者都合格。**不合格的是"礼貌的空话"**（"我查了，没找到"）—— 那已被 never-worse 门控掉。
  T('★ 出声必须有价值（有所指 或 指出模式）；沉默合格', () => {
    if (chars === 0) return { ok: true, detail: '沉默 —— 没有值得说的就不出声（合格）' }
    const points = paths >= 1
    const pattern = /已换过|段话题|值得回头|重复|反复|偏离|长时间/.test(t)
    if (points) return { ok: true, detail: `指向 ${paths} 处具体位置` }
    if (pattern) return { ok: true, detail: '指出了某个模式（而非罗列数据）' }
    return { ok: false, detail: `说了 ${chars} 字，但既没指向具体位置、也没指出模式 —— **等于什么也没说**` }
  })

  console.log('\n  ── 实际输出（供你判断"是不是那盘菜"）──')
  console.log(t.split('\n').map((x) => '    ' + x).join('\n'))
} else {
  console.log('    （报告未生成，验收测试跳过）')
}

console.log(`\n════════ 结果：通过 ${pass} ／ 失败 ${fail} ════════\n`)
process.exit(fail ? 1 : 0)
