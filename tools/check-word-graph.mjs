/**
 * check-word-graph.mjs —— 词频统计（你手绘图上那个纵轴）
 *
 * ⚠️ 为什么不用 Python 重写读会话：会话是 `.zstd` **多帧**拼接，项目里
 *    `lib/index.js` 的 `recentActivity()` 已经处理好了（含多帧、含"排除平台注入物"）。
 *    我第一版用 Python `zlib` 去解 zstd ⇒ **解不出来且不报错**（候选词 0 个），
 *    正是本项目反复抓的那类"静默失败"。
 *    ⇒ **复用已验证的实现，不要自己重写解析。**
 *
 * 只读、不写任何库。产出：真实语料里值得当"节点"的词 + 它们与意图表的覆盖情况。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recentActivity } from '../lib/index.js'

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '_laya-test', 'result_words.txt')
const SESS = path.join(os.homedir(), '.dsh', 'sessions')

// ── 1. 收集会话 ──
const files = []
const walk = (d, depth = 0) => {
  if (depth > 8) return
  let es = []
  try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of es) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, depth + 1)
    else if (e.name === 'session.jsonl.zstd') files.push(p)
  }
}
walk(SESS)
console.log(`会话文件 ${files.length} 个`)

// ── 2. 取作者发言（复用项目的 recentActivity）──
const utts = []
const seen = new Set()
let scanned = 0
for (const f of files) {
  let acts = []
  try { acts = recentActivity(f, 0) } catch { continue }
  scanned++
  for (const a of acts) {
    if (a.kind !== '用户') continue
    const t = String(a.text || '').trim()
    if (t.length < 2 || t.length > 500) continue
    if (seen.has(t)) continue
    seen.add(t)
    utts.push(t)
  }
}
console.log(`扫了 ${scanned} 个会话；作者发言去重后 ${utts.length} 条`)

// ── 3. n-gram 统计（2~4 字）──
const CJK = /[\u4e00-\u9fff]+/g
const cnt = new Map()       // 总频
const doc = new Map()       // 出现在多少条不同发言里
for (const t of utts) {
  const segs = t.match(CJK) || []
  const inThis = new Set()
  for (const seg of segs) {
    for (const n of [2, 3, 4]) {
      for (let i = 0; i + n <= seg.length; i++) {
        const g = seg.slice(i, i + n)
        cnt.set(g, (cnt.get(g) || 0) + 1)
        inThis.add(g)
      }
    }
  }
  for (const g of inThis) doc.set(g, (doc.get(g) || 0) + 1)
}

const cands = [...doc.entries()].filter(([, f]) => f >= 3)
  .map(([g, f]) => ({ g, docf: f, raw: cnt.get(g) || 0 }))
  .sort((a, b) => b.docf - a.docf || b.raw - a.raw)
console.log(`候选词（出现于 ≥3 条发言）${cands.length} 个`)

// ── 4. 与意图表比对 ──
const taxPath = new URL('../lib/defaults/user-intents.json', import.meta.url)
const TAX = JSON.parse(fs.readFileSync(taxPath, 'utf8'))
const nodeWords = new Map()
const gramOf = (s, out) => { for (const seg of (String(s).match(CJK) || [])) for (const n of [2, 3, 4]) for (let i = 0; i + n <= seg.length; i++) out.add(seg.slice(i, i + n)) }
for (const d of TAX.dimensions) {
  for (const m of d.modes) {
    const ws = new Set()
    gramOf(m.name, ws); gramOf(m.desc, ws)
    for (const e of (m.examples || [])) gramOf(e, ws)
    for (const ch of (m.children || [])) { gramOf(ch.name, ws); gramOf(ch.desc, ws); for (const e of (ch.examples || [])) gramOf(e, ws) }
    nodeWords.set(`${d.code}.${m.code}`, ws)
  }
}

const covered = (g) => { const hit = []; for (const [n, ws] of nodeWords) if (ws.has(g)) hit.push(n); return hit }

const L = []
const w = (s = '') => { L.push(s); console.log(s) }

w('='.repeat(72))
w('  真实语料的词频（手绘图上的纵轴）—— 数据来源：复用项目的 recentActivity')
w('='.repeat(72))
w(`  会话 ${files.length} 个 · 作者发言去重 ${utts.length} 条 · 候选词 ${cands.length} 个`)
w('')
w('── 词频 Top 50（按【出现于多少条不同发言】排；比总频更稳）──')
let matched = 0
for (const c of cands.slice(0, 50)) {
  const hit = covered(c.g)
  if (hit.length) matched++
  w(`  ${c.g.padEnd(7)} 出现于 ${String(c.docf).padStart(4)} 条（共 ${String(c.raw).padStart(5)} 次）${hit.length ? '  ← ' + hit.slice(0, 3).join(',') : ''}`)
}

let allMatched = 0
for (const c of cands) if (covered(c.g).length) allMatched++
w('')
w('── 覆盖情况 ──')
w(`  候选词里能挂到某个意图节点上的：${allMatched} / ${cands.length}（${(allMatched / Math.max(cands.length, 1) * 100).toFixed(0)}%）`)
w(`  ⇒ 剩下 ${cands.length - allMatched} 个是【意图表里还没有的词】—— 那正是「表该长什么」的线索`)
w('')
w('── 未被意图表覆盖的高频词 Top 40（表要长，优先看这些）──')
let n = 0
for (const c of cands) {
  if (covered(c.g).length) continue
  w(`  ${c.g.padEnd(7)} 出现于 ${String(c.docf).padStart(4)} 条`)
  if (++n >= 40) break
}

fs.writeFileSync(OUT, L.join('\n'), 'utf8')
console.log('\n已写到', OUT)
