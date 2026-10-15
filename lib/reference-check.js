/**
 * reference-check.js — 引用存在性检查器 · 潜意识功能之一
 * 潜意识的声音：「**这不对吧 —— 你引用的那个东西根本不存在**」
 *
 * ══ 为什么是它（而不是别的）作为"不对劲"的第一个实现 ════════════
 *   1. **纯程序、零成本、准确率接近 100%** —— 它验证的是【存在性】而非【合理性】。
 *      存在就是存在，不存在就是不存在，没有概率、没有阈值、不会幻觉。
 *   2. **直击已知真实痛点**：本项目判据「我的老毛病」里明确列着「**引不存在的文件**」。
 *   3. **工程依据**：业界共识是 "**the verifier's scope should be narrower and more
 *      deterministic than the generator's**"（验证者应比生成者更窄、更确定）。
 *      存在性检查是这句话的极致形态。
 *
 * ══ 与"把判断交回主模型"的区别（作者 2026-10-15 指出）════════════
 *   若只是"把候选摆给主模型自己判断"，就绕回了【被监控者监控自己】——
 *   而 PLUGIN.md 已定："监控者与被监控者若出自同一个模型，会共享同一个失败模式。"
 *   ⇒ 本模块的判定**完全在主模型之外**，用的是文件系统这一【外部事实源】。
 *     它给出的不是"我感觉"，是"我查了，没有"。
 *
 * ══ ⚠️ 措辞纪律 ═════════════════════════════════════════════════
 *   · 本模块**不判"错"**，只报"**未找到**"。
 *     因为"提及一个还不存在的文件"是正常行为（比如"我打算创建 foo.md"）。
 *     判成"错误"会误报；报成"未找到"则由使用者自行结合上下文判断。
 *   · 输出模板每个字都要过 leak-check（判据触发词不得出现）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 能被识别的"引用"形态 */
const RE = {
  // 反引号包裹（最常见：`工具\_court.js`、`lib/index.js`）
  // ⚠️ 排除空格：初版正则没排空格，把 "…\runtime\ to understand plugin installation."
  //    这种【英文句子片段】也当成了路径（实测被它坑过）。
  backtick: /`([^`\n]{2,120})`/g,
  // 明确的 Windows 绝对路径（同样必须排除空格，否则会吞掉后面的句子）
  winAbs: /\b([A-Za-z]:\\(?:[^\\/:*?"<>|\s\r\n]+\\)*[^\\/:*?"<>|\s\r\n]+)/g,
}

/**
 * ⚠️⚠️ 实测教训（2026-10-15）：**"什么算文件引用"无法靠正则判定** ⚠️⚠️
 *   首版按"像路径就查"实现，真实数据上 **573 个引用报了 504 个（88%）**，完全不可用。
 *   误报构成（363 个不同引用实测）：
 *     · Unix 绝对路径 27      —— `/tmp`、`/home/github`（Windows 上无意义，不是文件引用）
 *     · API 路径 / 包名 19    —— `/v1/chat/completions`、`@deepseek-ai/dsh-plan-mode`
 *     · 事件名                —— `agent/request`
 *     · npm 包名+版本         —— `@deepseek-ai/dsh-settings: ^0.1.0-rc.8`
 *     · GitHub 路径占位符     —— `owner/repo`
 *     · 含尖括号的模板路径    —— `/plugins/<id>/client.js`
 *     · 目录名                —— `lib/`
 *     · **甚至整行代码**      —— `const disposeRequest = agentCtx.on('agent/request', …`
 *   ⇒ **"引用存在性检查"看似原子，实际依赖一个前置能力：判断"这是不是文件引用"，
 *     而这需要语义理解。** 换句话说：这个"最小可处理单元"并不最小。
 *   ⇒ 收窄策略：**只查带【已知项目目录前缀】的引用** —— 这类引用必定指项目内文件，
 *     误报低；且正对应判据「我的老毛病」中"引不存在的文件"那条。
 */
export const PROJECT_PREFIXES = [
  '工具\\', '工具/',
  '※世界模拟\\', '※世界模拟/',
  '设定档案\\', '设定档案-JS\\', '设定档案/',
  '交接\\', '教训\\', '记录\\', '报告\\', '备份\\',
  '原始素材\\', '角色分析\\', '试排\\', '成品-JS\\', 'art\\', 'art_out\\', '_核对\\',
]

/** 看起来像"文件/目录路径"或"带扩展名的文件" */
function looksLikePath(s) {
  const t = s.trim()
  if (!t || t.length < 3 || t.length > 160) return false
  if (/\s/.test(t)) return false                               // 含空白 ⇒ 多半是句子或命令行
  if (/^https?:\/\//i.test(t)) return false                     // 网址
  if (/^@/.test(t)) return false                                // npm scope
  if (/[:<>*?"|]/.test(t)) return false                         // 含 :<> 等 ⇒ 版本号/模板/表达式
  if (/\.\.\.|…/.test(t)) return false                          // 含省略号 ⇒ 是"路径\…"这种省略写法，非完整引用
  if (/^(pos=|--|\$)/.test(t)) return false                     // 参数/命令
  if (/^\//.test(t)) return false                               // Unix/API 路径
  const hasExt = /\.(js|mjs|cjs|ts|json|md|txt|py|ps1|sh|yml|yaml|zst|log|bat|cmd)$/i.test(t)
  const hasSep = /[\\/]/.test(t)
  if (!hasExt && !hasSep) return false                          // 既无扩展名又无分隔符 ⇒ 不查
  if (/[\\/]$/.test(t)) return false                            // 以分隔符结尾 ⇒ 是目录，不查
  return true
}

/**
 * 从文本里抽出候选引用（去重）。
 * @param opts.onlyProject 只保留带【已知项目目录前缀】的引用（默认 true —— 见上方实测教训）
 */
export function extractRefs(text, opts = {}) {
  const onlyProject = opts.onlyProject !== false
  const out = new Map()
  for (const [kind, re] of Object.entries(RE)) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].trim().replace(/[，。、；：）】`'"]+$/, '')   // 去掉尾随中文标点
      if (!looksLikePath(raw)) continue
      // 只查带已知项目目录前缀的
      if (onlyProject && !PROJECT_PREFIXES.some((p) => raw.startsWith(p))) continue
      if (!out.has(raw)) out.set(raw, { ref: raw, from: kind })
    }
  }
  return [...out.values()]
}

/**
 * 在若干基准目录下找这个引用是否存在。
 * @param bases 基准目录（相对路径会依次在这些目录下尝试）
 * @returns {exists:boolean, hit:string|null}  hit = 命中的绝对路径
 */
export function resolveRef(ref, bases) {
  const cands = []
  if (/^[A-Za-z]:[\\/]/.test(ref)) {
    cands.push(ref)                                  // 绝对路径
  } else {
    for (const b of bases) cands.push(path.join(b, ref))
  }
  const norm = (p) => p.replace(/[\\/]+/g, path.sep)
  for (const c of cands) {
    try {
      if (fs.existsSync(norm(c))) return { exists: true, hit: norm(c) }
    } catch { /* 非法路径当不存在 */ }
  }
  return { exists: false, hit: null }
}

/**
 * 主入口：找出"提及了、但在给定基准目录下都找不到"的引用。
 *
 * @param text  当前思考/正文
 * @param opts.bases 基准目录数组（相对路径依次在这些目录下解析）
 * @param opts.maxCheck 最多检查多少个（防极端输入）
 * @returns {{checked:number, missing:[{ref,from}], found:number}}
 */
export function detectMissingRefs(text, opts = {}) {
  const bases = (opts.bases || []).filter(Boolean)
  const maxCheck = opts.maxCheck ?? 60
  const refs = extractRefs(text).slice(0, maxCheck)

  const missing = []
  let found = 0
  for (const r of refs) {
    const res = resolveRef(r.ref, bases)
    if (res.exists) found++
    else missing.push(r)
  }
  return { checked: refs.length, found, missing }
}

/**
 * 渲染。
 * ⚠️ 措辞：报"**未找到**"，不报"错误" —— 因为"打算创建某文件"是正常行为。
 *    判断留给使用者；本模块只提供"查过了，没找到"这个事实。
 * ⚠️ 不回显原文句子（只回报引用本身，那是待核对的标识符，不是判据触发词）。
 */
export function renderMissingRefs(pos, result) {
  if (!result || !result.missing?.length) return ''
  const where = pos ? `第 ${pos} 处` : '当前这段'
  const lines = [`${where} 里提到的以下路径，在已知位置均**未找到**（共查 ${result.checked} 个，找到 ${result.found} 个）：`]
  for (const m of result.missing.slice(0, 8)) lines.push(`- \`${m.ref}\``)
  if (result.missing.length > 8) lines.push(`- （另有 ${result.missing.length - 8} 个未列出）`)
  lines.push('若这些文件本就尚未创建，可忽略；若是引用已存在之物，请先核实。')
  return lines.join('\n')
}

/** 一组常用的基准目录（项目根 + 常见子目录），供调用方直接使用 */
export function defaultBases(projectRoot, extra = []) {
  if (!projectRoot) return extra.filter(Boolean)
  const subs = ['', '工具', '设定档案', '设定档案-JS', '※世界模拟', '※世界模拟\\回想', '交接', '教训', '记录', '报告']
  return [...subs.map((s) => path.join(projectRoot, s)), ...extra].filter(Boolean)
}

/**
 * 带【已知项目目录前缀】的引用，其基准应包含项目根的【上一级】——
 * 因为 `工具\_court.js` 这种写法，既可能相对项目根，也可能相对项目父目录。
 */
export function projectBases(projectRoot, extra = []) {
  const out = [...defaultBases(projectRoot, extra)]
  try { out.push(path.dirname(path.resolve(projectRoot))) } catch { /* ignore */ }
  return out
}
