/**
 * provider.js — 【可替代层】：嵌入 与 生成，**换后端不用改调用方**
 *
 * ══ 为什么要有它（作者 2026-10-16 要求）════════════════════════════
 *   > 「这些模型或组件**有没有上位替代**，**要做成能替代的**，使用者按需替换」
 *
 *   而实测的现状是：**模型名能换、后端换不了** ——
 *   `librarian.js` 把 `http://localhost:11434/api/embed` 写死在代码里，
 *   ⇒ 想换云端 API（DeepSeek／OpenAI）或 vLLM／LM Studio **都做不到**。
 *
 * ══ 抽象点为什么选「OpenAI 兼容协议」══════════════════════════════
 *   因为**一大片服务都提供它**，实现一个就通吃：
 *     · 云端：OpenAI · DeepSeek · Moonshot · 通义 · 智谱 · SiliconFlow …
 *     · 本地：**Ollama 自己**（`/v1/…`）· vLLM · LM Studio · llama.cpp server · text-embeddings-inference
 *   ⇒ 而 Ollama **原生**协议作为默认后端保留（向后兼容，且本机零配置就能跑）。
 *
 * ══ 三种后端 ═══════════════════════════════════════════════════
 *   | 值 | 说什么协议 | 需要什么 |
 *   |---|---|---|
 *   | `ollama`（默认） | Ollama 原生 `/api/embed` · `/api/generate` | 本机跑着 Ollama（零 API key） |
 *   | `openai` | **OpenAI 兼容** `/v1/embeddings` · `/v1/chat/completions` | `base_url`（＋通常要 api_key） |
 *   | `none` | **明确关掉** | ——（照样出声说明"没做"，不假装做了） |
 *
 * ══ 配置（环境变量，或 `~/.dsh/alert-inject.json`）════════════════
 *   | 变量 | 默认 | 说明 |
 *   |---|---|---|
 *   | `DSH_ALERT_PROVIDER` | `ollama` | `ollama` / `openai` / `none` |
 *   | `DSH_ALERT_BASE_URL` | 按后端定 | 例 `http://localhost:11434` ／ `https://api.deepseek.com` |
 *   | `DSH_ALERT_API_KEY` | 空 | `openai` 后端一般必填；**ollama 不用** |
 *   | `DSH_ALERT_EMBED_MODEL` | `bge-m3` | 嵌入模型名 |
 *   | `DSH_ALERT_LLM_MODEL` | `qwen2.5:3b` | 生成模型名 |
 *
 * ⚠️ 向后兼容：老的 `LIBRARIAN_MODEL` / `OLLAMA_HOST` **仍然有效**（映射过来）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG_FILE = process.env.DSH_ALERT_CONFIG || path.join(os.homedir(), '.dsh', 'alert-inject.json')

/** 读配置文件里 `provider` 那一段（**读不到就明说，不静默**） */
function fileConfig() {
  try { return (JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).provider) || {} } catch { return {} }
}

/**
 * 当前 provider 配置。
 * ⚠️ 优先级：**环境变量 ＞ 配置文件 ＞ 内置默认**（与本项目 `config.js` 同一套规矩）
 */
export function providerInfo() {
  const f = fileConfig()
  const kind = process.env.DSH_ALERT_PROVIDER || f.kind || 'ollama'
  const isOllama = kind === 'ollama'
  const baseUrl = (process.env.DSH_ALERT_BASE_URL || f.baseUrl ||
    (isOllama ? (process.env.OLLAMA_HOST || 'http://localhost:11434') : '')).replace(/\/+$/, '')
  // ⚠️ 老的 LIBRARIAN_MODEL 仍要能用（向后兼容），所以放在最前面
  const embedModel = process.env.DSH_ALERT_EMBED_MODEL || process.env.LIBRARIAN_MODEL || f.embedModel ||
    (isOllama ? 'bge-m3' : 'text-embedding-3-small')
  const llmModel = process.env.DSH_ALERT_LLM_MODEL || f.llmModel ||
    (isOllama ? 'qwen2.5:3b' : 'gpt-4o-mini')
  const apiKey = process.env.DSH_ALERT_API_KEY || f.apiKey || ''
  // ⚠️ 「能不能用」与「有没有配」是两件事 —— 这里只判**配置是否自洽**
  let problem = null
  if (kind === 'openai') {
    if (!baseUrl) problem = '选了 openai 后端，但没给 DSH_ALERT_BASE_URL（例：https://api.deepseek.com）'
    else if (!apiKey) problem = '选了 openai 后端，但没给 DSH_ALERT_API_KEY'
  } else if (kind === 'ollama') {
    if (!baseUrl) problem = '选了 ollama 后端，但没给 DSH_ALERT_BASE_URL'
  } else if (kind !== 'none') {
    problem = `不认识的 DSH_ALERT_PROVIDER：「${kind}」（只有 ollama／openai／none）`
  }
  return { kind, baseUrl, embedModel, llmModel, hasKey: !!apiKey, apiKey, problem, configFile: CONFIG_FILE, source: process.env.DSH_ALERT_PROVIDER ? '环境变量' : (f.kind ? CONFIG_FILE : '内置默认') }
}

function ensureUsable(what) {
  const p = providerInfo()
  if (p.kind === 'none') throw new Error(`${what}：provider 被设为 none（明确关掉了，不是"失败"）`)
  if (p.problem) throw new Error(`${what}：${p.problem}`)
  return p
}

/**
 * 嵌入向量。
 * @param texts 字符串数组
 * @returns {Promise<number[][]>}
 */
export async function embed(texts, { timeoutMs = 120000 } = {}) {
  const p = ensureUsable('嵌入')
  const arr = Array.isArray(texts) ? texts : [texts]
  if (!arr.length) return []

  const url = p.kind === 'ollama' ? p.baseUrl + '/api/embed' : p.baseUrl + '/v1/embeddings'
  const body = p.kind === 'ollama'
    ? { model: p.embedModel, input: arr }
    : { model: p.embedModel, input: arr }
  const headers = { 'Content-Type': 'application/json' }
  if (p.kind === 'openai' && p.apiKey) headers.Authorization = 'Bearer ' + p.apiKey

  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) {
    // ⚠️ 错误要**带上下文**（后端／模型／URL），否则使用者无从排查
    const t = await r.text().catch(() => '')
    throw new Error(`嵌入失败 [${p.kind} ${p.embedModel} @ ${p.baseUrl}] HTTP ${r.status}：${t.slice(0, 200)}`)
  }
  const j = await r.json()
  const out = p.kind === 'ollama' ? (j.embeddings || []) : (j.data || []).map((d) => d.embedding)
  if (!out.length) throw new Error(`嵌入返回为空 [${p.kind} ${p.embedModel}] —— 模型名对不对？`)
  return out
}

/**
 * 文本生成（分类、改写等用）。
 * @returns {Promise<string>}
 */
export async function generate(prompt, { timeoutMs = 180000, temperature = 0, model } = {}) {
  const p = ensureUsable('生成')
  const useModel = model || p.llmModel

  if (p.kind === 'ollama') {
    const r = await fetch(p.baseUrl + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: useModel, prompt, stream: false, options: { temperature } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      throw new Error(`生成失败 [ollama ${useModel} @ ${p.baseUrl}] HTTP ${r.status}：${t.slice(0, 200)}`)
    }
    const j = await r.json()
    return String(j.response || '')
  }

  // OpenAI 兼容：/v1/chat/completions
  const headers = { 'Content-Type': 'application/json' }
  if (p.apiKey) headers.Authorization = 'Bearer ' + p.apiKey
  const r = await fetch(p.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: useModel, temperature, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`生成失败 [openai ${useModel} @ ${p.baseUrl}] HTTP ${r.status}：${t.slice(0, 200)}`)
  }
  const j = await r.json()
  return String(j.choices?.[0]?.message?.content ?? '')
}

/**
 * 探活 —— 回答「**它到底能不能用**」（不是"我配了没"，而是"真的通不通"）。
 * @returns {{ok:boolean, kind:string, detail:string}}
 */
export async function healthCheck() {
  const p = providerInfo()
  if (p.kind === 'none') return { ok: false, kind: 'none', detail: '被明确设为 none ⇒ 依赖它的功能全部跳过（这是有意关闭，不是故障）' }
  if (p.problem) return { ok: false, kind: p.kind, detail: p.problem }
  try {
    const url = p.kind === 'ollama' ? p.baseUrl + '/api/tags' : p.baseUrl + '/v1/models'
    const headers = {}
    if (p.kind === 'openai' && p.apiKey) headers.Authorization = 'Bearer ' + p.apiKey
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    if (!r.ok) return { ok: false, kind: p.kind, detail: `连得上但返回 HTTP ${r.status}（URL／key 可能不对）：${p.baseUrl}` }
    return { ok: true, kind: p.kind, detail: `${p.kind} 可用 · 嵌入模型 ${p.embedModel} · 生成模型 ${p.llmModel} · ${p.baseUrl}` }
  } catch (e) {
    return { ok: false, kind: p.kind, detail: `连不上 ${p.baseUrl}：${e?.message || e}` }
  }
}

/** 一段给人看的话（体检报告／说明书用） */
export function renderProvider() {
  const p = providerInfo()
  const L = []
  L.push(`  后端：${p.kind}　（配置来源：${p.source}）`)
  L.push(`  地址：${p.baseUrl || '（没配）'}`)
  L.push(`  嵌入模型：${p.embedModel}`)
  L.push(`  生成模型：${p.llmModel}`)
  L.push(`  API key：${p.hasKey ? '已配置' : '（没有 —— ollama 不需要；openai 后端需要）'}`)
  if (p.problem) L.push(`  ⚠️ ${p.problem}`)
  L.push('')
  L.push('  想换后端？只改配置，不改代码：')
  L.push('    ollama（默认，本机跑）：  DSH_ALERT_PROVIDER=ollama')
  L.push('    任何 OpenAI 兼容服务：    DSH_ALERT_PROVIDER=openai')
  L.push('                              DSH_ALERT_BASE_URL=https://api.deepseek.com')
  L.push('                              DSH_ALERT_API_KEY=sk-...')
  L.push('    明确关掉：                DSH_ALERT_PROVIDER=none')
  return L.join('\n')
}
