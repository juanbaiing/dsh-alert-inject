/**
 * health.js — 体检：**让它自己报告"我现在是什么状态、哪里没跑、为什么"**
 *
 * ══ 为什么这是第一优先（见 `AGENTS.md` 开发顺序第 1 步）══════════════
 *   本项目已为"静默失败"付过六次代价（§237–§242），而**六条使用者一条都无法自己发现**。
 *   ⇒ 在做任何新功能之前，先让它能回答一个最基本的问题：
 *     **「你现在工作正常吗？你怎么证明？」**
 *
 * ══ 三条设计纪律（对应 AGENTS.md 的 ①自证 ②可裁决 ③坏掉要出声）══════
 *   ① **自证**：每一项都报告"我实际读了什么、读到了没有"，
 *      不是"配置项填了没有" —— **配了不等于找到了**（§239 就是这么栽的）。
 *   ② **可裁决**：每一条结论都附带 `how`（**你怎么自己确认这一条**）。
 *      使用者不需要懂原理，只需要照做。
 *   ③ **坏掉要出声**：状态是**三态**，不是两态 ——
 *        `ok`      测过了，正常
 *        `broken`  测过了，坏了（**带下一步怎么办**）
 *        `skipped` **没测**（带原因）—— ⚠️ 这一态最容易被吞掉，
 *                  而"没测"与"测了没问题"必须分得清清楚楚（§239 的病因）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OK = 'ok', BROKEN = 'broken', SKIPPED = 'skipped'

/**
 * 跑一次体检。
 * @returns {{at:string, checks:Array, samples:object|null, verdict:string, todo:Array<string>}}
 */
export async function runHealth({ projectRoot, cwd } = {}) {
  const checks = []
  const add = (name, status, detail, how) => checks.push({ name, status, detail, how })

  // ── 载入各模块（**全部容错**：某块坏了不该让体检本身失败）──
  const load = async (rel) => { try { return await import(rel) } catch (e) { return { __err: e.message } } }
  const cfgMod = await load('./config.js')
  const cfg = cfgMod.__err ? null : cfgMod.config()

  const root = projectRoot || cfg?.projectRoot || cwd || null

  // ══ ① 配置与文件（**读到了才算数**）══
  if (!root) {
    add('项目根', BROKEN, '没推断出项目根 —— 所有依赖它的检查都无法进行',
      '设置环境变量 DSH_ALERT_CWD=<你的项目路径>，或在 ~/.dsh/alert-inject.json 里写 projectRoot')
  } else {
    const exists = fs.existsSync(root)
    add('项目根', exists ? OK : BROKEN, exists ? root : `这个路径不存在：${root}`,
      exists ? '用文件管理器打开这个路径，看它在不在' : '把路径改对，再跑一次体检')
  }

  if (root && fs.existsSync(root)) {
    // 判据表
    if (cfgMod.__err) {
      add('判据表', BROKEN, `配置模块载入失败：${cfgMod.__err}`, '这是代码问题，需要修')
    } else {
      let jp = null, pathErr = null
      // ⚠️ **必须把 root 传进去**（`judgesPath(projectRoot)` 本就接受它）。
      //    首版漏传 ⇒ 它退回 `config().projectRoot`（默认 null）⇒ 报告"没找到判据表"，
      //    而判据表明明在。
      //    ⇒ **体检自己不可靠** —— 这正是本文件头部引用的第六条：
      //      「凡是用来做判断、过滤、检测的东西，它自己也要被检查」。
      //    ⇒ 所以这次的 bug **是被"用另一条路径再确认一次"抓出来的**，不是靠读代码。
      try { jp = cfgMod.judgesPath?.(root) } catch (e) { pathErr = e?.message || String(e) }
      if (pathErr) {
        // ⚠️ 原来这里 `catch { /* 忽略 */ }` ⇒ 会报成「**没找到**判据表」，
        //    而真相是「**路径解析本身出错了**」——「找不到」与「没在找」是两回事（2026-10-16 修，见 TODO §17）
        add('判据表', BROKEN, `路径解析失败：${pathErr}`, '把这条报告给维护者')
      } else if (jp && fs.existsSync(jp)) {
        let n = 0, parseErr = null
        // ⚠️ 原来解析失败是静默的 ⇒ `n` 停在 0 ⇒ 报告会写成
        //    「✅ 正常 —— 里面有 **0 条**判据」，而「0 条」看起来像"本来就没配"
        //    ⇒ 判据扫描其实已经全哑，而报告说一切正常（2026-10-16 修，见 TODO §17）
        try { n = (JSON.parse(fs.readFileSync(jp, 'utf8')).judges || []).length } catch (e) { parseErr = e?.message || String(e) }
        if (parseErr) {
          add('判据表', BROKEN, `${path.relative(root, jp)} —— **读不动或解析失败**：${parseErr}`,
            '把这条报告给维护者；**判据扫描这一项现在不会工作**')
        } else {
          add('判据表', OK, `${path.relative(root, jp)} —— 里面有 ${n} 条判据`,
            `用记事本打开那个文件，数一数 "id" 出现几次`)
        }
      } else {
        add('判据表', SKIPPED, '没找到判据表 ⇒ **判据扫描这一项不会工作**',
          '若你的项目本来就不需要它，这条可以忽略')
      }
    }

    // 术语表 / 知识图
    for (const [label, rel, what] of [
      ['术语表', '※世界模拟/回想/_术语表.md', '词 → 档的对照表'],
      ['知识图', '※世界模拟/回想/_graph.json', '节点与关系的图'],
    ]) {
      const p = path.join(root, rel)
      if (fs.existsSync(p)) {
        let extra = '', readErr = null
        try {
          if (rel.endsWith('.json')) {
            const g = JSON.parse(fs.readFileSync(p, 'utf8'))
            extra = ` —— ${g.nodes?.length ?? '?'} 个节点 / ${g.edges?.length ?? '?'} 条边`
          } else {
            const n = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.startsWith('|')).length
            extra = ` —— ${n} 行表格`
          }
        } catch (e) { readErr = e?.message || String(e) }
        if (readErr) {
          // ⚠️ 原来状态仍是 OK、只在文字里写「（文件读不动，可能坏了）」
          //    ⇒ 报告会出现「✅ 正常 …… 文件读不动，可能坏了」这种**自相矛盾**的行
          //    ⇒ 状态必须跟着真相走（2026-10-16 修，见 TODO §17）
          add(label, BROKEN, `${rel} —— **文件读不动**：${readErr}`,
            '把这条报告给维护者；依赖它的功能会**静默失效**')
        } else {
          add(label, OK, `${rel}${extra}`, `打开 ${rel}，看看内容是不是${what}`)
        }
      } else {
        add(label, SKIPPED, `没有这个文件（${rel}）⇒ 依赖它的功能会跳过`,
          '不需要就忽略；需要的话检查路径')
      }
    }
  }

  // ══ ② 会话读取 —— ★ §239 就是栽在这里 ══
  const idxMod = await load('./index.js')
  if (idxMod.__err) {
    add('会话读取', BROKEN, `模块载入失败：${idxMod.__err}`, '这是代码问题，需要修')
  } else if (root) {
    let sf = null, acts = 0
    try {
      sf = idxMod.latestSessionFile?.(root) || null
      if (sf) acts = idxMod.recentActivity(sf, 0)?.length || 0
    } catch (e) { /* 下面统一报 */ }
    if (sf && acts > 0) {
      add('会话读取', OK, `读到 ${acts} 条对话痕迹`, `跑一次 alert_check —— 若它回「未读到本会话痕迹」，就是这一项坏了`)
    } else if (sf && acts === 0) {
      add('会话读取', BROKEN, `找到了会话文件但**一条痕迹都没读到**`,
        '这是最隐蔽的一类问题：它会表现为"一切正常"。把这条报告给维护者')
    } else {
      add('会话读取', SKIPPED, '这个项目下没有历史会话 ⇒ 依赖对话的功能全部跳过',
        '用过这个项目的对话，再跑体检')
    }
  }

  // ══ ③ 样本库 ══
  let samples = null
  const smMod = await load('./samples.js')
  if (smMod.__err) {
    add('样本库', BROKEN, `模块载入失败：${smMod.__err}`, '这是代码问题，需要修')
  } else {
    try {
      const st = smMod.stats()
      samples = { file: st.file, events: st.events, dataset: st.dataset, unusableCorr: st.unusableCorr }
      const tasks = Object.entries(st.dataset || {})
      if (st.events === 0) {
        add('样本库', SKIPPED, `文件存在但**是空的**：${st.file}`,
          '打开那个文件看行数；空的话等它随对话自动累积，或跑一次首次引导')
      } else {
        add('样本库', OK,
          `${st.events} 条（${tasks.map(([k, v]) => `${k} ${v.total}`).join('｜')}）`,
          `打开 ${st.file}，数文件行数 —— 应当等于 ${st.events}`)
      }
    } catch (e) {
      add('样本库', BROKEN, `读取失败：${e.message}`, '把这条报告给维护者')
    }
  }

  // ══ ④ 待审队列 ══
  try {
    const f = path.join(os.homedir(), '.dsh', 'learning-pending.json')
    if (fs.existsSync(f)) {
      const us = JSON.parse(fs.readFileSync(f, 'utf8')).units || []
      add('待审队列', OK, `${us.length} 条待审（**尚未生效**，需复核后才进库）`,
        '打开 ~/.dsh/learning-pending.json，看 units 里有几条')
    } else {
      add('待审队列', SKIPPED, '还没有待审文件（没产生过抽取候选）', '忽略即可')
    }
  } catch (e) { add('待审队列', BROKEN, `读取失败：${e.message}`, '把这条报告给维护者') }

  // ══ ⑤ 首次引导 ══
  const bsMod = await load('./bootstrap.js')
  if (!bsMod.__err) {
    try {
      const st = bsMod.bootstrapState()
      if (!st) {
        add('首次引导', SKIPPED, '从未引导过 ⇒ 历史会话里的材料还没被用上',
          '下次调用自查时会自动在后台跑一次（几十秒，不阻塞回答）')
      } else if (st.ok) {
        // ⚠️ 表述要能区分「补了新的」与「已补过、这次没新增」。
        //    首版直接报"补入 0 条" ⇒ 看起来像失败，而它其实可能是**幂等生效**的正常结果。
        //    ⇒ 这正是本项目反复栽的坑：**同一个输出对应多种内部状态时，必有一条在骗人。**
        const cnt = st.corrections || 0
        const weakNew = (st.weak || 0) - (st.weakDup || 0)
        const dup = st.weakDup || 0
        const desc = (cnt + weakNew) > 0
          ? `已完成：扫 ${st.sessions} 个会话，补入纠正 ${cnt} 条 / 弱标注 ${weakNew} 条`
          : `已完成：扫 ${st.sessions} 个会话。**这次没有新增**${dup ? `（跳过重复 ${dup} 条）` : ''} —— 材料此前已补过，**这是正常结果，不是失败**`
        add('首次引导', OK, desc,
          `看 ${path.join(os.homedir(), '.dsh', '.alert-inject-bootstrapped.json')}`)
      } else {
        add('首次引导', BROKEN, `上次失败：${st.reason || '（未记原因）'}`,
          '删掉 ~/.dsh/.alert-inject-bootstrapped.json，再跑一次自查')
      }
    } catch (e) { add('首次引导', BROKEN, e.message, '把这条报告给维护者') }
  }

  // ══ ⑥ 语义检索（通常没索引，要**明确说没测**）══
  const lbMod = await load('./librarian.js')
  if (!lbMod.__err) {
    let idx = null
    try { idx = idxMod?.latestSessionFile?.(root) ? lbMod.loadCache(idxMod.latestSessionFile(root)) : null } catch { /* 忽略 */ }
    if (idx) add('语义检索', OK, `有索引缓存，${idx.entries?.length ?? '?'} 条`, '忽略即可，这项影响不大')
    else add('语义检索', SKIPPED, '**没有索引缓存 ⇒ 这一项根本没跑**（不是"跑了没问题"）',
      '这不是故障。要启用得先建索引（要几分钟）')
  }

  // ══ ⑦ 档案检索（★ 2026-10-16 加：**这一条此前完全不在体检里**）══
  //
  // ⚠️ 为什么要加：加之前在本机实测跑出「✅ 全部正常」，
  //    而那时 `DSH_ALERT_ARCHIVE_DIR` 为空 ⇒ **档案检索一次都没跑过**。
  //    ⇒ 报告说"全部正常"，用户会读成"所有功能都查过了" —— **那是 §239 那个病换了个壳**。
  //    ⇒ 硬规则：**体检必须覆盖所有对外承诺的能力**；没覆盖的项要显式列出来，不能省略。
  //
  // ⚠️ 状态映射（照 §248 的三态语义，**不能照抄 librarian 那条**）：
  //    · `unconfigured` = 使用者**没配** ⇒ **有意静默** ⇒ 报 `skipped`（**不是 broken**）
  //    · `ok` + 有缓存   ⇒ 报覆盖率（"没找到"与"只查了 5%"是两回事）
  //    · `ok` + 无缓存   ⇒ `skipped`，并明说"这一路暂时没在查"
  //    · 其余（`unreadable` 等）⇒ `broken`
  const arMod = await load('./archive.js')
  if (!arMod.__err) {
    try {
      // ⚠️ 必须用 `archiveDir()`（**现读配置**），不要用 `ARCHIVE_OPTS.dir`
      //    （2026-10-16 改：那个字段已清空，因为它在模块加载时读 `process.env` 一次，
      //     而"用户级环境变量对新进程才生效、桌面启动的 DSH 继承旧环境"⇒ 配了也不生效）。
      //    ⚠️ 这处**差点变成新的静默 bug**：若继续读旧字段 ⇒ 拿到的永远是空串 ⇒
      //     **即使目录配好了，体检也永远报"没测"**，而使用者会一直以为自己没配。
      const a = arMod.archiveDir()
      const dir = a.dir
      const st = arMod.archiveStatus(dir)
      if (st.state === 'unconfigured') {
        add('档案检索', SKIPPED, `**没有配置档案目录 ⇒ 这一路没在找**（不是"没有相关档案"）　—　${a.why}`,
          '想让它在召回时也查你的档案：在 ~/.dsh/alert-inject.json 里写 {"archiveDir": "你的档案目录"}（改完重启 DSH），或设环境变量 DSH_ALERT_ARCHIVE_DIR')
      } else if (st.state === 'unreadable') {
        add('档案检索', BROKEN, `配置的目录读不到：${st.why}`,
          '检查 DSH_ALERT_ARCHIVE_DIR 指向的路径是否存在、是不是一个目录')
      } else {
        const idx = arMod.readCachedIndex(dir)
        if (idx.state === 'ok' && idx.index) {
          const s = idx.index.stats || {}
          const cov = s.total ? `${(s.coverage * 100).toFixed(0)}%` : '?'
          const stale = idx.stale ? '　⚠️ 档案已改动、索引尚未重建' : ''
          add('档案检索', OK,
            `目录 ${dir} —— 索引 ${s.chunks ?? '?'}/${s.total ?? '?'} 块（**覆盖 ${cov}**），跨 ${s.filesCovered ?? '?'}/${s.files ?? '?'} 个文件${stale}`,
            '问一次"档案里有讲过什么" —— 提醒里应出现一段「📁 档案检索」，并报出覆盖率')
        } else {
          add('档案检索', SKIPPED,
            `目录配好了（${dir}），但**索引还没就绪 ⇒ 这一路暂时没在查**（不是"没有相关档案"）`,
            '这不是故障。建一次索引约几分钟，会在后台自己建；建好后这一项变 ✅')
        }
      }
    } catch (e) { add('档案检索', BROKEN, `检查过程中出错：${e.message}`, '把这条报告给维护者') }
  }

  // ══ 判词 ══
  const broken = checks.filter((c) => c.status === BROKEN)
  const skipped = checks.filter((c) => c.status === SKIPPED)
  const verdict = broken.length
    ? `❌ 有 ${broken.length} 项坏了：${broken.map((c) => c.name).join('、')}`
    : (skipped.length
      ? `✅ 能跑的项都正常；另有 ${skipped.length} 项**没测**（原因见下）`
      : '✅ 全部正常')

  const todo = []
  for (const c of broken) todo.push(`修「${c.name}」：${c.how}`)
  if (!broken.length && skipped.length) todo.push('「没测」不等于"没问题"。要看全貌，先把上面 skipped 的项按说明启用')

  // ⚠️ 时间用**本地时区**。
  //    首版用 `toISOString()` ⇒ 报告显示 UTC，与使用者的钟差 8 小时。
  //    ⇒ 对"这份报告是刚才跑的吗"这种最基本的问题，都会误导。
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const at = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`

  return { at, root, checks, samples, verdict, todo }
}

/** 渲染成人可读的体检报告（**给不看代码的人看的**） */
export function renderHealth(r) {
  const S = { ok: '✅', broken: '❌', skipped: '⚠️' }
  const L = []
  L.push('════════════════════════════════════════════════════════════')
  L.push(`  体检报告   ${r.at}`)
  L.push('════════════════════════════════════════════════════════════')
  L.push('')
  L.push(`【一句话】${r.verdict}`)
  L.push('')
  L.push('【逐项】每一条都附「你怎么自己确认」—— 不用懂代码')
  L.push('')
  for (const c of r.checks) {
    L.push(`  ${S[c.status]} ${c.name}`)
    L.push(`      状态：${c.status === 'ok' ? '正常' : c.status === 'broken' ? '坏了' : '没测'}`)
    L.push(`      实际：${c.detail}`)
    L.push(`      你怎么确认：${c.how}`)
    L.push('')
  }
  if (r.samples) {
    L.push('【样本库明细】')
    L.push(`  文件：${r.samples.file}`)
    L.push(`  总数：${r.samples.events}`)
    for (const [k, v] of Object.entries(r.samples.dataset || {})) {
      L.push(`    · ${k.padEnd(20)} ${String(v.total).padStart(4)} 条（其中可训练 ${v.labeled}）`)
    }
    if (r.samples.unusableCorr) L.push(`  ⚠️ 另有 ${r.samples.unusableCorr} 条因缺输入而不可用（已剔除、不参与统计）`)
    L.push('')
  }
  L.push('════════════════════════════════════════════════════════════')
  L.push('【下一步】')
  if (r.todo.length) for (const t of r.todo) L.push(`  · ${t}`)
  else L.push('  · 没有待办')
  L.push('')
  L.push('⚠️ 记住：「没测」和「测了没问题」是两件事 —— 本报告把它们分开列。')
  L.push('════════════════════════════════════════════════════════════')
  return L.join('\n')
}
