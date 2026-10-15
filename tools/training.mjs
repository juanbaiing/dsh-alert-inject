/**
 * training.mjs — CLI：**把断掉的链路接上** —— 样本→筛选→够不够训
 *
 * ══ 为什么有这个文件（2026-10-16）══════════════════════════════════
 *   `lib/training.js` 与 `lib/verify-samples.js` 两个模块**写好了但没人调**
 *   （接线审计报它们为孤岛），于是一整条链路**断在中间**：
 *   ```
 *   对话 → 采样本(samples.js ✅在跑) → 用知识库筛(verify-samples ❌) → 够不够训(training ❌) → 训 → 判据接回哨兵
 *   ```
 *   ⚠️ 而它们**不是废代码** —— 作者要的「**判据从已知信息里推出来，而不是写死的**」，
 *      底座就在这里（`TASK_SPEC` 里那句「这段内容与已有设定冲突吗？」就是判据的雏形）。
 *   ⇒ 本 CLI 只做一件事：**让它们能被跑到、结果能被看见**。
 *
 * 用法：
 *   node tools/training.mjs --project D:/某项目           # 训练就绪度（含知识库筛选摘要）
 *   node tools/training.mjs --project D:/某项目 --verify  # 补上详细的筛选结果
 *   node tools/training.mjs --project D:/某项目 --verify <task>
 *
 * ⚠️ 本工具**只读**：不写样本库、不改任何数据。
 */

import { assessTraining, renderPlan } from '../lib/training.js'
import { verifyTask, renderVerify } from '../lib/verify-samples.js'

const argv = process.argv.slice(2)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }
const has = (k) => argv.includes(k)

const projectRoot = get('--project') || process.env.DSH_ALERT_PROJECT || process.env.DSH_ALERT_CWD || undefined

if (!projectRoot) {
  console.log('⚠️ 没有项目根 ⇒ 找不到知识图，「用知识库筛选」这一半做不了。')
  console.log('   用法：node tools/training.mjs --project D:/你的项目')
  process.exit(2)
}

console.log('══════════════════════════════════════════════════════════')
console.log('  接上断点：样本 → 知识库筛选 → 够不够训')
console.log('══════════════════════════════════════════════════════════')
console.log(`项目根：${projectRoot}`)
console.log('')

const a = assessTraining({ projectRoot })
console.log(renderPlan(a))

// ── 详细的筛选结果（可选）──
const wantVerify = has('--verify')
if (wantVerify) {
  const taskArg = get('--verify')
  const task = taskArg && !taskArg.startsWith('--') ? taskArg : 'doc_route_weak'
  console.log('')
  const v = verifyTask(task, { projectRoot })
  if (v.summary.error) {
    console.log(`⚠️ 筛选做不了：${v.summary.error}`)
  } else {
    console.log(renderVerify(v))
  }
}

// ── 你怎么自己确认 ──
console.log('')
console.log('══════════════════════════════════════════════════════════')
console.log('【你怎么自己确认】')
console.log('  · 样本总数：打开 C:\\Users\\<你>\\.dsh\\learning-samples.jsonl，数行数 —— 应当等于上面的事件总数')
console.log('  · 门槛算得对不对：门槛 = 8 × 类别数（8 是 SetFit 的公开门槛，不是估的）')
console.log('  · 「无法判定」有多少：它**不是**无效样本 —— 知识表本来就有覆盖缺口，')
console.log('    口语/场景文本常常一个术语都命中不到（这正是它不该被当无效排除的理由）')
console.log('')
console.log('⚠️ 注意：本工具只回答「**够不够训**」，**不做训练**。')
console.log('   训练那一步不在这（要用 Laya，在另一个环境里），训出来的判据也还没接回哨兵。')
console.log('══════════════════════════════════════════════════════════')
