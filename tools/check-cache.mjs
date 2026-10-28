/**
 * check-cache.mjs —— **前缀缓存命中率**观察器（2026-10-27 加）
 *
 * ══ 为什么需要它（作者原话：「如果在缓存前塞东西的话，怎么观察命中率」）══════
 *   alert-inject 和 graph-memory 都会往上下文里塞东西：
 *     · alert-inject：静态前置指令（落缓存前缀，**不打断**）
 *     · graph-memory：Prompt Assembly 阶段**注入召回的记忆**（每轮内容可能不同 ⇒ **有打断风险**）
 *   ⇒ 光说「可能会掉」不够，**要能量**。
 *
 * ══ 数据从哪来（已实测确认）═════════════════════════════════════════
 *   会话日志里 `assistant/chunk` 事件的 `data.chunk.usage`：
 *     { inputTokens: 12634, outputTokens: 22, cacheReadTokens: 0, reasoningTokens: 0 }
 *     { inputTokens: 320,   outputTokens: 2038, cacheReadTokens: 12544, reasoningTokens: 767 }
 *   ⇒ **命中率 = cacheReadTokens / (inputTokens + cacheReadTokens)**
 *     （inputTokens 是"未命中的输入"，cacheReadTokens 是"命中缓存的输入"）
 *
 * 用法：
 *   node tools/check-cache.mjs                # 最近的会话
 *   node tools/check-cache.mjs <会话文件>
 *   node tools/check-cache.mjs --tail 30      # 只看最后 30 步的逐条
 *
 * ⚠️ 判读方法（很重要）：
 *   看**序列**而不是平均值。健康的长会话：cacheReadTokens **只增不减**，
 *   命中率随上下文增长而上升。**若某一步突然掉到 0 或腰斩 ⇒ 前缀被打断**，
 *   那一刻附近变更（新插件、新注入）就是嫌疑人。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readSessionText } from '../lib/inflate.js'

const argv = process.argv.slice(2)
const get = (k, d = null) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1] }
const tailN = +(get('--tail', 0))
const fileArg = argv.find((a) => a && !a.startsWith('--') && !a.startsWith('-') && /\.zstd$/.test(a))

function latestSession() {
  const ROOT = path.join(os.homedir(), '.dsh', 'sessions')
  let best = null
  for (const ws of fs.readdirSync(ROOT)) {
    const wd = path.join(ROOT, ws)
    try { if (!fs.statSync(wd).isDirectory()) continue } catch { continue }
    for (const sid of fs.readdirSync(wd)) {
      const f = path.join(wd, sid, 'session.jsonl.zstd')
      try { const st = fs.statSync(f); if (!best || st.mtimeMs > best.mtime) best = { f, mtime: st.mtimeMs } } catch { /* 无日志 */ }
    }
  }
  return best?.f || null
}

const file = fileArg || latestSession()
if (!file) { console.error('❌ 找不到会话文件'); process.exit(1) }
const text = readSessionText(file)
if (!text) { console.error('❌ 解压失败：' + file); process.exit(1) }

// ── 收集每步的 usage ─────────────────────────────────────────────
const steps = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let r
  try { r = JSON.parse(line) } catch { continue }
  if (!r || typeof r !== 'object' || r.type !== 'assistant/chunk') continue
  const u = r.data?.chunk?.usage
  if (!u) continue
  const cache = +u.cacheReadTokens || 0
  const input = +u.inputTokens || 0
  const total = input + cache
  steps.push({
    turn: r.data?.turn, step: r.data?.step,
    input, cache,
    hitRate: total ? cache / total : null,
  })
}

if (!steps.length) {
  console.log('📄 ' + file)
  console.log('⚠️ 没有找到带 usage 的 assistant/chunk —— **这不是"命中率 0%"，是"这个会话里没有缓存数据"**')
  process.exit(0)
}

console.log('📄 ' + path.basename(path.dirname(file)) + '\\' + path.basename(file))
console.log(`   共 ${steps.length} 步带 usage\n`)

// ── 全局统计 ─────────────────────────────────────────────────────
const rat = steps.filter((s) => s.hitRate != null)
const avg = rat.reduce((a, s) => a + s.hitRate, 0) / (rat.length || 1)
const zero = steps.filter((s) => s.cache === 0 && s.input > 0).length
const maxCache = Math.max(...steps.map((s) => s.cache))
console.log('【全局】')
console.log(`   平均命中率 ${(avg * 100).toFixed(1)}%`)
console.log(`   完全未命中（cacheRead=0）的步：${zero} / ${steps.length}`)
console.log(`   缓存命中最大值：${maxCache} tokens`)

// ── 尾部逐条（看趋势/断点）───────────────────────────────────────
const show = tailN > 0 ? steps.slice(-tailN) : steps.slice(-20)
console.log(`\n【最后 ${show.length} 步】（看 cacheRead 是"只增不减"还是"突然腰斩"）`)
console.log('   turn/step      input     cache   hit%')
for (const s of show) {
  const pct = s.hitRate == null ? '   -' : `${(s.hitRate * 100).toFixed(0)}%`.padStart(6)
  console.log(`   ${String(s.turn).padStart(4)}/${String(s.step).padEnd(4)} ${String(s.input).padStart(8)} ${String(s.cache).padStart(8)} ${pct}`)
}

// ── 断点检测 ────────────────────────────────────────────────────
const drops = []
for (let i = 1; i < steps.length; i++) {
  const a = steps[i - 1], b = steps[i]
  // 命中量突然腰斩到 40% 以下，且之前有量 ⇒ 疑似前缀被打断
  if (a.cache > 1000 && b.cache < a.cache * 0.4) drops.push({ i, from: a, to: b })
}
console.log(`\n【疑似断点】${drops.length} 处`)
for (const d of drops.slice(-5)) {
  console.log(`   第 ${d.i} 步起：cacheRead ${d.from.cache} → ${d.to.cache}`
    + `（turn ${d.to.turn}/${d.to.step}）`)
}
if (!drops.length) console.log('   ✅ 没有发现"命中量腰斩" —— 缓存前缀是连续复用的。')
