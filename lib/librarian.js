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
import { embed as providerEmbed, providerInfo } from './provider.js'

/**
 * ⚠️ 嵌入后端**不再写死**（2026-10-16 改，作者要求"做成能替代的"）。
 *   原先是 `const OLLAMA_EMBED = 'http://localhost:11434/api/embed'` —— **硬编码**，
 *   ⇒ 想换云端 API（DeepSeek／OpenAI）或 vLLM／LM Studio **都做不到**。
 *   ⇒ 现统一走 `lib/provider.js`：换后端**只改配置，不改代码**。
 *   ⚠️ 向后兼容：老的 `LIBRARIAN_MODEL` 与 `OLLAMA_HOST` 仍然有效（在 provider 里映射）。
 */
const PROVIDER = providerInfo()

/** 可调旋钮（全部可用环境变量覆盖，便于"管理范围可调"） */
export const OPTS = {
  // ⚠️ 模型名由 **provider** 决定（它已兼容老的 LIBRARIAN_MODEL）
  model: PROVIDER.embedModel,
  snip: +(process.env.LIBRARIAN_SNIP || 50),        // 每条截断字数（实测 50 字=118ms）
  regionSize: +(process.env.LIBRARIAN_REGION || 20), // 每个区域条目数 = "管理范围"
  topRegions: +(process.env.LIBRARIAN_TOP_REGIONS || 3),
  topK: +(process.env.LIBRARIAN_TOP_K || 5),
  /**
   * ⚠️⚠️ 【已改名，含义变了 2026-10-16】原 `maxIndex` = **硬上限**，默认 120。
   *   实测（147 个真实会话）证明它是本项目最大的能力瓶颈：
   *     · 最大会话 26.75MB ⇒ 候选 **2593** 条，120 条上限 ⇒ 覆盖 **4.6%**
   *     · 最大的 14 个会话里，候选 ≤120 的有 **0 个**；候选中位数 **627**
   *   ⇒ 也就是说：在真实使用中，它**只看得见会话的 5%~15%**，
   *     "这个之前好像发生过"对**早期内容从制度上不可能成立**。
   *
   * ⚠️ 为什么小会话没暴露这个问题：小会话候选数本来就 <120 ⇒ 覆盖 100%。
   *   缓存里 21/25 个索引覆盖率是 100% ⇒ 造成"已经很好了"的**幸存者偏差**。
   *
   * ⚠️ 为什么现在敢放开：`buildIndexIncremental` 的复用键是 `globalPos`+`snip`，
   *   而本文件一律用 **"从缺口的早端按绝对 pos 连续填"** 取数 ⇒ 提高预算时，
   *   已索引条目的 `globalPos` **一个都不动** ⇒ 旧向量 **100% 可复用**，
   *   **不存在"白建"**。（这正是"只增不减"的安全前提，不要改成随机抽样。）
   *
   * ⇒ 现在它是**预算**（长期要索引多少条），配合 `fillStep` **逐轮补齐**：
   *   每轮只补 `fillStep` 条，后台 fire-and-forget ⇒ 一轮 ~2 分钟，不卡使用者。
   * ⚠️ 故 `budget` **不是**"一次要等到位的量"，调大它不会让单轮变慢，只会多补几轮。
   */
  budget: +(process.env.LIBRARIAN_MAX || process.env.LIBRARIAN_BUDGET || 1200),
  /** 每轮后台最多补多少条（= 单轮时间闸门；实测 embed 0.36~0.83 s/条 ⇒ 300 条约 2~4 分钟） */
  fillStep: +(process.env.LIBRARIAN_FILL_STEP || 300),
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

// ── 候选取数（★ 唯一口径，buildIndex 与 buildIndexIncremental 共用）──
/**
 * ⚠️⚠️ **这个函数是"索引口径"的单一真相源，两个构建路径必须用同一个。**
 *   本文件的历史注释已经写明："两边口径一旦不同，'复用'就会变成'悄悄换成了另一批条目'"。
 *
 * ══ 取数规则（2026-10-16 重写）══════════════════════════════════
 *   ① "思考/正文" 才入库（工具调用是 JSON，语义价值低，却占实测约一半）—— 不变。
 *   ② 在【预算内】优先保留**最近**的条目（最近的最常被"想起来"）。
 *   ③ 但**旧索引已经建过的位置，绝对不丢**（否则等于白建，见 OPTS.budget 注释）。
 *   ④ 剩下的缺口**从最早的开始、依次向晚填**，每轮只填 `fillStep` 条。
 *
 *   ⇒ 效果：第 1 轮索引最近的一段；第 2 轮往前推 300 条；…若干轮后覆盖全程。
 *   ⇒ 为什么必须"从早往晚按绝对 pos 连续填"：这样新加的条目只会**扩展**已索引集合，
 *      `globalPos` 永远不动 ⇒ 增量复用永远成立。**改成随机抽样就不成立了。**
 *
 * @returns {{slots:number[], use:number[], indexedPos:Set<number>, complete:boolean, missing:number}}
 *   `slots`=全部候选（0-based 全量下标）｜`use`=本次要入库的（升序）｜`complete`=是否已覆盖全部候选
 */
export function selectSlots(acts, old = null, budget = OPTS.budget, fillStep = OPTS.fillStep) {
  const slots = []
  acts.forEach((a, i) => { if (a.kind === '思考' || a.kind === '正文') slots.push(i) })

  // 旧索引建过的**绝对位置**（globalPos 是 1-based，见 buildIndex 的坐标系统注释）
  const indexedPos = new Set()
  if (old && Array.isArray(old.entries)) {
    for (const e of old.entries) if (e && typeof e.globalPos === 'number') indexedPos.add(e.globalPos - 1)
  }

  const total = slots.length
  if (!total) return { slots, use: [], indexedPos, complete: true, missing: 0 }

  // 已建过的位置 = 上轮**全部** entries（"只增不减"就体现在这一行）
  const oldSize = old ? indexedPos.size : 0

  /**
   * ══════════ 【唯一约束：本轮真正新 embed 的条数 ≤ `fillStep`】══════════
   *
   * 想清楚这一条，其余都是它的推论：
   *   · 窗口**扩大** 1 条 ⇒ 多 1 条"从没建过"的条目进 `use` ⇒ 吃掉 1 条额度
   *   · **补历史** 1 条   ⇒ 同样吃掉 1 条额度
   *   ⇒ 两者**抢同一个额度**。我前七版都栽在这一句上：各给一份额度 ⇒ 单轮成本 = 两份之和
   *     ⇒ 检查报 `newlyBuilt > 一步`（被抓住七次，是检查而不是推理让我看清的）。
   *
   * ⚠️ 额度该给谁：**补历史先拿，剩下的才给扩窗口**。
   *   反过来（窗口先拿）会让窗口吃光额度、补历史彻底停滞 —— 实测卡在 400/900、40 轮不收敛。
   * ⚠️ 另一条同样致命的推论：**已建过的条目一律不许丢**（`indexedPos` 必须进最终结果）。
   *   丢了就会被当成"缺口"重新 embed（白花钱），且索引条数会永远停在窗口大小。
   */
  const indexed = [...indexedPos]
  const missingAll = slots.filter((s) => !indexedPos.has(s))     // 从没建过的（升序 = 由早到晚）

  /**
   * 窗口 = 最近 `min(budget, total)` 条。
   *   ⚠️ 不要在这里"每轮只长一点"：窗口小了 ⇒ 最近的内容被挤出索引 ⇒
   *     "最该记得的最近内容反而查不到"，方向正好反了。
   *     窗口里的**旧条目**不额外花成本（它们已在 `indexedPos` 里，向量直接复用），
   *     只有"从没建过"的那些才吃额度 —— 那是会话真实增长的量，本来就很小。
   */
  const winSize = Math.min(budget, total)
  const win = slots.slice(-winSize)

  // 缺口的两个来源：① 窗口里"从没建过"的（= 最近的内容，最要紧）② 更早的历史
  const winNew = win.filter((s) => !indexedPos.has(s))            // 升序；末尾 = 最新
  const winNewSet = new Set(winNew)
  const histGap = missingAll.filter((s) => !winNewSet.has(s))     // 升序；开头 = 最早

  /**
   * ⚠️ 两者**共享** `fillStep` 这一个额度（各给一份 ⇒ 单轮成本翻倍，检查抓住七次）。
   *   分配顺序：**先把"最近的内容"填满，余量全给历史**。
   *
   *   ⚠️ 为什么窗口优先：使用者最需要想起来的是**最近发生的事**；
   *     而历史缺口**在后续轮次会继续补**，不会丢（`histNow` 每轮都从最早端推进）。
   *   ⚠️ 为什么**不**给窗口设个 `fillStep/2` 的额度上限：实测那样"最近的内容"要
   *     好几轮才补齐（检查报"把最近 250 条挤出了索引"、逐轮递减 250→200→…→50），
   *     而这段时间里它恰恰答不出"刚才那件事"。窗口缺口一次填满，之后每轮只剩增长量，
   *     额度自然全给历史 —— **不需要人为配额，让额度自己流动**。
   */
  const winQuota = Math.min(winNew.length, fillStep)
  const winNow = winNew.slice(-winQuota)                          // 取**最新**的 winQuota 条
  const histNow = histGap.slice(0, fillStep - winNow.length)      // 余量给最早的历史

  const chosen = new Set([...indexed, ...winNow, ...histNow])
  const use = [...chosen].sort((a, b) => a - b)
  const totalCand = slots.length
  return {
    slots, use, indexedPos,
    complete: use.length >= totalCand,
    missing: Math.max(0, totalCand - use.length),
  }
}

// ── embedding ────────────────────────────────────────────────
/** ⚠️ 单次请求条目数要限制：Ollama 大批量可能超时，且实测不会更快 */
const EMB_BATCH = 16

/**
 * 嵌入（对外签名不变）—— 内部**转发给 `provider.js`**。
 * ⚠️ 仍然分批：本机嵌入后端一次吃太多可能超时，且实测不会更快。
 */
export async function embed(texts) {
  const out = []
  for (let i = 0; i < texts.length; i += EMB_BATCH) {
    const part = await providerEmbed(texts.slice(i, i + EMB_BATCH))
    out.push(...part)
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
export async function buildIndex(acts, { onProgress, old = null } = {}) {
  // ⚠️ 取数一律走 selectSlots（唯一口径）—— 不要再在这里自己 slice，
  //    那样两个构建路径的口径就会分叉（历史注释已警告过）。
  const { slots, use, complete, missing } = selectSlots(acts, old)

  /**
   * ⚠️ **覆盖度**（2026-10-15 加，2026-10-16 修正判据）：
   *   `budget` 是**长期预算**，配合 `fillStep` **逐轮补齐**（见 OPTS.budget 注释）。
   *   关键是**别让使用者以为"查了全程"** ⇒ 只要没补齐，就必须报出真实比例。
   *
   * ⚠️ 第一版的 `narrow` 判据是 `coverage < 0.5 && slots.length > maxIndex * 1.5` ——
   *   **这个条件永远为假**：`coverage < 0.5` 要求 `slots > 2×maxIndex`，
   *   而右边要求 `slots > 1.5×maxIndex`，前者已经蕴含后者，可惜 `&&` 两边是
   *   同一个变量的两个不等式，第二个**必然**已满足……真正的问题是：
   *   一旦 `slots > 2×budget`，`coverage` 就恒 ≥ 0.5 吗？不是 ——
   *   实测 2593/120 ⇒ coverage=0.046 < 0.5 且 2593 > 180，两边都真，
   *   但旧默认 budget=120 时会报 true；换个 budget 就不报了。
   *   ⇒ 判据不该依赖预算，只该依赖**事实**：没补齐 ⇒ 就报。
   */
  const coverage = slots.length ? +(use.length / slots.length).toFixed(4) : 1
  const narrow = !complete || coverage < 0.9999

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
    coverage,
    candidateTotal: slots.length,
    indexedTotal: use.length,
    narrow,
    // ★ 补齐进度（2026-10-16 加）：还差多少条没进索引 —— 没有它，"补完了没"就只能靠感觉
    missing: missing ?? 0,
    complete: !!complete,
    builtAt: new Date().toISOString(),
  }
}

/**
 * ★ 增量重建（2026-10-16 加）——**为什么这件事最要紧**：
 *
 *   会话是**活的**，一直长；而 `maxIndex`=120 个槽位里，绝大多数条目**没变**。
 *   旧做法每次都把那 120 条**全部**重算 embed，本机实测（CPU 跑 bge-m3）
 *   **一条 358~828 ms ⇒ 一次重建约 99 秒**。而 `cacheState` 的 stale 阈值是"长了 50%"，
 *   小会话很容易触发 ⇒ **每轮都在后台烧 99 秒**，而且追不上会话增长。
 *
 *   ⇒ 但**同一位置、同一段文本**的条目，向量必然一样 —— 直接复用旧向量。
 *   ⇒ 只对新增/变化的条目 embed。例：旧 120 条 + 新增 40 条
 *     ⇒ 嵌 40 条（约 33 秒）而不是 120 条（约 99 秒）。
 *
 * ⚠️ 复用的**匹配键必须是 `globalPos` + `snip` 两者**：
 *   · 只比 `globalPos` ⇒ 同一位置若文本变过（排查中改过会话文件）会**用错向量**；
 *   · 只比 `snip`     ⇒ 重复文本会互相顶替。
 * ⚠️ 复用的条目**一律取新值**（`kind`/`snip`/`globalPos`），只有**向量**沿用旧的。
 * ⚠️ `model`/`snip`/`regionSize` 任一变了就不能复用 —— 由调用方（`ensureIndex`）先判。
 *
 * @param {Array} acts 全量痕迹（与 `buildIndex` 同一套输入）
 * @param {object|null} old 旧索引（null ⇒ 退化成全量）
 * @returns {Promise<{index:object, reused:number, embedded:number}>}
 */
export async function buildIndexIncremental(acts, old, { onProgress } = {}) {
  // ⚠️⚠️ 候选选取**必须与 buildIndex 同一套口径** —— 故调同一个函数，
  //    绝不在这里自己 slice。（历史注释：口径一旦分叉，"复用"就变成"悄悄换了一批条目"。）
  const { slots, use, complete, missing } = selectSlots(acts, old)
  const texts = use.map((gi) => acts[gi].text.replace(/\s+/g, ' ').slice(0, OPTS.snip))

  const oldVec = new Map()
  if (old && Array.isArray(old.entries) && Array.isArray(old.vecs)) {
    for (let i = 0; i < old.entries.length; i++) {
      const e = old.entries[i]
      if (e && e.snip) oldVec.set(String(e.globalPos) + '\u0000' + e.snip, old.vecs[i])
    }
  }

  const vecs = new Array(texts.length)
  const todo = []                       // 需要新算的下标
  for (let k = 0; k < texts.length; k++) {
    const v = oldVec.get(String(use[k] + 1) + '\u0000' + texts[k])
    if (v) vecs[k] = v
    else todo.push(k)
  }

  for (let i = 0; i < todo.length; i += EMB_BATCH) {
    const batch = todo.slice(i, i + EMB_BATCH)
    const part = await embed(batch.map((k) => texts[k]))
    batch.forEach((k, j) => { vecs[k] = part[j] })
    onProgress?.(Math.min(i + EMB_BATCH, todo.length), todo.length)
  }

  const coverage = slots.length ? +(use.length / slots.length).toFixed(4) : 1
  const narrow = !complete || coverage < 0.9999
  const index = {
    version: 2,
    model: OPTS.model,
    snip: OPTS.snip,
    regionSize: OPTS.regionSize,
    entries: use.map((gi, k) => ({ kind: acts[gi].kind, snip: texts[k], globalPos: gi + 1 })),
    vecs,
    regions: buildRegions(vecs),
    coverage,
    candidateTotal: slots.length,
    indexedTotal: use.length,
    narrow,
    missing: missing ?? 0,
    complete: !!complete,
    builtAt: new Date().toISOString(),
    // ⚠️ **留痕**：这一次复用多少、新算多少 —— 没有它，"增量生效了吗"就只能靠感觉
    //    （硬规则 2：降级要留痕；反过来说：**优化也要留痕**，否则没法证明它真的起作用）
    incremental: { reused: texts.length - todo.length, embedded: todo.length },
  }
  return { index, reused: texts.length - todo.length, embedded: todo.length }
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

  /**
   * ⚠️⚠️ 【必须挡"没有索引" —— 2026-10-17 由 `tools/check-robustness.mjs` 测出的真 bug】
   *
   *   `query()` 的第一句是 `index.entries.length`，而调用方**可能传 undefined**：
   *     · `lib/fok.js:120` 与 `lib/novelty.js:101` 直接 `librarianQuery(index, ...)` 透传，
   *       **没有任何守卫** ⇒ 索引还没建好时（`loadCache` 返回 null）直接抛 TypeError。
   *     · 对比：`lib/report.js:251/314` 都有 `if (idx)` / `if (!oIdx)` ⇒ 那两处是安全的。
   *   ⇒ 同一个 API，一半调用方挡了、一半没挡 ⇒ **该在 API 自己身上挡**（否则下一个调用方还会忘）。
   *
   * ⚠️ 返回值形状必须与正常返回**一致**（`scanned/excluded/minDist/total/top/coverage/narrow`），
   *   否则调用方（`assess`/`renderFok`）会因字段缺失而二次崩。
   * ⚠️ 并且**要说清是"没检索"而不是"没找到"**（硬规则 1）—— 这两件事对使用者的含义完全相反。
   */
  if (!index || !Array.isArray(index.entries)) {
    return {
      reason: index ? '索引结构不对（entries 不是数组）' : '还没有索引：本次**没有检索**（不是"没找到"）',
      noIndex: true,
      top: [], scanned: 0, excluded: 0, minDist,
      total: 0, coverage: null, narrow: null,
      indexedTotal: null, candidateTotal: null, missing: null, complete: null,
    }
  }

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
    // ★ 补齐进度（2026-10-16 加）：会话很长时索引是**逐轮补**的，
    //   不说清楚"还差多少"，使用者会以为"它已经查了全程，却什么都没找到" ——
    //   那正好是硬规则 4（「找不到」≠「不存在」）要防的误判。
    indexedTotal: index.indexedTotal ?? index.entries?.length ?? null,
    candidateTotal: index.candidateTotal ?? null,
    missing: index.missing ?? null,
    complete: index.complete ?? null,
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
  // ★ 跨对话（语境区）与单对话的**标题不同** —— 使用者看到的差别必须一眼可辨，
  //   否则他会以为"这些命中都在当前这场里"（2026-10-16 接口线时加）
  const cross = !!result.cross
  const lines = [cross
    ? '【跨对话回忆】以下是你在**别的对话**里说过、与当前内容语义相近的位置：'
    : '【图书管理员】以下是与你当前内容语义相近的较早位置：']
  for (const t of result.top) {
    const pct = (t.sim * 100).toFixed(0)
    const tag = pct >= 90 ? '⚠️ 高度疑似重复' : pct >= 75 ? '相关' : '略相关'
    // ⚠️ 跨对话时**必须标明来自哪一场** —— 这是作者点出的"会记串"那一条弊的唯一防线：
    //    三月的决定和今天的结论被一起端上来时，**没有来源标注就变成错误信息**。
    const from = cross && t.fromContext ? ` · 来自【${t.fromContext}】` : ''
    lines.push(`- pos=${t.pos} · ${t.kind}${from} · 相似度 ${pct}% · ${tag}`)
  }
  if (cross) {
    // 提醒"这是回忆，不是当前事实" —— 跨对话最容易犯的错是把旧的当现在的
    lines.push('（⚠️ 这些来自别的对话，**可能是你后来已经改掉的想法** —— 用它之前先确认现在还算不算数）')
  }
  if (result.excluded) {
    lines.push(`（已跳过最近 ${result.excluded} 条——那些通常是你自己还记得的）`)
  }
  // ⚠️ 视野透明：索引是**逐轮补齐**的，会话越长补得越久 ⇒ **必须说出真实进度**，
  //    否则使用者会以为"查了全程"（或反过来以为"它什么都没找到"）。
  //    这是本项目一贯纪律：宁可暴露局限，不给虚假的完整感。
  // ⚠️ 措辞里**不要**出现"上限"——那个词会被读成"就这样了，不会变好"。
  //    实际语义是"正在补，还差 N 条"，方向是**变好**。
  if (result.narrow && result.coverage !== null) {
    const cov = (result.coverage * 100).toFixed(0)
    const miss = result.missing === null || result.missing === undefined ? '?' : result.missing
    const done = result.complete === true
    lines.push(done
      ? `（本次检索已覆盖本场对话的全部可索引内容，共 ${result.indexedTotal} 条）`
      : `（⚠️ 本次检索只覆盖了本场对话的 ${cov}%（已索引 ${result.indexedTotal} / ${result.candidateTotal} 条，` +
        `还差约 ${miss} 条正在后台逐步补）——**更早的内容尚未参与检索，所以"这里没提到"不等于"从没发生"**）`)
  }
  lines.push(cross
    ? 'pos 是**那一场对话**里第几条痕迹的指针；要原文得去那一场按 pos 回取，这里不附内容。'
    : 'pos 是本次对话第几条痕迹的指针；要原文可按它回取，这里不附内容。')
  return lines.join('\n')
}

// ── 缓存：避免每次重算（这是"慢"的唯一真实来源）─────────────────
export function cachePath(sessionFile) {
  const base = path.basename(path.dirname(sessionFile))
  const h = Buffer.from(base).toString('base64url').slice(0, 24)
  return path.join(OPTS.cacheDir, `${h}.json`)
}

/**
 * ⚠️ 缓存**状态判定 —— 单一真相源**（2026-10-16 重构）。
 *
 * 为什么要抽出来：`loadCache` 只回答"能不能用"，而调用方（`report.js`）还需要
 * 知道「**为什么不能用**」。实测踩到：当前会话**建过**索引、只是长过了 50%，
 * 而报告却写「**未建索引**」—— 把那件事引向了错误的排查方向。
 *
 * @returns {{state:'ok'|'missing'|'stale'|'unreadable', detail:string}}
 */
export function cacheState(sessionFile) {
  const p = cachePath(sessionFile)
  if (!fs.existsSync(p)) return { state: 'missing', detail: '从未建过索引' }
  let j
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) {
    return { state: 'unreadable', detail: (e?.message || String(e)) }
  }
  // 配置变了（换模型 / 改截断）就必须重建，否则向量尺度对不上。
  // ⚠️ version 检查同样重要：v1 的 entries 没有 globalPos，指针会指错位置。
  if (j.version !== 2 || j.model !== OPTS.model || j.snip !== OPTS.snip) {
    return { state: 'stale', detail: '配置变了（模型或截断长度与建档时不同）' }
  }
  // ⚠️ 只在【缓存比当前配置能用的**还少**】时才重建（用 `<`，不是 `!==`）——
  //    第一版写 `!==`，会把「花几分钟建的大索引」在默认配置下判失效 ⇒ **等于白建**（实测抓到）。
  //    "缓存更大"没有坏处（只是多索引了些条目）；缓存更小 ⇒ 用户想要更多覆盖 ⇒ 该重建。
  // ⚠️⚠️ 【2026-10-16 改】原来的判据是 `j.maxIndex < OPTS.maxIndex ⇒ stale`。
  //   那个判据把「索引比预算小」当成了「必须**全量**重建」—— 但这不是事实：
  //   本文件取数一律按**绝对 pos** 填（见 selectSlots），提高预算时
  //   已索引条目的 globalPos **一个都不动** ⇒ 旧向量仍然 100% 有效。
  //   ⇒ 旧判据的代价是实测过的：预算从 120 提到 1200 那天，
  //     147 个会话会**同时**被判 stale ⇒ 每个都全量重算（1200 条 ≈ 8~17 分钟）
  //     ⇒ 使用者会看到"它突然变得特别慢"，而这完全没必要。
  //   ⇒ 现在分两态：**partial**（可增量补齐，只补缺口）／**stale**（参数变了，真得全量）。
  if (j.complete === false || (typeof j.missing === 'number' && j.missing > 0)) {
    return {
      state: 'partial',
      detail: `已索引 ${j.indexedTotal ?? j.entries?.length ?? '?'} / ${j.candidateTotal ?? '?'} 条，` +
        `还差约 ${j.missing ?? '?'} 条（可增量补齐）`,
      indexedTotal: j.indexedTotal, candidateTotal: j.candidateTotal, missing: j.missing,
    }
  }
  if (j.maxIndex !== undefined && j.maxIndex < (j.candidateTotal ?? Infinity)) {
    // 旧格式缓存（没有 complete/missing 字段）：只说明"当时预算比候选少"，
    // **不构成全量重建的理由** ⇒ 同样走增量补齐。
    return {
      state: 'partial',
      detail: `索引建于预算 ${j.maxIndex} 时，候选 ${j.candidateTotal ?? '?'} 条（可增量补齐）`,
      indexedTotal: j.indexedTotal, candidateTotal: j.candidateTotal,
    }
  }
  if (j.srcBytes !== undefined) {
    // ⚠️ **会话是活的，一直在长** ⇒ 不能"大小不等就失效"（那会让活动会话**永远查不了**，
    //    比"用一份稍旧的索引"更糟）。⇒ 只在长得太多时算过期；其余照用。
    const staleGrowth = +(process.env.LIBRARIAN_STALE_GROWTH || 1.5)
    try {
      const now = fs.statSync(sessionFile).size
      if (j.srcBytes > 0 && now > j.srcBytes * staleGrowth) {
        return {
          state: 'stale',
          detail: `会话从 ${(j.srcBytes / 1048576).toFixed(1)}MB 长到 ${(now / 1048576).toFixed(1)}MB` +
            `（超过 ${((staleGrowth - 1) * 100).toFixed(0)}%）`,
        }
      }
    } catch { return { state: 'unreadable', detail: '会话文件读不到' } }
  }
  return { state: 'ok', detail: `${j.entries?.length ?? '?'} 条`, builtAt: j.builtAt }
}

/**
 * 拿可用的索引。
 * ⚠️⚠️ 【2026-10-16 改】原来写的是 `cacheState().state !== 'ok' ⇒ null` ——
 *   `partial` 态（= 会话很长、只补了一部分）**同样返回 null** ⇒ 后果是：
 *   `ensureIndex` 拿到 `old = null` ⇒ **退化成全量重建**，逐轮补齐**根本不成立**。
 *   ⇒ 这是"补齐机制会不会真的生效"的**唯一开关**，改这里之前先想清楚上面那句话。
 *   ⇒ 现在只有「真不能用」（读不动 / 缺文件）才返回 null；
 *     `partial` 的索引用处**完全有效**，只是视野窄一些（覆盖度会如实报出来）。
 */
export function loadCache(sessionFile) {
  const st = cacheState(sessionFile)
  if (st.state === 'missing' || st.state === 'unreadable') return null
  try { return JSON.parse(fs.readFileSync(cachePath(sessionFile), 'utf8')) } catch { return null }
}

export function saveCache(sessionFile, index) {
  try {
    fs.mkdirSync(OPTS.cacheDir, { recursive: true })
    // ⚠️ 盖上"建档时的现场"：源文件大小 ＋ **实际索引条数**。
    //    没有这两样，`loadCache` 就无从判断这份索引是否过期（2026-10-16 修，见 TODO §13）。
    // ⚠️ 【2026-10-16 改】原来写的是 `maxIndex: OPTS.maxIndex`（= **预算**，1200）。
    //    那是**记账记错了**：预算不是"这份索引有多少条"，实际条数才是。
    //    记成预算的后果：索引明明只建了 420 条，缓存却声称"我是按 1200 建的"
    //    ⇒ `cacheState` 再也看不出它没补齐 ⇒ **补齐机制会以为自己已完成**。
    //    ⇒ 现在一律记**实际条数**（entries 的长度）。
    let srcBytes
    try { srcBytes = fs.statSync(sessionFile).size } catch { srcBytes = undefined }
    const stamped = {
      ...index, srcBytes, maxIndex: index.entries?.length ?? OPTS.budget,
      savedAt: new Date().toISOString(),
    }
    fs.writeFileSync(cachePath(sessionFile), JSON.stringify(stamped), 'utf8')
  } catch (e) {
    // ⚠️ §239：降级可以，**降级必须留痕** —— 缓存没写成就等于"下次还要再建一遍"，
    //   而那要几分钟，使用者会以为它坏了 / 或者根本没注意。
    console.warn('[alert-inject/librarian] ⚠️ 索引缓存写入失败（下次会重建）：', e?.message || e)
  }
}

/**
 * ⚠️ **确保索引可用** —— 没有就建、过期就重建（2026-10-16 加）。
 *
 * ══ 为什么必须有它（实测踩到，见 TODO 第 13 项）══════════════════════
 *   之前的行为：缓存过期 ⇒ `loadCache` 返回 `null` ⇒ `report.js` 记一句 skipped 就完了
 *   ⇒ **索引从此永远不会被重建** ⇒「**这个之前好像发生过**」**静默消失**，
 *     而没有任何人会去手动重建。
 *   ⇒ 这正是本项目最忌的一类：**功能自己关掉了，而使用者只看到"没问题"**。
 *
 * ══ ⚠️ 调用方**不要 await** ═══════════════════════════════════════
 *   重建要 **35 秒（120 条）到数分钟（1000 条）**，
 *   `await` 它会把**自查本身卡死** —— 那就把工具变成不可用了。
 *   ⇒ 它的用法是 **fire-and-forget**（与 `bootstrap` 同一条思路）：
 *     这一轮记一句"正在后台重建"，下一轮自查就能用上新索引。
 *
 * ⚠️ 同进程内防并发（`_building`）；失败只回报、**绝不抛**。
 */
const _building = new Set()
export async function ensureIndex(sessionFile, { onLog } = {}) {
  const st = cacheState(sessionFile)
  // ⚠️ 只有 **ok**（= 已覆盖全部候选）才直接返回。
  //    `partial` 态**必须继续往下走** —— 它正是"逐轮补齐"要处理的唯一情形；
  //    这里一旦 early-return，补齐机制就永远不会启动（旧代码的 `state !== 'ok'` 会这样）。
  if (st.state === 'ok') return { ok: true, rebuilt: false, state: st }
  if (st.state === 'unreadable') return { ok: false, rebuilt: false, state: st }  // 读不动就别写（可能别处正写）
  if (_building.has(sessionFile)) return { ok: true, rebuilt: false, state: st, busy: true }
  _building.add(sessionFile)
  const t0 = Date.now()
  try {
    const { recentActivity } = await import('./index.js')
    const acts = recentActivity(sessionFile, 0)
    if (!acts.length) {
      return { ok: false, rebuilt: false, state: st, error: '读不到痕迹（会话为空或读不动）' }
    }
    onLog?.(`开始重建（${st.detail}）…`)
    // ★ 先试**增量**：旧索引还能用时，只对新增/变化的条目 embed（2026-10-16 加）。
    //   ⚠️ 能不能复用由这三项决定 —— 它们变了，旧向量就是**错的**，必须全量重算：
    const old = loadCache(sessionFile)
    const canReuse = !!(old && old.model === OPTS.model && old.snip === OPTS.snip
      && old.regionSize === OPTS.regionSize && Array.isArray(old.vecs))
    let idx, reused = 0, embedded = 0
    if (canReuse) {
      const r = await buildIndexIncremental(acts, old, {
        onProgress: (a, b) => onLog?.(`增量 ${a}/${b}`),
      })
      idx = r.index
      reused = r.reused
      embedded = r.embedded
      // 留痕到索引里，供界面/报告说清"这次到底算了多少"
      idx.reusedFrom = old.builtAt || null
    } else {
      onLog?.(old ? '配置变了（模型/截断/区域）⇒ 全量重算' : '没有旧索引 ⇒ 全量重算')
      // ⚠️ 即使走"全量"分支，也把 old 传进去 —— selectSlots 会沿用"已建过的位置不丢"，
      //    故它不会比旧索引**更窄**（旧代码传 undefined ⇒ 可能把已建的那些又丢回去）。
      idx = await buildIndex(acts, { old })
    }
    saveCache(sessionFile, idx)
    const ms = Date.now() - t0
    // ⚠️ 把「补到哪了」一并回报 —— 补齐是**多轮**的事，不说进度使用者无法判断"还要等几轮"
    return {
      ok: true, rebuilt: true, entries: idx.entries.length, regions: idx.regions?.length, ms,
      reused, embedded, incremental: canReuse,
      complete: !!idx.complete, missing: idx.missing ?? 0,
      coverage: idx.coverage, indexedTotal: idx.indexedTotal, candidateTotal: idx.candidateTotal,
    }
  } catch (e) {
    return { ok: false, rebuilt: false, state: st, error: e?.message || String(e) }
  } finally {
    _building.delete(sessionFile)
  }
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
    // ⚠️ 说清"是不是补齐了" —— 只报条数会让使用者以为这就是全部（硬规则 4）
    const cov = idx.coverage !== null && idx.coverage !== undefined ? `（覆盖 ${(idx.coverage * 100).toFixed(0)}%）` : ''
    const miss = idx.complete === false ? `，还差约 ${idx.missing ?? '?'} 条待补` : '，已覆盖全部候选'
    console.log(`✅ 命中缓存：${idx.entries.length} 条，${idx.regions.length} 个区域${cov}${miss}`)
  } else {
    const t0 = Date.now()
    // ⚠️ 这里原来写 `${OPTS.maxIndex}` —— 那个字段在 2026-10-16 的改写里已被删掉，
    //    不改就会打印 "undefined 条上限"（**静默失效的文案**，使用者看到只会更迷惑）。
    const cands = acts.filter((a) => a.kind === '思考' || a.kind === '正文').length
    console.log(`建索引中…（候选 ${cands} 条，本轮最多新嵌 ${OPTS.fillStep} 条，预算 ${OPTS.budget}，截断 ${OPTS.snip} 字）`)
    idx = await buildIndex(acts, {
      onProgress: (a, b) => process.stdout.write(`\r  ${a}/${b}`),
    })
    console.log(`\n✅ 建完：${idx.entries.length} 条，${idx.regions.length} 个区域，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      (idx.complete ? '（已覆盖全部候选）' : `（覆盖 ${(idx.coverage * 100).toFixed(0)}%，还差约 ${idx.missing} 条待补）`))
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
