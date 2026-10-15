/**
 * librarian.js — 上下文图书管理员（最小版 v0）
 *
 * 目的（作者 2026-10-15 定）：
 *   上下文太长，模型注意不到"这个之前好像发生过""和某一处的好像"。
 *   故需要一个【专管上下文的图书管理员】：发给它一段语义，它快速检索类似内容。
 *
 * 与既有工具的分工（别混淆）：
 *   `工具\_recall-two-step.js` → 检索【项目设定库】（72 档术语表 ＋ bge-m3）
 *   本模块                     → 检索【会话上下文本身】（自己说过/想过什么）
 *   两者都用 bge-m3，但库不同。
 *
 * ── 设计依据：实测数据（2026-10-15 本机）────────────────────────
 *   embed（bge-m3，Ollama）：
 *     50 字 → 118 ms/条 ｜ 200 字 → 368 ms ｜ 500 字 → 936 ms ｜ 2000 字 → 1494 ms
 *     ⚠️ 批量【几乎不加速】（Ollama 串行）⇒ 优化只能靠【截断】与【增量】
 *   纯 CPU 比对：
 *     1058 条 × 1024 维 cosine ＋ top5 排序 → 3.4 ms
 *   ⇒ **瓶颈 100% 在 embedding，不在比对**（差 14 万倍）
 *   ⇒ 所以"分层"的收益不是速度，而是【检索质量 + 可调范围 + 增量局部性】
 *
 * ── 为什么不用 RAPTOR 原版 ────────────────────────────────────
 *   RAPTOR（ICLR 2024）用 LLM 给每个簇写摘要。本机 qwen3:4b 实测 69 秒/次
 *   ⇒ 50 个区域要一小时，不可行。
 *   **替代：用【质心向量】当区域代表 —— 零 embedding 成本，且可 O(1) 增量更新。**
 *   （新质心 = (旧质心×n + 新向量) / (n+1)）
 *
 * ── 架构（三层，后两层全部零成本）──────────────────────────────
 *   条目层：每条痕迹一个向量（唯一花钱的地方）
 *   区域层：滑窗分区 + 质心（免费）
 *   查询：embed 查询(~110ms) → 比质心选区域(亚毫秒) → 区内细查(亚毫秒)
 *
 * ⚠️ 遵守既有硬约束：输出【只报位置与相似度，不回显原文】——避免把命中内容
 *    再写回上下文造成自我喂食（见 REPORT.md §二·v4）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OLLAMA_EMBED = 'http://localhost:11434/api/embed'

/** 可调旋钮（全部可用环境变量覆盖，便于"管理范围可调"） */
export const OPTS = {
  model: process.env.LIBRARIAN_MODEL || 'bge-m3',
  snip: +(process.env.LIBRARIAN_SNIP || 50),        // 每条截断字数（实测 50 字=118ms）
  regionSize: +(process.env.LIBRARIAN_REGION || 20), // 每个区域条目数 = "管理范围"
  topRegions: +(process.env.LIBRARIAN_TOP_REGIONS || 3),
  topK: +(process.env.LIBRARIAN_TOP_K || 5),
  maxIndex: +(process.env.LIBRARIAN_MAX || 120),    // 首次索引上限（全量很慢，见文件头）
  cacheDir: process.env.LIBRARIAN_CACHE || path.join(os.homedir(), '.dsh', 'librarian-cache'),
  /**
   * ⚠️ 【近处排除半径】—— 与查询点距离 < minDist 的条目不参与检索。
   *
   * 为什么需要（2026-10-15 实测，120 条真实痕迹 / 7140 对）：
   *   距离1 的【跨kind】平均相似度 65.6%，显著高于基线（52~56%）——这是唯一的异常区。
   *   距离1 的高相似对（35 对）里：思考↔正文 24 对、正文↔思考 8 对、正文↔正文 3 对，
   *   **同为思考的 0 对**。原因是结构性的：**模型想完就说，思考与紧随的正文必然高度重合。**
   *   实证：「思考 后紧跟 正文」共 45 处，其中 24 处（53%）≥70%。
   *   ⇒ 这类配对是【正常行为】，不是"异常重复"，报出来零信息量、且会淹没真信号。
   *
   * 取值依据：
   *   minDist=1（不过滤）→ 最高相似 92.3%（噪声）
   *   minDist=2          → 最高骤降至 86.7%，之后再无变化 ⇒ 2 即理论最小值
   *   默认取 3：距离 3 的均值（57.0%）已进入平稳带，且顺带排除模型自己仍"记得"的近几轮。
   *
   * ⚠️ 排除近处【几乎不损失真实关联】：实测 265 对 ≥70% 的高相似对中，
   *   距离 ≤3 的仅占 25%，**75% 在更远处**（4-10 占 13%、11-30 占 34%、>30 占 28%）。
   *   而"隐藏超长上下文里、模型察觉不到"的东西，本来就该在远处。
   */
  minDist: +(process.env.LIBRARIAN_MIN_DIST || 3),
}

// ── embedding ────────────────────────────────────────────────
/** ⚠️ 单次请求条目数要限制：Ollama 大批量可能超时，且实测不会更快 */
const EMB_BATCH = 16

export async function embed(texts) {
  const out = []
  for (let i = 0; i < texts.length; i += EMB_BATCH) {
    const slice = texts.slice(i, i + EMB_BATCH)
    const r = await fetch(OLLAMA_EMBED, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OPTS.model, input: slice }),
    })
    if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = await r.json()
    out.push(...(j.embeddings || []))
  }
  return out
}

export function cosine(a, b) {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return d / (Math.sqrt(na) * Math.sqrt(nb))
}

export function avgVec(vecs) {
  if (!vecs.length) return []
  const d = vecs[0].length
  const s = new Float64Array(d)
  for (const v of vecs) for (let i = 0; i < d; i++) s[i] += v[i]
  const out = new Array(d)
  for (let i = 0; i < d; i++) out[i] = s[i] / vecs.length
  return out
}

// ── 区域层：滑窗分区 + 质心（全部免费）──────────────────────────
export function buildRegions(vecs, regionSize = OPTS.regionSize) {
  const regions = []
  for (let i = 0; i < vecs.length; i += regionSize) {
    const chunk = vecs.slice(i, i + regionSize)
    regions.push({
      from: i,
      to: i + chunk.length - 1,
      n: chunk.length,
      centroid: avgVec(chunk),   // ⚠️ 区域管理员的"管辖特征"，纯算术，零成本
    })
  }
  return regions
}

/** O(1) 增量：新质心 = (旧质心×n + 新向量)/(n+1) —— 新增条目不必重算整个区域 */
export function pushToRegion(region, vec) {
  const n = region.n, c = region.centroid
  const out = new Array(c.length)
  for (let i = 0; i < c.length; i++) out[i] = (c[i] * n + vec[i]) / (n + 1)
  return { ...region, to: region.to + 1, n: n + 1, centroid: out }
}

// ── 索引构建 ──────────────────────────────────────────────────
/**
 * @param acts 痕迹数组 [{kind, text}]（来自 index.js 的 recentActivity，已含「思考」）
 * @returns {index} 可直接交给 query()
 *
 * ⚠️⚠️ 【坐标系统】—— 2026-10-15 修的 bug，务必理解 ⚠️⚠️
 *   索引只收录「思考/正文」（跳过工具，省一半 embed 成本），且被 maxIndex 截断。
 *   若把【索引内序号】当指针报出去，它和 `peek()` 用的【全量痕迹序号】对不上 ——
 *   指针会指到错误的位置（同 §128"跨单位比较"那一类错误）。
 *   ⇒ 故每个 entry 记录 `globalPos`（= 在全量痕迹里的 1-based 位置），
 *     指针一律报 `globalPos`，与 peek 使用同一套坐标。
 */
export async function buildIndex(acts, { onProgress } = {}) {
  // 只要思考与正文：工具调用是 JSON，语义价值低，却占实测 501/1058
  const slots = []                                  // 全量痕迹里的下标（0-based）
  acts.forEach((a, i) => { if (a.kind === '思考' || a.kind === '正文') slots.push(i) })
  const use = slots.slice(-OPTS.maxIndex)

  /**
   * ⚠️ **覆盖度**（2026-10-15 风险审计加）：
   *   `maxIndex` 是个硬上限（默认 120，因为 embed 很贵：450ms/条）。
   *   而会话会不断变长 ⇒ 索引覆盖的比例**越来越低**：
   *     1116 条痕迹 / 上限 120 ⇒ 只覆盖最后的 **11%**。
   *   ⇒ 它不会崩，但**会静默地越来越短视**（检索从"查全程"退化成"只查最近"）。
   *     这正是我们花力气修掉的 `limit=8` 问题在 librarian 里的翻版。
   *   ⇒ 故：**把覆盖度记进索引并报出来**，低于阈值时明确提示 ——
   *     **宁可让使用者知道"只查到 11%"，也不要让它以为"查了全程"。**
   */
  const coverage = slots.length ? +(use.length / slots.length).toFixed(4) : 1
  const narrow = coverage < 0.5 && slots.length > (OPTS.maxIndex * 1.5)

  // ⚠️ 截断是为了速度：实测 50 字 118ms vs 500 字 936ms（差 8 倍）
  const texts = use.map((gi) => acts[gi].text.replace(/\s+/g, ' ').slice(0, OPTS.snip))

  const vecs = []
  for (let i = 0; i < texts.length; i += EMB_BATCH) {
    const part = await embed(texts.slice(i, i + EMB_BATCH))
    vecs.push(...part)
    onProgress?.(Math.min(i + EMB_BATCH, texts.length), texts.length)
  }

  return {
    version: 2,                       // v2：加入 globalPos 坐标（v1 的索引内序号是错的）
    model: OPTS.model,
    snip: OPTS.snip,
    regionSize: OPTS.regionSize,
    // ⚠️ 只存摘要片段，不存全文（全文按指针用 peek 取）
    entries: use.map((gi, k) => ({ kind: acts[gi].kind, snip: texts[k], globalPos: gi + 1 })),
    vecs,
    regions: buildRegions(vecs),
    // ── 视野元数据（用于告警"检索范围偏窄"）──
    coverage,                          // 本次索引覆盖了「思考+正文」候选的百分之几
    candidateTotal: slots.length,      // 候选总数（会话里有资格被索引的条数）
    indexedTotal: use.length,          // 实际索引条数（= maxIndex 上限内）
    narrow,                            // 覆盖不足一半 ⇒ true
    builtAt: new Date().toISOString(),
  }
}

// ── 查询：比质心 → 选区域 → 区内细查 ────────────────────────────
/**
 * @param opts.minDist 【近处排除半径】见 OPTS.minDist 的实测依据。
 *   语义：与查询点（= 索引末尾，即"当前正在写的位置"）距离 < minDist 的条目不参与。
 *   设为 1 即不过滤（保留全部）。
 * @param opts.anchor 查询点位置。默认 = 索引长度（当前内容尚未入库）。
 */
export async function query(index, queryText, opts = {}) {
  const topRegions = opts.topRegions ?? OPTS.topRegions
  const topK = opts.topK ?? OPTS.topK
  const minDist = Math.max(1, opts.minDist ?? OPTS.minDist)

  const n = index.entries.length
  const anchor = opts.anchor ?? n
  // 保留 i <= anchor - minDist 的条目。minDist=1 ⇒ 全部保留（不过滤）。
  const maxIdx = anchor - minDist
  const excluded = n - 1 - maxIdx            // 实际被排除的条数

  const [qv] = await embed([queryText.replace(/\s+/g, ' ').slice(0, OPTS.snip)])

  // ① 比区域质心（亚毫秒）。
  //    ⚠️ 区域若整体落在排除范围内（或已被排除殆尽），跳过 —— 否则会白扫一遍。
  const usable = []
  for (let ri = 0; ri < index.regions.length; ri++) {
    const reg = index.regions[ri]
    const lo = reg.from, hi = Math.min(reg.to, maxIdx)
    if (hi < lo) continue                        // 该区全被排除
    usable.push({ ri, reg, lo, hi, s: cosine(qv, reg.centroid) })
  }
  const ranked = usable.sort((a, b) => b.s - a.s).slice(0, topRegions)

  // ② 只进选中的区域细查（亚毫秒）
  const cands = []
  for (const r of ranked) {
    for (let i = r.lo; i <= r.hi; i++) {
      cands.push({ i, s: cosine(qv, index.vecs[i]), region: r.ri, regionScore: r.s })
    }
  }
  cands.sort((a, b) => b.s - a.s)

  return {
    top: cands.slice(0, topK).map((c) => ({
      // ⚠️ 报【全量痕迹坐标】，不是索引内序号 —— 这样与 peek() 的指针体系一致
      pos: index.entries[c.i].globalPos ?? (c.i + 1),
      kind: index.entries[c.i].kind,
      sim: +c.s.toFixed(4),
      region: c.region,
    })),
    scanned: cands.length,
    total: index.entries.length,
    excluded,                       // 因"近处排除"而未参与检索的条数
    minDist,
    // ── 视野透明（见 buildIndex 的 coverage 注释）──
    coverage: index.coverage ?? null,
    narrow: !!index.narrow,
  }
}

/**
 * 渲染成给模型看的文本。
 * ⚠️⚠️ 只报【指针 / 类别 / 相似度】，**绝不回显原文片段** ——
 *   回显 = 把命中内容写回上下文 = 下一轮又被匹配（REPORT.md §二·v4 的病因）。
 *   片段只留在缓存里供调试，不进模型视野。
 *
 * 【指针】的定位（作者 2026-10-15 定）：潜意识给的是 **decoupled familiarity** ——
 *   只有"熟悉感"（相似度），没有"回忆"（内容）。颞叶把"这事发生过"的信号发给额叶，
 *   不把内容一起送上。**要内容，得由主模型按指针主动去取**（另见 `peek`）。
 *   故输出用 `pos=N` 这种【可直接回取】的形式，而不是含糊的"某处"。
 * ⚠️ 本模板每个字都要过 leak-check（曾把判据触发词写进模板过）。
 */
export function render(result) {
  if (!result.top.length) return ''
  const lines = ['【图书管理员】以下是与你当前内容语义相近的较早位置：']
  for (const t of result.top) {
    const pct = (t.sim * 100).toFixed(0)
    const tag = pct >= 90 ? '⚠️ 高度疑似重复' : pct >= 75 ? '相关' : '略相关'
    lines.push(`- pos=${t.pos} · ${t.kind} · 相似度 ${pct}% · ${tag}`)
  }
  if (result.excluded) {
    lines.push(`（已跳过最近 ${result.excluded} 条——那些通常是你自己还记得的）`)
  }
  // ⚠️ 视野透明：索引有上限，会话越长覆盖越低 ⇒ **必须说出来**，
  //    否则使用者会以为"查了全程"。这是本项目一贯纪律：宁可暴露局限，不给虚假的完整感。
  if (result.narrow) {
    lines.push(`（⚠️ 本次检索只覆盖了会话的 ${(result.coverage * 100).toFixed(0)}%（索引上限 ${OPTS.maxIndex} 条）——更早的内容未参与检索）`)
  }
  lines.push('pos 是本次对话第几条痕迹的指针；要原文可按它回取，这里不附内容。')
  return lines.join('\n')
}

// ── 缓存：避免每次重算（这是"慢"的唯一真实来源）─────────────────
export function cachePath(sessionFile) {
  const base = path.basename(path.dirname(sessionFile))
  const h = Buffer.from(base).toString('base64url').slice(0, 24)
  return path.join(OPTS.cacheDir, `${h}.json`)
}

export function loadCache(sessionFile) {
  try {
    const p = cachePath(sessionFile)
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    // 配置变了（换模型/改截断）就必须重建，否则向量尺度对不上。
    // ⚠️ version 检查同样重要：v1 的 entries 没有 globalPos，指针会指错位置（见 buildIndex 注释）。
    if (j.version !== 2 || j.model !== OPTS.model || j.snip !== OPTS.snip) return null
    return j
  } catch { return null }
}

export function saveCache(sessionFile, index) {
  try {
    fs.mkdirSync(OPTS.cacheDir, { recursive: true })
    fs.writeFileSync(cachePath(sessionFile), JSON.stringify(index), 'utf8')
  } catch { /* 缓存失败不能影响主流程 */ }
}

// ── 可独立运行的验证入口（不依赖 DSH 运行时）─────────────────────
//   node librarian.js <sessionFile> [查询文本]
if (process.argv[1] && process.argv[1].endsWith('librarian.js')) {
  const { recentActivity } = await import('./index.js')
  const file = process.argv[2]
  const q = process.argv[3] || '这个之前好像发生过'
  if (!file) { console.log('用法: node librarian.js <sessionFile> ["查询文本"]'); process.exit(1) }

  const acts = recentActivity(file, 100000)
  console.log(`痕迹总数 ${acts.length}（思考/正文将入库）`)

  let idx = loadCache(file)
  if (idx) {
    console.log(`✅ 命中缓存：${idx.entries.length} 条，${idx.regions.length} 个区域`)
  } else {
    const t0 = Date.now()
    console.log(`建索引中…（${OPTS.maxIndex} 条上限，截断 ${OPTS.snip} 字）`)
    idx = await buildIndex(acts, {
      onProgress: (a, b) => process.stdout.write(`\r  ${a}/${b}`),
    })
    console.log(`\n✅ 建完：${idx.entries.length} 条，${idx.regions.length} 个区域，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    saveCache(file, idx)
  }

  console.log(`\n查询：「${q}」`)
  const t1 = Date.now()
  const res = await query(idx, q)
  console.log(`耗时 ${Date.now() - t1} ms ｜ 扫描 ${res.scanned} 条 ｜ 已排除最近 ${res.excluded} 条（minDist=${res.minDist}）`)
  console.log('\n' + render(res))
  // ⚠️ pos 现在是【全量坐标】，反查要按 globalPos，不能直接 entries[pos-1]
  const byPos = (p) => idx.entries.find((e) => e.globalPos === p)
  console.log('\n（调试用，不发给模型）命中片段前三：')
  for (const t of res.top.slice(0, 3)) console.log(`  pos=${t.pos} [${t.kind}] ${t.sim} → ${(byPos(t.pos)?.snip || '(未找到)').slice(0, 60)}`)

  // ── minDist 对照（用索引内真实条目当查询，看"近处排除"是否真的干掉噪声）
  if (process.argv.includes('--compare')) {
    const probe = idx.entries.length - 1        // 索引末条
    const probePos = idx.entries[probe].globalPos
    const q2 = idx.entries[probe].snip
    console.log(`\n${'═'.repeat(64)}\n【minDist 对照】用 pos=${probePos}（索引末条）当查询`)
    for (const md of [1, 2, 3, 5, 8]) {
      const r = await query(idx, q2, { minDist: md, topK: 3 })
      const top = r.top.map((t) => `${t.pos}:${(t.sim * 100).toFixed(0)}%${t.pos === probePos ? '★自身' : ''}`).join('  ')
      console.log(`  minDist=${String(md).padStart(2)}（排 ${String(r.excluded).padStart(3)} 条）→ ${top}`)
    }
    console.log('  ⚠️ 注意 minDist=1 时"★自身"必然占据第一位（100%）——这就是要排除近处的直观理由。')
  }
}
