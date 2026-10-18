// Shows a gadget's page in an ordinary browser, talking to its real backend, so its
// look can be checked (with Prism's own browser panel) before it ships, and without
// launching a second Prism.
//
//   node scripts/gadget-test/preview.mjs build/gadgets/release --root <project folder> [--port 8799]
//
// The page gets Prism's stylesheets and kit inline, and a stand-in for window.prism
// whose calls go to this server, which runs the backend with the same stand-in api
// as run.mjs. What the backend emits reaches the page as server-sent events.
import { exec, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.removeAllListeners('warning')
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const argv = process.argv.slice(2)
const flag = (name, d) => {
  const i = argv.indexOf(name)
  if (i < 0) return d
  const v = argv[i + 1]
  argv.splice(i, 2)
  return v
}
const root = resolve(flag('--root', process.cwd()))
const port = Number(flag('--port', '8799'))
const dir = resolve(argv[0])
const manifest = JSON.parse(readFileSync(join(dir, 'gadget.json'), 'utf8'))
const { GADGET_BASE_CSS } = await import(pathToFileURL(join(repo, 'src/core/gadgets/sdk.ts')).href)
const { GADGET_KIT_CSS, GADGET_KIT_JS } = await import(pathToFileURL(join(repo, 'src/core/gadgets/kit.ts')).href)

const listeners = new Set()
const emit = (event, data) => {
  const line = `data: ${JSON.stringify({ event, data })}\n\n`
  for (const res of listeners) res.write(line)
}
const dataDir = join(tmpdir(), 'prism-gadget-test', manifest.id)
mkdirSync(dataDir, { recursive: true })
const stateFile = join(dataDir, '..', `${manifest.id}.state.json`)
const readState = () => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return {}
  }
}
const secrets = new Map()
const api = {
  dir,
  root,
  dataDir,
  emit,
  log: (...p) => console.log('[log]', ...p),
  agent: { send: async (t) => console.log('[agent.send]', t) },
  ui: {
    toast: async (t, d) => console.log('[toast]', t, d ?? ''),
    openFile: async (p) => console.log('[openFile]', p),
    openPreview: async (p) => console.log('[openPreview]', p),
    show: async () => {},
    attach: async (p, n) => console.log('[attach]', p, n ?? ''),
    notify: async (t, b) => console.log('[notify]', t, b ?? '')
  },
  capture: async () => {
    throw new Error('pictures of pages need Prism itself')
  },
  secrets: { get: async (k) => secrets.get(k) ?? null, set: async (k, v) => (v == null ? secrets.delete(k) : secrets.set(k, v)) },
  workspace: {
    read: async (p) => readFileSync(join(root, p), 'utf8'),
    write: async (p, c) => {
      mkdirSync(dirname(join(root, p)), { recursive: true })
      writeFileSync(join(root, p), c)
    },
    list: async (p) => readdirSync(join(root, p ?? '.')).map((name) => ({ name, type: statSync(join(root, p ?? '.', name)).isDirectory() ? 'dir' : 'file' }))
  },
  state: {
    get: async (k, f) => (k in readState() ? readState()[k] : f),
    set: async (k, v) => writeFileSync(stateFile, JSON.stringify({ ...readState(), [k]: v }, null, 2))
  },
  shell: (command, opts = {}) =>
    new Promise((res) =>
      exec(command, { cwd: opts.cwd || root, timeout: opts.timeoutMs || 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
        res({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })
      )
    ),
  spawn(command, args = [], opts = {}) {
    const child = spawn(command, args, { cwd: opts.cwd || root, windowsHide: true, env: { ...process.env, ...(opts.env || {}) }, shell: opts.shell })
    child.stdout?.on('data', (d) => opts.onData?.(String(d), 'stdout'))
    child.stderr?.on('data', (d) => opts.onData?.(String(d), 'stderr'))
    child.on('close', (code) => opts.onExit?.(code))
    return { pid: child.pid, write: (d) => child.stdin?.write(d), kill: () => spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }), exited: new Promise((r) => child.on('close', r)) }
  },
  serve: () => Promise.reject(new Error('not in the preview'))
}

const mod = (await import(pathToFileURL(join(dir, manifest.backend ?? 'backend.mjs')).href)).default
await mod.start?.(api)

const FAKE_PRISM = `(() => {
  const listeners = new Map(); const ready = [];
  const on = (ev, cb) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(cb); return () => listeners.get(ev).delete(cb) };
  const call = async (method, args) => {
    const r = await fetch('/call', { method: 'POST', body: JSON.stringify({ method, args: args || {} }) });
    const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
  };
  const host = (m, a) => call('__host', { method: m, args: a });
  new EventSource('/events').onmessage = (e) => { const { event, data } = JSON.parse(e.data);
    for (const cb of listeners.get(event) || []) cb(data); for (const cb of listeners.get('*') || []) cb(event, data) };
  window.prism = { call, on, ready: (cb) => ready.push(cb), theme: { vars: {} },
    agent: { send: (text) => host('agent.send', { text }) },
    ui: { toast: (t, d) => host('ui.toast', { title: t, detail: d }), openFile: (p) => host('ui.openFile', { path: p }), openPreview: (p) => host('ui.openPreview', { path: p }), show: () => {}, attach: (p, n) => host('ui.attach', { path: p, note: n }), notify: (t, b) => host('ui.notify', { title: t, body: b }) },
    capture: () => Promise.reject(new Error('pictures of pages need Prism itself')),
    secrets: { get: (k) => host('secret.get', { key: k }), set: (k, v) => host('secret.set', { key: k, value: v }) },
    workspace: { read: (p) => host('workspace.read', { path: p }), write: (p, c) => host('workspace.write', { path: p, content: c }), list: (p) => host('workspace.list', { path: p }) },
    state: { get: (k, f) => host('state.get', { key: k, fallback: f }), set: (k, v) => host('state.set', { key: k, value: v }) },
    shell: (c, o) => host('shell', { command: c, ...(o || {}) }) };
  addEventListener('DOMContentLoaded', () => { document.body.classList.add('prism-themed'); setTimeout(() => ready.forEach((cb) => cb()), 30) });
})();`

async function hostCall(method, args) {
  switch (method) {
    case 'agent.send':
      return api.agent.send(args.text)
    case 'ui.toast':
      return api.ui.toast(args.title, args.detail)
    case 'ui.openFile':
      return api.ui.openFile(args.path)
    case 'ui.openPreview':
      return api.ui.openPreview(args.path)
    case 'ui.attach':
      return api.ui.attach(args.path, args.note)
    case 'ui.notify':
      return api.ui.notify(args.title, args.body)
    case 'secret.get':
      return api.secrets.get(args.key)
    case 'secret.set':
      return api.secrets.set(args.key, args.value)
    case 'workspace.read':
      return api.workspace.read(args.path)
    case 'workspace.write':
      return api.workspace.write(args.path, args.content)
    case 'workspace.list':
      return api.workspace.list(args.path)
    case 'state.get':
      return api.state.get(args.key, args.fallback)
    case 'state.set':
      return api.state.set(args.key, args.value)
    case 'shell':
      return api.shell(args.command, args)
    default:
      throw new Error(`no host method ${method} in the preview`)
  }
}

function page() {
  let html = readFileSync(join(dir, manifest.ui ?? 'index.html'), 'utf8')
  html = html
    .replace(/<link[^>]+prism-gadget:\/\/_sdk\/base\.css[^>]*>/, `<style>${GADGET_BASE_CSS}</style>`)
    .replace(/<link[^>]+prism-gadget:\/\/_sdk\/kit\.css[^>]*>/, `<style>${GADGET_KIT_CSS}</style>`)
    .replace(/<script[^>]+prism-gadget:\/\/_sdk\/prism\.js[^>]*><\/script>/, `<script>${FAKE_PRISM}</script>`)
    .replace(/<script[^>]+prism-gadget:\/\/_sdk\/kit\.js[^>]*><\/script>/, `<script>${GADGET_KIT_JS}</script>`)
  return html
}

createServer(async (req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    listeners.add(res)
    req.on('close', () => listeners.delete(res))
    return
  }
  if (req.url === '/call' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    const { method, args } = JSON.parse(body)
    try {
      const result = method === '__host' ? await hostCall(args.method, args.args ?? {}) : await mod.handlers[method](args, api)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ result: result ?? null }))
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(e?.message ?? e) }))
    }
    return
  }
  const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '')
  if (!rel) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(page())
  }
  try {
    const file = resolve(dir, rel)
    if (!file.startsWith(dir)) throw new Error('outside')
    res.writeHead(200)
    res.end(readFileSync(file))
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}).listen(port, '127.0.0.1', () => console.log(`preview of ${manifest.name}: http://127.0.0.1:${port}/`))
