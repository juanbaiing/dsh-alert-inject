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

export const CONFIG_FILE = process.env.DSH_ALERT_CONFIG
  || path.join(os.homedir(), '.dsh', 'alert-inject.json')

/** 判据表 / 术语表的**候选相对路径**（相对于 projectRoot 逐个试，命中即用） */
const JUDGE_CANDIDATES = [
  '※世界模拟/回想/.警报判据.json',
  '回想/.警报判据.json',
  '.dsh-alert/judges.json',
  'alert-judges.json',
]
const TERM_CANDIDATES = [
  '※世界模拟/回想/_术语表.md',
  '回想/_术语表.md',
  '.dsh-alert/terms.md',
  'alert-terms.md',
]

const DEFAULTS = {
  /**
   * 生效的工作区。**空数组 = 对所有工作区生效**（发布后的正确默认）。
   * ⚠️ 与原实现的差别：原 `WORKSPACES` 非空且只匹配两个特定路径 ⇒ 别处一律不生效。
   *    保留旧行为请在配置文件里写明。
   */
  workspaces: [],
  /** 项目根。null ⇒ 由会话的 cwd 推断（零配置） */
  projectRoot: null,
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

/** 判据表路径（projectRoot 可覆盖） */
export function judgesPath(projectRoot) {
  const c = config()
  const root = projectRoot || c.projectRoot
  return process.env.DSH_ALERT_JUDGES || firstExisting(root, JUDGE_CANDIDATES)
}

/** 术语表路径 */
export function termsPath(projectRoot) {
  const c = config()
  const root = projectRoot || c.projectRoot
  return process.env.DSH_ALERT_TERMS || firstExisting(root, TERM_CANDIDATES)
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
    detail: tf ? tf : `未找到（试过：${TERM_CANDIDATES.join(' / ')}）⇒ 判据的"与门"失效，会变宽松`,
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
