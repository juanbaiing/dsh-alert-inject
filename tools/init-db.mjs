/**
 * init-db.mjs — 建立三个库的骨架（**空库，不含任何本机数据**）
 *
 * ══ 作者 2026-10-16 定的结构 ═══════════════════════════════════════
 *   | 库 | 是什么 | 生长方式 |
 *   |---|---|---|
 *   | `knowledge/` 知识 | 知识／常识／模式 | **累积**（越攒越多） |
 *   | `cases/` 案例 | **整理稿（L2）的语境块投影** —— 370 个块的落点 | 累积 |
 *   | `profile/` 人设 | **AI 形象** ＋ **对你的理解**（两半） | **覆盖**（只留最新）**＋ 旧版留痕** |
 *
 * ══ 三条纪律 ═════════════════════════════════════════════════════
 *   ① **出厂不带数据** —— 本脚本只建**空骨架**，不塞任何人的内容
 *      （「这是一个插件，不能有我本机的默认数据」—— 作者 2026-10-16）
 *   ② **位置可配置** —— 默认 `~/.dsh/memory/db/`，随 `DSH_ALERT_DATA_DIR` 走
 *   ③ **幂等** —— 已经存在的文件**不覆盖**（跑第二遍不会弄丢你的东西）
 *
 * 用法：
 *   node tools/init-db.mjs              # 建骨架
 *   node tools/init-db.mjs --show       # 只看现状，不动任何文件
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2)
const SHOW = argv.includes('--show')

const DATA_DIR = process.env.DSH_ALERT_DATA_DIR || path.join(os.homedir(), '.dsh')
const ROOT = path.join(DATA_DIR, 'memory', 'db')

const SCHEMA_MD = `# 三个库 · 字段规范

> **本文件是这个库的说明书。** 使用者不看代码，只看这里。
> 作者 2026-10-16 定的结构：**知识｜案例｜人设** 三个库分开。

## 一、字段（**只定最少的必填项，其余自由长**）

每条**必填四个**（名字沿用项目里已跑过数据的那两套：整理稿与样本库）：

| 字段 | 意思 | 例子 |
|---|---|---|
| \`from\` | **从哪条对话来的** —— 能回到原文 | \`{"session":"<会话id>","pos":181}\` |
| \`what\` | 内容本身 | \`"姿态要在相处里自然生成"\` |
| \`when\` | 什么时候得的 | \`"2026-10-16T02:50:00+08:00"\` |
| \`kind\` | 哪一类 | \`知识\` / \`设定\` / \`相处模式\` |

**可选三个**：

| 字段 | 为什么值得有 |
|---|---|
| \`conf\` | **置信度** —— ⚠️ 最容易漏的一个：记忆里既有「**他明说的**」也有「**我从对话推出来的**」，不标就分不清 |
| \`ver\` | 世代号 —— 配合「**旧版留痕**」 |
| \`src\` | 来源类型：\`对话\` / \`档文\` / \`推导\` |

**唯一标识**：用**内容指纹** \`h\`（样本库已经在用同一套做法）。

## 二、三个库各装什么

| 库 | 装什么 | 生长方式 |
|---|---|---|
| \`knowledge/\` | 知识／常识／模式；**每条带它指向的语境块** | **累积** |
| \`cases/\` | **整理稿的语境块投影** —— 让你能回答「这条知识当初是在什么场景下得的」 | 累积 |
| \`profile/\` | \`ai.md\`（**AI 形象**）＋ \`user.md\`（**对你的理解**） | **覆盖，且旧版留痕** |

## 三、为什么要分开（而不是混一起）

- **生长方式不同**：知识**越攒越多**；形象**只留最新**（但旧版进 \`history/\`）
- **用途不同**：知识要按语境取用；形象要在每次开口前当参照
- **混在一起会长乱**：一个月后你会分不清「这条是当时的我，还是当时的它」

## 四、旧版留痕

\`profile/\` 是**覆盖**语义 ⇒ 每次覆盖前，把旧版时间戳归档到 \`profile/history/\`。
⇒ 半年后还能翻出「**当时它以为你是这样的**」。
（作者 2026-10-16 定：「旧版留痕」。）

## 五、位置可配置

默认 \`~/.dsh/memory/db/\`；改数据目录即可（环境变量 \`DSH_ALERT_DATA_DIR\`）。
`

const PROFILE_AI_MD = `# AI 形象（最新版）

<!-- 覆盖式：每次改动前，旧版归档到 profile/history/ -->

> ⚠️ **出厂时这里是空的。** 这张纸上的东西应当**从相处里长出来**，
> 不是别人替你写好塞进来的。
> （作者：「姿态要在相处里自然生成，我们只能给一个预设模板，具体要扩充」）

## 我该在对方面前是什么样

（待长）

## 禁区

（待长）

---
**ver**: 0　**更新时间**: 出厂初始　**来源**: 出厂初始（空）
`

const PROFILE_USER_MD = `# 对使用者（你）的理解（最新版）

<!-- 覆盖式：每次改动前，旧版归档到 profile/history/ -->

> ⚠️ **出厂时这里是空的。** 这一半要靠**相处**填：
> 他怎么说事、什么算"够用就停"、哪些话是玩笑、哪些是认真的。
> （⚠️ 不要从任何别人的数据里抄 —— 那对新的使用者毫无意义。）

## 说话习惯

（待长）

## 做事风格

（待长）

## 已知的雷区

（待长）

---
**ver**: 0　**更新时间**: 出厂初始　**来源**: 出厂初始（空）
`

const dirs = [
  ROOT,
  path.join(ROOT, 'knowledge'),
  path.join(ROOT, 'cases'),
  path.join(ROOT, 'profile'),
  path.join(ROOT, 'profile', 'history'),
]

console.log('══════════════════════════════════════════════════════════')
console.log('  三个库 · 骨架')
console.log('══════════════════════════════════════════════════════════')
console.log(`位置：${ROOT}${SHOW ? '   （--show：只看现状，不动文件）' : ''}`)
console.log('')

for (const d of dirs) {
  const existed = fs.existsSync(d)
  if (!SHOW && !existed) fs.mkdirSync(d, { recursive: true })
  console.log(`  ${existed ? '已有' : SHOW ? '缺' : '已建'}  ${path.relative(ROOT, d) || '.'}`)
}

const files = [
  [path.join(ROOT, '_schema.md'), SCHEMA_MD],
  [path.join(ROOT, 'knowledge', 'knowledge.jsonl'), ''],
  [path.join(ROOT, 'cases', 'cases.jsonl'), ''],
  [path.join(ROOT, 'profile', 'ai.md'), PROFILE_AI_MD],
  [path.join(ROOT, 'profile', 'user.md'), PROFILE_USER_MD],
]

console.log('')
for (const [f, content] of files) {
  const rel = path.relative(ROOT, f)
  if (fs.existsSync(f)) { console.log(`  跳过（已存在，**不覆盖**）  ${rel}`); continue }
  if (SHOW) { console.log(`  缺                    ${rel}`); continue }
  fs.writeFileSync(f, content, 'utf8')
  console.log(`  已建                  ${rel}`)
}

console.log('')
console.log('══════════════════════════════════════════════════════════')
console.log('【你怎么自己确认】')
console.log(`  · 用文件管理器打开：${ROOT}`)
console.log('  · 应当看到：_schema.md ＋ knowledge/ ＋ cases/ ＋ profile/（含 history/）')
console.log('  · 打开 _schema.md —— 那里面写着每条最少要带什么')
console.log('')
console.log('⚠️ 本脚本只建【空骨架】：**不写任何人的内容**。')
console.log('   两个 md 里写的是"（待长）" —— 那些要靠相处填。')
console.log('   「这是一个插件，不能有我本机的默认数据。」—— 作者 2026-10-16')
console.log('══════════════════════════════════════════════════════════')
