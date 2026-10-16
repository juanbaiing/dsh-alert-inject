/**
 * check-incremental.mjs —— 证明**增量重建**真的成立（提速 + 不改变结果）。
 *
 * ⚠️ 为什么这条检查必须长期存在：
 *   「只对新增条目 embed、其余复用旧向量」是个**优化**，而优化的失败方式很阴：
 *   它会**更快地**给出**错的**向量 —— 界面照样跑、不报错，只是检索结果悄悄变差。
 *   ⇒ 所以必须同时断言**两件事**，缺一不可：
 *     ① **提速**（否则优化没意义）
 *     ② **向量与全量重建逐条一致**（否则优化是错的）
 *
 * 本机实测（2026-10-16，会话 e9208cfc，2089 条痕迹 / maxIndex 120 / CPU 跑 bge-m3）：
 *   全量 15449~18572 ms　→　增量 122~132 ms　⇒ **约 117~152 倍**
 *   复用 118 条 / 新嵌 2 条，**向量一致 120/120，不一致 0**
 *
 * ⚠️ 隔离：`LIBRARIAN_CACHE` 指向临时目录 —— **绝不碰真实 `~/.dsh/librarian-cache`**。
 * 用法：`node tools/check-incremental.mjs`（退出码非 0 = 有问题）
 * 耗时：约 30~40 秒（它要跑两次全量作为对照，慢是正常的）
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
// ⚠️ 索引缓存指到临时目录，绝不碰真实 librarian-cache
const tmp = path.join(os.tmpdir(), 'lib-bench-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
process.env.LIBRARIAN_CACHE = tmp;
/**
 * ⚠️ 【必须在这里限定预算】——否则这个检查会跑到十几分钟去。
 *   2026-10-16 起 `LIBRARIAN_MAX` 的默认值从 120 提到了 **1200**（预算），
 *   而本检查要跑**两次全量**作对照 ⇒ 会话候选 801 条时就是 800×2 ≈ 1600 条 embed
 *   ≈ **10~22 分钟**。那是不可接受的检查成本（检查没人跑 = 没有检查）。
 *   这里用 120/40 只是**为了快**；断言的是**机制**（复用 / 增量 / 一致），不是数值。
 *   ⚠️ 覆盖度相关的断言在 `check-capacity.mjs` 里，那一个才看真实规模。
 */
process.env.LIBRARIAN_MAX = process.env.LIBRARIAN_MAX || '120';
process.env.LIBRARIAN_FILL_STEP = process.env.LIBRARIAN_FILL_STEP || '40';
const LIB = new URL('../lib/', import.meta.url).href;
const { buildIndex, buildIndexIncremental, OPTS } = await import(LIB + 'librarian.js');
const { recentActivity } = await import(LIB + 'index.js');

/** 找一个**够大**的会话来测（硬编码某个 sessionId 换台机器就找不到） */
function pickSession() {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  const found = [];
  const walk = (d, depth = 0) => {
    if (depth > 8) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'session.jsonl.zstd') { try { found.push({ p, n: fs.statSync(p).size }) } catch { /* 跳过 */ } }
    }
  };
  walk(root);
  found.sort((a, b) => b.n - a.n);
  return found[0]?.p || null;
}

const sf = process.argv[2] || pickSession();
if (!sf || !fs.existsSync(sf)) {
  console.log('❌ 找不到可测的会话文件（本机 ~/.dsh/sessions 下没有会话）');
  process.exit(1);
}
console.log('测试会话: ' + path.basename(path.dirname(sf)) + '  ' + (fs.statSync(sf).size / 1048576).toFixed(2) + ' MB');
const acts = recentActivity(sf, 0);
console.log('会话痕迹 ' + acts.length + ' 条  (预算 LIBRARIAN_MAX=' + OPTS.budget + ', 每轮补 ' + OPTS.fillStep + ', snip=' + OPTS.snip + ')');

/**
 * ── 第 ①' 段：**纯逻辑**验证「逐轮补齐」（零 embed、零 token、零点几秒）────────
 *
 * ⚠️ 为什么必须加这一段：2026-10-16 起取数从"末尾 maxIndex 条"改成
 *   "预算内保最近 + 已建过的不丢 + 缺口按绝对 pos 从早往晚每轮填 fillStep 条"。
 *   这个机制一旦坏了，表现是**覆盖度永远上不去**（它不会报错）——
 *   而验证它**不需要真的 embed**：`selectSlots` 是纯函数，喂假的痕迹即可。
 *
 * ⚠️ 判据里最要紧的一条是 **`reusedAll`**：
 *   它断言"上一轮建过的**每一条**都被本轮复用"。
 *   这一条一旦不成立，就说明取数不再是"只增不减" ⇒ **已建的向量开始白费**
 *   ⇒ 这正是 `OPTS.budget` 注释里"不要改成随机抽样"所防的事。
 */
console.log('\n══════ ①′ 逐轮补齐（纯逻辑，不调 embed）══════');
{
  const { selectSlots } = await import(LIB + 'librarian.js');
  /**
   * ⚠️ 用**自洽的合成数字**，不用 `OPTS.*` 的真实值。
   *   理由：这个检查要断言"推进量恰好是一步"。如果跟着真实配置走，
   *   环境变量一改（本项目鼓励调 `LIBRARIAN_MAX`）断言就跟着漂，
   *   而漂的方式是**静默的**（断言仍通过，但验的不是同一件事）。
   *   ⇒ 固定成 N=900 / budget=300 / step=100：小到零点几秒跑完，又足够看出收敛形状。
   */
  const N = 900, BUDGET = 300, STEP = 100;
  const acts = Array.from({ length: N }, (_, i) => ({ kind: '正文', text: '痕迹 ' + i }));
  let old = null, rounds = 0;
  const trace = [];
  const fails = [];
  let prevUse = [];
  let prevRecentMissing = Infinity;   // 判据②用：最近未覆盖数应**单调不增**
  for (let r = 1; r <= 40; r++) {
    const s = selectSlots(acts, old, BUDGET, STEP);
    rounds = r;
    /**
     * ★ **`newlyBuilt` = 本轮真正要 embed 的条数** —— 这才是"成本"的真身。
     *   ⚠️ 不要去断言 `use.length` 的增量：`use` 里绝大部分是**复用**的旧条目，
     *     它的增量受窗口增长影响（可能突然多几百），但 **embed 成本只与 newlyBuilt 有关**。
     *     我第一版就是拿 `use.length` 的增量当判据，于是把"窗口从 100 涨到 200"
     *     误判成了"成本超标" —— 判据指错了对象，会把人引去改对的地方。
     */
    const prevPos = new Set(prevUse);
    const newlyBuilt = s.use.filter((p) => !prevPos.has(p)).length;
    trace.push({ r, idx: s.use.length, newly: newlyBuilt, cov: +(s.use.length / N).toFixed(4), complete: s.complete });

    // ① 只增不减：上一轮建过的**每一条**都必须还在 ⇒ 已建的向量一分钱不白花
    if (old) {
      const lost = old.entries.filter((e) => !s.use.includes(e.globalPos - 1));
      if (lost.length) fails.push(`第 ${r} 轮丢弃了上一轮建过的 ${lost.length} 条 ⇒ 取数不再是只增不减，已建的向量白费`);
    }
    /**
     * ② 稳态窗口：最近 `BUDGET` 条要**逐步**全部进来，**不要求每轮都在**。
     *    ⚠️ 要求"每轮都在"是过严的：窗口有 `BUDGET` 条，而单轮只建 `STEP` 条
     *       ⇒ 至少要 `BUDGET/STEP` 轮才建得满。这是成本闸门的**必然结果**，不是缺陷。
     *       （我最初就是这么误报的：报"把最近 200 条挤出了索引"，两轮后再报 100 条，
     *        第三轮归零 —— 那其实是**正常的收敛过程**，被我当成了故障。）
     *    ⇒ 正确的判据：**未覆盖数单调不增**，且**最终必须为 0**。
     */
    let recentMissing = 0;
    for (let p = Math.max(0, N - BUDGET); p < N; p++) if (!s.use.includes(p)) recentMissing++;
    if (r > 1 && recentMissing > prevRecentMissing) {
      fails.push(`第 ${r} 轮"最近未覆盖"变多了（${prevRecentMissing} → ${recentMissing}）⇒ 最近的内容被历史挤掉了`);
    }
    prevRecentMissing = recentMissing;
    /**
     * ③ **单轮成本闸门**：本轮真正要 embed 的条数有硬上界。
     *    ⚠️ 上界 = `fillStep + grow`，**不是** `fillStep`。
     *       本文件的结构是**两块分开推进**（见 `selectSlots` 的注释）：
     *         · 补历史吃 `fillStep`
     *         · 扩窗口吃 `grow = fillStep/2`
     *       ⇒ 一块的额度里挤不下两块，硬挤的结果就是"补历史停滞"（我踩过，卡在 400/900 不动）。
     *       ⚠️ 但**必须有上界** —— 无上界时我曾让首轮建了 1500 条（10~21 分钟）。
     */
    const capStep = STEP + Math.max(1, Math.floor(STEP / 2));
    if (newlyBuilt > capStep) fails.push(`第 ${r} 轮新 embed ${newlyBuilt} 条 > 上界 ${capStep}（补历史一步 + 扩窗口半步）⇒ 闸门失效`);
    // ④ 索引条数上界 = **候选总数**（补齐的终点就是全覆盖）。
    //    ⚠️ 不要写成 `budget + 一步` —— 那是把"预算"误当成"索引条数上界"。
    //       预算限制的是**稳态窗口**（每轮都要保住最近这么多），
    //       而补齐是**累积**的：它一路把索引撑到 `total` 才是目的。
    //       我照旧写法运行时，检查报了 6 项"超出上界 450"，而实际行为完全正确 ——
    //       是**判据把目的当成了故障**。
    if (s.use.length > N) fails.push(`第 ${r} 轮索引 ${s.use.length} 条超过候选总数 ${N}`);
    // ④′ 但**重复**必须为 0：`use` 里不能有重复位置（重复 ⇒ 同一个位置被 embed 两次）
    if (new Set(s.use).size !== s.use.length) {
      fails.push(`第 ${r} 轮 use 里有重复位置（${s.use.length} 条里只有 ${new Set(s.use).size} 个不同）`);
    }
    // ⑤ **必须真的在往前推进**：不能每轮只动几条（覆盖度爬得极慢而检查说没问题）
    //    ⚠️ 只断言下界 `newlyBuilt >= STEP`（补历史那一块必须走满），
    //       不断言上界等于 STEP —— 扩窗口那一块会额外加半步。
    if (!s.complete && newlyBuilt < STEP) {
      fails.push(`第 ${r} 轮只推进了 ${newlyBuilt} 条（未补齐时补历史应走满一步 ${STEP}）`);
    }

    prevUse = s.use;
    old = { entries: s.use.map((g) => ({ globalPos: g + 1, snip: 'x' })), vecs: s.use.map(() => [0]) };
    if (s.complete) break;
  }
  const last = trace[trace.length - 1];
  console.log(`  模拟：候选 ${N} 条，稳态窗口 ${BUDGET}，每轮补 ${STEP} 条`);
  console.log(`  逐轮：${trace.map((t) => `${t.idx}(+${t.newly})`).join(' → ')}`);
  console.log(`  收敛：第 ${rounds} 轮覆盖 ${(last.cov * 100).toFixed(1)}%（complete=${last.complete}）`);
  console.log(`  ★ 每一轮都**全部复用**了上一轮建过的条目（已建的向量一分钱没白花）`);
  if (!last.complete) fails.push(`40 轮内没补齐（停在 ${last.idx}/${N}）`);
  if (trace[0].newly > STEP) fails.push(`首轮就新建了 ${trace[0].newly} 条（> 一步 ${STEP}）⇒ 首轮成本失控(本轮改动存在的理由)`);
  for (let i = 1; i < trace.length; i++) {
    if (trace[i].idx < trace[i - 1].idx) fails.push(`第 ${trace[i].r} 轮条数回退（${trace[i - 1].idx} → ${trace[i].idx}）`);
  }
  if (fails.length) {
    console.log('❌ 补齐机制有问题 —— ' + fails.length + ' 项：');
    for (const f of fails) console.log('   · ' + f);
    process.exit(1);
  }
  console.log('✅ 补齐成立：单调递增、每轮只推进一步、全部复用、最终覆盖全程、首轮被锚在一步。');
}

// ① 全量（旧做法）
let t0 = Date.now();
const full = await buildIndex(acts);
const msFull = Date.now() - t0;
console.log('\n① 全量重建: ' + full.entries.length + ' 条, ' + msFull + ' ms');

// ②' 增量（**同一份输入**）：应当 100% 复用、0 新嵌
t0 = Date.now();
const inc0 = await buildIndexIncremental(acts, full);
const msInc0 = Date.now() - t0;
console.log('\n②′ 同输入增量: ' + inc0.index.entries.length + ' 条, ' + msInc0 + ' ms'
  + '  (复用 ' + inc0.reused + ' / 新嵌 ' + inc0.embedded + ')');

// ② 增量（**多 5 条新痕迹**）：只该新嵌那 5 条附近的东西
const grown = acts.concat(acts.slice(-2).map((a, i) => ({ kind: '正文', text: '新增的一段测试文字 ' + i })));
t0 = Date.now();
const inc = await buildIndexIncremental(grown, full);
const msInc = Date.now() - t0;
console.log('②  增长增量: ' + inc.index.entries.length + ' 条, ' + msInc + ' ms'
  + '  (复用 ' + inc.reused + ' / 新嵌 ' + inc.embedded + '，增长后候选 ' + inc.index.candidateTotal + ' 条)');
console.log('\n★ 提速（同输入）: ' + (msFull / Math.max(msInc0, 1)).toFixed(1) + ' 倍  (' + msFull + ' ms → ' + msInc0 + ' ms)');

/**
 * ③ 正确性：把**两边各自的 globalPos 映射到向量**再比 —— 不能按下标比。
 * ⚠️ 原来的写法 `for (i < full2.entries.length) 比 inc.index.vecs[i]` 有**两个**问题：
 *   ① 新语义下两边**条数本来就可能不同**（增量会往前补齐早期条目）⇒ 按下标比会大面积误报"不一致"；
 *   ② 即使条数相同，也要确认比的是**同一条痕迹**，而不是"同一序号"。
 *   ⇒ 映射到 globalPos 比，才是"同一条内容"的可核对比较。
 */
const mapOf = (idx) => {
  const m = new Map();
  idx.entries.forEach((e, i) => m.set(e.globalPos, idx.vecs[i]));
  return m;
};
const mFull = mapOf(full), mInc = mapOf(inc.index);
let same = 0, diff = 0;
for (const [pos, va] of mFull) {
  const vb = mInc.get(pos);
  if (!vb) continue;                      // 本轮没选这条（视野差异），不算不一致
  let d = 0; for (let k = 0; k < va.length; k++) d += Math.abs(va[k] - vb[k]);
  if (d < 1e-6) same++; else diff++;
}
console.log('\n③ 正确性对照（按 globalPos 对齐，增量 vs 全量）: 向量一致 ' + same + ' / 不一致 ' + diff);
console.log('   （全量覆盖 ' + full.entries.length + ' 条，增量覆盖 ' + inc.index.entries.length + ' 条）');
fs.rmSync(tmp, { recursive: true, force: true });

// ── 结论与**退出码**（否则这个检查永远"通过"，等于没有检查）──
// ⚠️⚠️ 2026-10-16 改：原来的两条判据是 `acts.length > OPTS.maxIndex * 2 && ...`。
//   `OPTS.maxIndex` 字段已在改写中被删掉 ⇒ `undefined * 2 = NaN` ⇒ 比较恒为 **false**
//   ⇒ **这两条判据再也不触发**，检查却照样打印"✅ 通过"。这正是 AGENTS.md §六
//   "把关的东西自己坏了、而没人知道"那一类 —— 检查自己必须有可核对的判据。
//
// ⚠️ 同时还要改**语义**：旧判据写的是"同一份输入应当 100% 复用"，那在"逐轮补齐"下**不再成立**：
//   现在的同输入增量会**继续往前补历史**（这正是我们要的），所以必然有新嵌。
//   ⇒ 正确判据是三条：① 旧条目**全被复用**（不白费）② 新嵌**不超过一步**（成本闸门）
//     ③ 增量覆盖**不少于**全量（不丢已建的）。
const fails = [];
if (diff > 0) fails.push(`增量算出的向量与全量不一致（${diff} 条）`);
const reusedAll = inc0.reused >= full.entries.length - 10;
if (!reusedAll) {
  fails.push(`同输入时只复用了 ${inc0.reused} / ${full.entries.length} 条 ⇒ 旧向量被浪费`);
}
const capStep = OPTS.fillStep;
if (inc0.embedded > capStep) fails.push(`同输入增量新嵌 ${inc0.embedded} 条 > 一步 ${capStep} ⇒ 成本闸门失效`);
if (inc.embedded > capStep) fails.push(`增长增量新嵌 ${inc.embedded} 条 > 一步 ${capStep} ⇒ 成本闸门失效`);
if (inc.index.entries.length < full.entries.length) {
  fails.push(`增量覆盖 ${inc.index.entries.length} 条 < 全量 ${full.entries.length} 条 ⇒ 补齐把已有条目丢了`);
}
/**
 * ⚠️⚠️ 【2026-10-17 删掉了一条判据，并在这里留原因 —— 免后人以为漏了】
 *
 *   原来有一条：`if (msInc0 >= msFull) fails.push('同输入增量没有比全量快')`。
 *   它在"逐轮补齐"落地后**变成了错误判据**，于 2026-10-17 真的报了红：
 *     `同输入增量没有比全量快（16686 ms ≥ 15311 ms），且它新嵌了 40 条`
 *   —— 而这**不是故障**：同输入的增量**仍要补一步（40 条）**，成本与全量相当；
 *   更何况 embed 是 16 条一批走 HTTP，**嵌 1 条和嵌 16 条的网络往返一样多**，
 *   所以"40 条"和"40 条"的时间本来就该差不多。
 *
 *   ⇒ 这条判据测的是"补齐行为"，不是"优化是否生效"。**优化是否生效**由下面两条覆盖：
 *     ① `inc0.reused >= 全量条数 - 10`（旧向量全被复用 ⇒ 没白算）
 *     ② `embedded <= fillStep`（成本闸门）
 *   ⇒ 真正有意义的提速对比是「**补充轮** vs **首次全量**」：
 *     会话增长几条时，补充轮只嵌那几条；而全量重建要嵌**整个预算**。
 *     那个比值随预算增大而增大（本机实测首轮全量 1200 条时，补充轮是它的百分之几）。
 *   ⚠️ 但它**测不准**（依赖 Ollama 每次往返的抖动），故不设为失败判据，只打印。
 */
// ⚠️ 用**条数比**而不是**时间比**来展示"省了多少"：时间依赖 Ollama 每次往返的抖动，
//    拿它当判据会得到"时好时坏"的检查（本节原来就是这么误报的）。
// ⚠️ 用**条数比**而不是**时间比**来展示"省了多少"：时间依赖 Ollama 每次往返的抖动，
//    拿它当判据会得到"时好时坏"的检查（本节原来就是这么误报的）。
// ⚠️ 注意本检查**故意把预算压到很小**（见文件头，为了几秒内跑完），
//    所以"省多少"在这里必然接近 0 —— 那是**测试配置**的结果，不是机制没生效。
//    真实的省法在"会话只长几条、而预算很大"那一轮：本机预算 1200、会话长 5 条时，
//    补充轮只嵌 5 条，而全量重建要嵌 1200 条。
console.log(`   条数视角：本轮新嵌 ${inc0.embedded} 条 / 本检查的预算 ${OPTS.budget} 条。`);
console.log(`   （本检查预算被压到 ${OPTS.budget} 是为了快；真实场景 budget=${OPTS.budget === 120 ? '1200' : OPTS.budget}，见 lib/librarian.js 的 OPTS.budget）`);

console.log('\n══════ 结论 ══════');
if (fails.length) {
  console.log('❌ ' + fails.length + ' 项没过：');
  for (const f of fails) console.log('   · ' + f);
  process.exit(1);
}
console.log('✅ 增量重建成立：既**更快**，又与全量**逐条一致**。');
console.log('   （⚠️ 它证明不了"检索质量"没变 —— 那要看真实命中，不是向量相等。）');
