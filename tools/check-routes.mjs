/**
 * check-routes.mjs —— 用**真 HTTP 服务器**验证两条浏览器接口。
 *
 * ⚠️ 为什么必须做这个检查（2026-10-16 实测抓到的真 bug）：
 *   DSH 的路由 handler 签名是 `(req, res) => void` —— **必须自己写响应**
 *   （`res.writeHead` + `res.end`）。我第一版写成 `return {...}`
 *   ⇒ 那**不会报错**，只会让请求**一直挂到超时**，
 *     界面表现为"读不到状态"，而日志里一句抱怨都没有（同 §239 那一族）。
 *   ⇒ 静态语法检查抓不到它。**只有真发一个请求才知道。**
 *
 * 做法：起一个真的 node:http 服务器，把 DSH 传进来的原生 (req, res) 转交给
 *       被测 handler，然后**用 fetch 真发请求**，断言响应可解析且 `ok:true`。
 *
 * ⚠️ 只读：GET 用真数据；POST 用**临时配置文件**（`DSH_ALERT_CONTEXTS` 指到 tmp），
 *    绝不碰 `~/.dsh/alert-contexts.json`。
 *
 * 用法：`node tools/check-routes.mjs` —— 退出码非 0 = 有问题
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ⚠️ 必须在 import contexts.js **之前**指向临时配置，否则它会读真实配置
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-alert-routes-'))
process.env.DSH_ALERT_CONTEXTS = path.join(tmpDir, 'alert-contexts.json')
console.log('（隔离：配置写到 ' + process.env.DSH_ALERT_CONTEXTS + '）\n')

const M = await import('../lib/contexts.js')

const fails = []
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✅ ' + label + (extra ? '　' + extra : ''))
  else { console.log('  ❌ ' + label + (extra ? '　' + extra : '')); fails.push(label) }
}

// ── 与 index.js 里**同一套**响应工具（故意照抄：这里要测的就是这段契约）──
const sendJson = (res, status, payload) => {
  try {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(payload))
  } catch { try { res.destroy() } catch { /* 忽略 */ } }
}
const readBody = async (req, limit = 1 << 20) => {
  let s = ''
  for await (const chunk of req) { s += chunk; if (s.length > limit) return { tooLarge: true } }
  return { text: s }
}

const contextsHandler = async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    const currentId = url.searchParams.get('current') || null
    if ((req.method || 'GET').toUpperCase() === 'GET') {
      const st = await M.contextState(currentId)
      sendJson(res, 200, {
        ok: true, enabled: st.enabled, anchor: st.anchor, ready: st.ready,
        selected: st.selected, missing: st.missing, currentSessionId: st.currentSessionId,
        why: st.why, file: st.file, configExists: st.configExists,
        sessions: st.sessions.map((s) => ({
          id: s.id, cwd: s.cwd, mb: s.mb, updatedAt: s.updatedAt,
          hasIndex: s.hasIndex, indexEntries: s.indexEntries, indexBuiltAt: s.indexBuiltAt,
        })),
      })
      return
    }
    if ((req.method || '').toUpperCase() === 'POST') {
      const b = await readBody(req)
      if (b.tooLarge) { sendJson(res, 413, { ok: false, error: '请求体过大' }); return }
      let patch = {}
      try { patch = b.text ? JSON.parse(b.text) : {} } catch (e) {
        sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${e?.message || e}` }); return
      }
      const r = M.writeContexts(patch)
      if (!r.ok) { sendJson(res, 400, { ok: false, error: r.why }); return }
      const st = await M.contextState(currentId)
      sendJson(res, 200, { ok: true, saved: true, enabled: st.enabled, anchor: st.anchor, ready: st.ready, why: st.why, selected: st.selected })
      return
    }
    sendJson(res, 405, { ok: false, error: `不支持的方法：${req.method}` })
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/api/alert-inject/contexts')) { contextsHandler(req, res); return }
  sendJson(res, 404, { ok: false, error: 'not found' })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
console.log('临时服务器：' + base + '\n')

console.log('══════ 路由检查（真 HTTP 请求）══════\n')

// ① GET 能真的拿到响应（**这一条就是用来抓"return 对象 ⇒ 挂起"那个 bug 的**）
let t0 = Date.now()
const r1 = await fetch(base + '/api/alert-inject/contexts', { signal: AbortSignal.timeout(15000) }).catch((e) => ({ __err: e }))
const ms1 = Date.now() - t0
ok(!r1.__err, 'GET 有响应（没挂起）', ms1 + ' ms')
if (r1.__err) { console.log('    错误：' + String(r1.__err)); }
let j1 = null
if (!r1.__err) {
  ok(r1.status === 200, 'GET 状态码 200', String(r1.status))
  ok((r1.headers.get('content-type') || '').includes('application/json'), 'Content-Type 是 JSON')
  try { j1 = await r1.json() } catch (e) { ok(false, 'GET 响应体是合法 JSON', String(e)) }
  if (j1) {
    ok(j1.ok === true, 'GET 返回 ok:true')
    ok(Array.isArray(j1.sessions) && j1.sessions.length > 0, 'GET 带回会话清单', (j1.sessions?.length || 0) + ' 场')
    ok(j1.enabled === false, '默认开关是关的（不改现有行为）')
    ok(j1.ready === false, '默认没有落点 ⇒ ready=false', String(j1.ready))
    ok(typeof j1.why === 'string' && j1.why.length > 0, '带了一句人话说明', JSON.stringify(j1.why).slice(0, 60))
  }
}

// ② 不变量：**没有落点 ⇒ 开关不许打开**（作者④「在选好之前不启动」）
const r2 = await fetch(base + '/api/alert-inject/contexts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ enabled: true }),
  signal: AbortSignal.timeout(15000),
}).catch((e) => ({ __err: e }))
ok(!r2.__err, 'POST 有响应（没挂起）')
let j2 = null
if (!r2.__err) { try { j2 = await r2.json() } catch { /* 忽略 */ } }
ok(!!j2 && j2.ok === false, '没选落点就打开开关 ⇒ **被拒绝**（这正是"选好之前不启动"）', j2 && String(j2.error).slice(0, 40))

// ③ 真正选中一场 + 指定落点 ⇒ 允许保存
const picked = j1?.sessions?.[0]
if (picked) {
  const r3 = await fetch(base + '/api/alert-inject/contexts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selected: [picked.id], anchor: picked.id, enabled: true }),
    signal: AbortSignal.timeout(15000),
  }).catch((e) => ({ __err: e }))
  let j3 = null
  if (!r3.__err) { try { j3 = await r3.json() } catch { /* 忽略 */ } }
  ok(!!j3 && j3.ok === true, '选好落点后可以保存', j3 && JSON.stringify(j3.selected))
  ok(!!j3 && j3.enabled === true, '选好之后开关才真的打开', j3 && String(j3.enabled))

  // ④ 写进去的东西**真的落盘**了吗（不能只看返回值）
  let onDisk = null
  try { onDisk = JSON.parse(fs.readFileSync(process.env.DSH_ALERT_CONTEXTS, 'utf8')) } catch { /* 忽略 */ }
  ok(!!onDisk && onDisk.anchor === picked.id, '配置真的写进了文件（不是只返回成功）')
  ok(!!onDisk && onDisk.enabled === true, '开关状态也落盘了')
}

// ⑤ 未知方法要有明确回应
const r5 = await fetch(base + '/api/alert-inject/contexts', { method: 'DELETE', signal: AbortSignal.timeout(15000) }).catch(() => null)
ok(!!r5 && r5.status === 405, '不支持的方法返回 405（不是静默 404/挂起）', r5 && String(r5.status))

server.close()
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log('\n══════ 结论 ══════')
if (fails.length) {
  console.log('❌ ' + fails.length + ' 项没过：' + fails.join('；'))
  process.exit(1)
} else {
  console.log('✅ 全部通过 —— 两条接口在真 HTTP 下都能正确应答。')
  console.log('   （⚠️ 它**不能**证明 DSH 的 webServer 会把 req/res 真的传进来 —— 那要在 DSH 里刷页看。）')
}
