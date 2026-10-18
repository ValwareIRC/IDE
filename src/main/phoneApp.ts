// The page a phone opens to control Prism (main/phone.ts serves it). One self-contained file: pairing, the
// list of sessions, and one session with what waits on the user, the conversation, and a message box.
export const PHONE_APP = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0d13">
<title>Prism</title>
<style>
:root { --bg: #07080c; --bg1: #0f1219; --bg2: #161a25; --line: rgba(255,255,255,.08); --text: #e9ecf4; --text2: #a7aec0; --text3: #6d7489; --accent: #8ad8ff; --mint: #7ee8c3; --amber: #ffc46b; --rose: #ff7b93; --violet: #b9a7ff }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif }
body { min-height: 100dvh; display: flex; flex-direction: column }
header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; padding: 12px 16px; padding-top: max(12px, env(safe-area-inset-top)); background: rgba(7,8,12,.92); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line) }
header h1 { font-size: 16px; margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
header .sub { font-size: 12px; color: var(--text3) }
button { font: inherit; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 10px; padding: 9px 14px; cursor: pointer }
button.primary { background: var(--accent); color: #07080c; border-color: transparent; font-weight: 600 }
button.danger { color: var(--rose) }
button.ghost { background: none }
main { flex: 1; padding: 12px 16px 120px }
.card { background: var(--bg1); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; margin-bottom: 10px }
.row { display: flex; gap: 8px; align-items: center }
.grow { flex: 1; min-width: 0 }
.muted { color: var(--text3); font-size: 13px }
.chip { font-size: 12px; border-radius: 999px; padding: 2px 9px; background: var(--bg2); color: var(--text2); white-space: nowrap }
.chip.run { color: var(--accent) } .chip.wait { color: var(--amber); background: rgba(255,196,107,.12) }
.session { display: block; width: 100%; text-align: left; margin-bottom: 8px }
.session .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.pair { max-width: 360px; margin: 18vh auto 0; text-align: center }
.pair input { width: 100%; font: 600 28px/1 ui-monospace, monospace; letter-spacing: .3em; text-align: center; padding: 14px; border-radius: 14px; border: 1px solid var(--line); background: var(--bg1); color: var(--text); margin: 16px 0 }
.err { color: var(--rose); font-size: 14px; min-height: 20px }
.wait { border-color: rgba(255,196,107,.4) }
.wait h3 { margin: 0 0 6px; font-size: 14px; color: var(--amber) }
.cmd { font: 13px/1.45 ui-monospace, monospace; background: var(--bg2); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; margin: 6px 0 10px; max-height: 180px; overflow: auto }
.acts { display: flex; gap: 8px; flex-wrap: wrap }
.acts button { flex: 1 }
.msg { margin: 10px 0 }
.you { margin-left: 18%; background: rgba(138,216,255,.12); border: 1px solid rgba(138,216,255,.22); border-radius: 14px 14px 4px 14px; padding: 8px 12px; white-space: pre-wrap; word-break: break-word }
.answer { white-space: pre-wrap; word-break: break-word }
.said { color: var(--text2); font-size: 14px; white-space: pre-wrap }
.step { color: var(--text3); font-size: 13px; padding-left: 10px; border-left: 2px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.step.bad { color: var(--rose) }
.note { color: var(--violet); font-size: 13px; white-space: pre-wrap }
.time { color: var(--text3); font-size: 11px; margin-top: 2px }
.activity { display: flex; gap: 8px; align-items: center; color: var(--text2); font-size: 14px; margin: 12px 0 }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: p 1.1s infinite }
@keyframes p { 50% { opacity: .3 } }
footer { position: fixed; left: 0; right: 0; bottom: 0; padding: 10px 12px; padding-bottom: max(10px, env(safe-area-inset-bottom)); background: rgba(7,8,12,.95); backdrop-filter: blur(12px); border-top: 1px solid var(--line); display: flex; gap: 8px; align-items: flex-end }
footer textarea { flex: 1; min-height: 44px; max-height: 140px; resize: none; font: inherit; color: var(--text); background: var(--bg1); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px }
.opt { display: block; width: 100%; text-align: left; margin-top: 6px }
code { font: 13px ui-monospace, monospace; background: var(--bg2); border-radius: 5px; padding: 1px 5px }
.opt small { display: block; color: var(--text3) }
</style>
</head>
<body>
<div id="app"></div>
<script>
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const md = (s) => esc(s).replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<b>$1</b>').replace(/\\x60([^\\x60\\n]+)\\x60/g, '<code>$1</code>')
let token = localStorage.getItem('prism-token') || ''
let current = null
let timer = 0

async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'x-prism-token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  if (r.status === 401) { token = ''; localStorage.removeItem('prism-token'); pairScreen(); throw new Error('Not paired') }
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || 'Something went wrong')
  return j
}
const when = (ts) => { const d = new Date(ts); const today = new Date().toDateString() === d.toDateString(); return (today ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }

function pairScreen(msg) {
  $('#app').innerHTML = '<div class="pair"><h2>Prism</h2><div class="muted">Type the six digits Prism shows under Settings, Helpers &amp; extras, Control from your phone.</div><input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"><div class="err" id="err">' + esc(msg || '') + '</div><button class="primary" id="go" style="width:100%">Pair this phone</button></div>'
  const go = async () => {
    try {
      const r = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('#code').value.trim() }) })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error)
      token = j.token; localStorage.setItem('prism-token', token); listen(); listScreen()
    } catch (e) { $('#err').textContent = e.message }
  }
  $('#go').onclick = go
  $('#code').onkeydown = (e) => e.key === 'Enter' && go()
  $('#code').focus()
}

async function listScreen() {
  current = null
  const j = await api('/api/sessions')
  $('#app').innerHTML = '<header><h1>' + esc(j.project || 'Prism') + '</h1><span class="sub">' + j.sessions.length + ' sessions</span></header><main>' +
    j.sessions.map((s) => '<button class="card session" data-id="' + s.id + '"><div class="row"><span class="t grow">' + esc(s.title) + '</span>' +
      (s.waiting ? '<span class="chip wait">needs you</span>' : s.status === 'running' ? '<span class="chip run">working</span>' : '') + '</div><div class="time">' + when(s.updatedAt) + '</div></button>').join('') + '</main>'
  document.querySelectorAll('.session').forEach((b) => (b.onclick = () => sessionScreen(b.dataset.id)))
}

async function sessionScreen(id) {
  current = id
  const j = await api('/api/session/' + id)
  if (current !== id) return
  const running = j.status === 'running'
  const waits = j.approvals.map((a) => '<div class="card wait"><h3>Approve?</h3><div>' + esc(a.summary) + '</div>' + (a.concern ? '<div class="muted">' + esc(a.concern) + '</div>' : '') +
    (a.call && a.call.args && a.call.args.command ? '<div class="cmd">' + esc(a.call.args.command) + '</div>' : '') +
    '<div class="acts"><button class="primary" data-ap="' + a.approvalId + '" data-d="once">Allow</button><button data-ap="' + a.approvalId + '" data-d="always">Always</button><button class="danger" data-ap="' + a.approvalId + '" data-d="deny">Deny</button></div></div>').join('') +
    j.questions.map((q) => '<div class="card wait"><h3>It asks</h3><div style="white-space:pre-wrap">' + esc(q.question) + '</div>' +
      q.options.map((o) => '<button class="opt" data-q="' + q.questionId + '" data-a="' + esc(o.label) + '">' + esc(o.label) + (o.description ? '<small>' + esc(o.description) + '</small>' : '') + '</button>').join('') + '</div>').join('')
  const msgs = j.items.map((m) => '<div class="msg"><div class="' + m.kind + (m.bad ? ' bad' : '') + '">' + (m.kind === 'answer' || m.kind === 'said' ? md(m.text) : esc(m.text)) + '</div>' + (m.kind === 'you' || m.kind === 'answer' ? '<div class="time" style="' + (m.kind === 'you' ? 'text-align:right' : '') + '">' + when(m.ts) + '</div>' : '') + '</div>').join('')
  const keep = $('#box') ? $('#box').value : ''
  $('#app').innerHTML = '<header><button class="ghost" id="back">‹</button><h1>' + esc(j.title) + '</h1>' + (running ? '<button class="danger" id="stop">Stop</button>' : '') + '</header><main>' + waits + msgs +
    (running ? '<div class="activity"><span class="dot"></span>' + esc(j.activity || 'Working…') + '</div>' : '') + '</main>' +
    '<footer><textarea id="box" placeholder="' + (running ? 'Tell it something now…' : 'Ask Prism…') + '"></textarea><button class="primary" id="send">Send</button></footer>'
  $('#box').value = keep
  $('#back').onclick = listScreen
  if ($('#stop')) $('#stop').onclick = () => api('/api/session/' + id + '/stop', {}).then(() => sessionScreen(id))
  $('#send').onclick = async () => { const text = $('#box').value.trim(); if (!text) return; $('#box').value = ''; await api('/api/session/' + id + '/send', { text }); setTimeout(() => sessionScreen(id), 400) }
  document.querySelectorAll('[data-ap]').forEach((b) => (b.onclick = () => api('/api/session/' + id + '/approve', { approvalId: b.dataset.ap, decision: b.dataset.d }).then(() => sessionScreen(id))))
  document.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => api('/api/session/' + id + '/answer', { questionId: b.dataset.q, answer: b.dataset.a }).then(() => sessionScreen(id))))
  window.scrollTo(0, document.body.scrollHeight)
}

function listen() {
  const es = new EventSource('/api/events?token=' + encodeURIComponent(token))
  es.onmessage = (e) => {
    const m = JSON.parse(e.data)
    clearTimeout(timer)
    timer = setTimeout(() => { if (current && (!m.sessionId || m.sessionId === current)) sessionScreen(current); else if (!current) listScreen() }, 350)
  }
  es.onerror = () => { es.close(); setTimeout(() => token && listen(), 3000) }
}

if (token) { listen(); listScreen().catch(() => {}) } else pairScreen()
</script>
</body>
</html>`
