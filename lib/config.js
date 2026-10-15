/**
 * config.js — 统一配置：**让插件脱离"某一个项目"**
 *
 * ══ 为什么必须做（发布的前提）════════════════════════════════════
 *   2026-10-15 检查发现，原实现把四样东西**硬编码**在代码里：
 *     · `WORKSPACES`（只在两个特定工作区生效）
 *     · `PROJECT`（写死了开发机上某个具体项目的绝对路径）
 *     · 判据表 / 术语表路径（都挂在那个项目下）
 *     · 数据目录
 *   ⇒ 后果：**别人 clone 下来，它什么都不做**（工作区不匹配、路径不存在），
 *     而且**静默**——没有任何提示。这跟作者装过的记忆库"感觉不好"是同一类门槛。
 *   ⇒ 发布前必须解决：**零配置可跑，配错能诊断。**
 *
 * ══ 优先级（从高到低）════════════════════════════════════════════
 *   ① 显式传参（函数参数）
 *   ② 环境变量（DSH_ALERT_*）
 *   ③ 配置文件 `~/.dsh/alert-inject.json`
 *   ④ 内置默认（**尽量做到"不用配就能跑"**）
 *
 * ══ 设计取舍（与 OpenViking 的对比，作者实测过那个记忆库）══════════
 *   · **零常驻**：本模块只读一个 JSON 文件，**不起服务、不占常驻 token**。
 *   · **零配置可跑**：没有配置文件时用默认值推断（不是直接罢工）。
 *   · **配错要出声**：`diagnose()` 明确报告"哪个路径不存在 / 哪个工作区不匹配"，
 *     而不是静默什么都不做（**这正是不装/不用的最常见原因**）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONFIG_FILE = process.env.DSH_ALERT_CONFIG
  || path.join(os.homedir(), '.dsh', 'alert-inject.json')

/**
 * 判据表 / 术语表的**候选相对路径**（相对于 projectRoot 逐个试，命中即用）。
 *
 * ⚠️⚠️ 2026-10-16 作者定「**1+2**」：**出厂带通用常识 ＋ 全部可配置 ＋ 不写死某人的路径**。
 *   ⇒ **通用位置排第一**（别人装了插件也能用）；项目特有的旧结构**降为兜底**（原项目不用改）。
 *   ⇒ 完整查找顺序见 `judgesPath()`：env ＞ 配置文件显式 ＞ 下列候选 ＞ **包内出厂默认**。
 */
const JUDGE_CANDIDATES = [
  '.dsh-alert/judges.json',            // ← 通用（推荐位置）
  'alert-judges.json',                 // ← 通用（项目根）
  '※世界模拟/回想/.警报判据.json',      // ← 兜底：某类项目的既有结构
  '回想/.警报判据.json',                // ← 兜底
]
const TERM_CANDIDATES = [
  '.dsh-alert/terms.md',               // ← 通用（推荐位置）
  'alert-terms.md',                    // ← 通用（项目根）
  '※世界模拟/回想/_术语表.md',          // ← 兜底
  '回想/_术语表.md',                    // ← 兜底
]

/**
 * ⚠️ 包内**出厂默认判据表**（`lib/defaults/judges.default.json`）。
 *   内容是「**通用语气条款**」——**不依赖任何项目**，所以可以出厂自带。
 *   ⚠️ 它里面所有判据都是 `shadow: true`（**只记录、不提醒**）：
 *     直接上线会重演判据表自己记着的那句「首轮实测 **5 条警报全是噪声**」。
 *
 *   ⚠️ 而**术语表没有出厂默认** —— 术语天然是领域相关的，不存在通用内容。
 *     ⇒ 术语要靠「**相处里长出来 ／ 从对话抽出来**」（作者 2026-10-16 定 **b+c**）。
 */
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))
const BUNDLED_JUDGES = path.join(PKG_DIR, 'defaults', 'judges.default.json')

/**
 * ⚠️ 导出给 `loadJudges` 用（2026-10-16 修）：
 *   出厂判据表**不能只是"项目没有时的兜底"** —— 那是「**替换**」语义，实测的后果是：
 *   **使用者一旦配了自己那份判据表，出厂那 5 条通用判据就彻底消失**。
 *   ⇒ 正确语义是「**通用常识 ＋ 你自己的**」＝**两份合并**（见 `lib/index.js` 的 `loadJudges`）。
 */
export const BUNDLED_JUDGES_PATH = BUNDLED_JUDGES

const DEFAULTS = {
  /**
   * 生效的工作区。**空数组 = 对所有工作区生效**（发布后的正确默认）。
   * ⚠️ 与原实现的差别：原 `WORKSPACES` 非空且只匹配两个特定路径 ⇒ 别处一律不生效。
   *    保留旧行为请在配置文件里写明。
   */
  workspaces: [],
  /** 项目根。null ⇒ 由会话的 cwd 推断（零配置） */
  projectRoot: null,
  /**
   * 判据表 / 术语表的**显式路径**（作者 2026-10-16 定：**所有位置都要能配置**）。
   * 相对路径 ⇒ 相对 projectRoot 解析；绝对路径 ⇒ 原样使用。
   * null ⇒ 走候选列表 ＋ 包内出厂默认。
   */
  judgesFile: null,
  termsFile: null,
  /** 数据目录（索引缓存 / 待审记 / 样本） */
  dataDir: path.join(os.homedir(), '.dsh'),
  /** 是否在诊断发现配置缺失时打警告（默认开） */
  warnOnMisconfig: true,
}

let _cache = null
let _cacheKey = null

function readFileConfig() {
  try {
    const st = fs.statSync(CONFIG_FILE)
    const key = `${st.mtimeMs}:${st.size}`
    if (_cacheKey === key && _cache) return _cache
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    // ⚠️ 顶层只做浅合并；嵌套（librarian/learning）由各模块自己读环境变量，避免耦合
    const merged = { ...DEFAULTS, ...raw }
    _cache = merged; _cacheKey = key
    return merged
  } catch { return null }
}

/** 环境变量覆盖（保留旧的行为，任何人原有配置不失效） */
function fromEnv() {
  const out = {}
  if (process.env.DSH_ALERT_WORKSPACES) {
    out.workspaces = process.env.DSH_ALERT_WORKSPACES.split(/[;,]/).map((s) => s.trim()).filter(Boolean)
  }
  if (process.env.DSH_ALERT_PROJECT) out.projectRoot = process.env.DSH_ALERT_PROJECT
  if (process.env.DSH_ALERT_DATA_DIR) out.dataDir = process.env.DSH_ALERT_DATA_DIR
  return out
}

/** 取配置（已合并三层） */
export function config() {
  const file = readFileConfig() || {}
  return { ...DEFAULTS, ...file, ...fromEnv(), _source: readFileConfig() ? CONFIG_FILE : '(默认)' }
}

/** 工作区是否应生效 */
export function matchesWorkspace(cwd) {
  const c = config()
  if (!cwd) return false
  if (!c.workspaces?.length) return true          // 空 = 全部生效
  return c.workspaces.some((w) => String(cwd).toLowerCase().includes(String(w).toLowerCase()))
}

/** 在 projectRoot 下按候选顺序找第一个存在的路径 */
function firstExisting(root, rels) {
  if (!root) return null
  for (const rel of rels) {
    const p = path.join(root, ...rel.split('/'))
    try { if (fs.existsSync(p)) return p } catch { /* ignore */ }
  }
  return null
}

/** 把配置里的显式路径解析成绝对路径（相对 ⇒ 相对 projectRoot） */
function explicitPath(p, root) {
  if (!p) return null
  return path.isAbsolute(p) ? p : path.join(root || process.cwd(), p)
}

/**
 * 判据表路径（projectRoot 可覆盖）。
 *
 * ⚠️ 查找顺序（2026-10-16 定 · 作者「**1+2**」）：
 *   ① `DSH_ALERT_JUDGES`（环境变量）
 *   ② 配置文件里的 `judgesFile`（**显式路径**）
 *   ③ 项目根的候选列表（**通用位置在前**，项目旧结构在尾）
 *   ④ **包内出厂默认** `lib/defaults/judges.default.json`（**通用常识，人人都有**）
 * ⇒ 这样「**出厂带一点通用常识／所有位置都能配／不写死谁的路径**」三件事同时成立。
 */
export function judgesPath(projectRoot) {
  const c = config()
  const root = projectRoot || c.projectRoot
  if (process.env.DSH_ALERT_JUDGES) return process.env.DSH_ALERT_JUDGES
  const explicit = explicitPath(c.judgesFile, root)
  if (explicit && fs.existsSync(explicit)) return explicit
  const found = firstExisting(root, JUDGE_CANDIDATES)
  if (found) return found
  return fs.existsSync(BUNDLED_JUDGES) ? BUNDLED_JUDGES : null
}

/**
 * 术语表路径（同上，但**没有出厂默认** —— 术语天然是领域相关的，不存在通用内容）。
 * ⇒ 术语要靠「相处里长出来 ／ 从对话抽出来」（作者 2026-10-16 定 **b+c**）。
 */
export function termsPath(projectRoot) {
  const c = config()
  const root = projectRoot || c.projectRoot
  if (process.env.DSH_ALERT_TERMS) return process.env.DSH_ALERT_TERMS
  const explicit = explicitPath(c.termsFile, root)
  if (explicit && fs.existsSync(explicit)) return explicit
  return firstExisting(root, TERM_CANDIDATES)
}

/** 数据文件路径 */
export function dataFile(name) {
  const c = config()
  return path.join(c.dataDir, name)
}

/**
 * ★ 诊断：**明确说出"为什么它没生效"**。
 *
 * 动机：作者装过的记忆库"感觉不好、没能实现" —— 而"不知道它到底在不在工作"
 * 是最常见的放弃原因。故本插件必须能自报状态，而不是静默。
 *
 * @returns {{ok:boolean, items:{name,ok,detail}[], hint:string}}
 */
export function diagnose({ cwd } = {}) {
  const c = config()
  const items = []

  items.push({
    name: '配置文件',
    ok: true,
    detail: c._source === '(默认)' ? '未提供配置文件，使用默认（零配置模式）' : `${c._source}`,
  })

  // 工作区
  const wsOk = matchesWorkspace(cwd)
  items.push({
    name: '工作区匹配',
    ok: wsOk,
    detail: wsOk
      ? (c.workspaces?.length ? `匹配 ${c.workspaces.join(', ')}` : '未限定工作区（对所有工作区生效）')
      : `cwd「${cwd || '?'}」不在 workspaces 列表里 ⇒ **本插件在此工作区不会做任何事**`,
  })

  // 项目根
  const root = cwd && !c.projectRoot ? cwd : c.projectRoot
  items.push({
    name: '项目根',
    ok: !!root,
    detail: root ? root : '未设置，且无法从 cwd 推断 ⇒ 判据表/术语表无从查找',
  })

  // 判据表
  const jf = judgesPath(root)
  items.push({
    name: '判据表',
    ok: !!jf,
    detail: jf ? jf : `未找到（在项目根下试过：${JUDGE_CANDIDATES.join(' / ')}）⇒ 「自查」功能不可用，其余功能不受影响`,
  })

  // 术语表
  const tf = termsPath(root)
  items.push({
    name: '术语表',
    ok: !!tf,
    detail: tf ? tf : `未找到（试过：${TERM_CANDIDATES.join(' / ')}）⇒ 判据的"与门"失效：**带与门的判据将【永不触发】**（⚠️ 2026-10-16 实测修正：旧文字写"会变宽松"，是**反的**）`,
  })

  // 数据目录
  let dataOk = false
  try { fs.mkdirSync(c.dataDir, { recursive: true }); dataOk = true } catch { /* ignore */ }
  items.push({ name: '数据目录', ok: dataOk, detail: dataOk ? c.dataDir : `不可写：${c.dataDir}` })

  const ok = items.every((i) => i.ok)
  const hint = ok
    ? '配置就绪。'
    : '⚠️ 有项目未就绪 —— 但**插件不会崩**（设计上全部 try/catch 静默）：'
      + '缺哪一项，就只关掉依赖它的那个功能。上面已逐条说明影响范围。'
  return { ok, items, hint }
}

/** 渲染诊断结果（给人看） */
export function renderDiagnose(d) {
  const lines = [`【配置诊断】${d.ok ? '✅ 就绪' : '⚠️ 有缺项'}`]
  for (const i of d.items) lines.push(`- ${i.ok ? '✅' : '⚠️'} ${i.name}：${i.detail}`)
  lines.push(d.hint)
  return lines.join('\n')
}
