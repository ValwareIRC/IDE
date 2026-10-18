// Gadget backend runtime. Prism runs this file in its own Node process with
// the gadget's backend module as the only argument. Messages are JSON lines on
// stdio. Nothing here is specific to a gadget; the module decides what exists.
import { pathToFileURL } from 'node:url'
import { spawn, exec } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createServer } from 'node:http'

const backendPath = process.argv[2]
let nextId = 1
const pending = new Map()
let mod = null
let ctx = { dir: '', workspace: '', permissions: {}, stateFile: '', dataDir: '' }
const children = new Map()
const servers = new Set()

// A VM or dev server usually has children of its own; take the whole tree.
function killTree(child) {
  if (!child || !child.pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    } catch {}
  }
  try {
    child.kill()
  } catch {}
}

// This process is Prism's own program run as Node. What it starts is not: a build that
// starts Electron, or Prism's installer, would otherwise inherit that and misbehave.
function childEnv(extra) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.PRISM_GADGET
  return { ...env, ...(extra || {}) }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

/** What a gadget's backend gets to work with. */
const api = {
  get dir() {
    return ctx.dir
  },
  /** Absolute path of the open project folder ('' when none). */
  get root() {
    return ctx.workspace
  },
  /** A folder for big or changing files (disk images, caches). Not watched, survives reloads. */
  get dataDir() {
    return ctx.dataDir
  },
  emit(event, data) {
    notify('ui/emit', { event, data })
  },
  log(...parts) {
    notify('log', { text: parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') })
  },
  agent: {
    /** Send a message to the agent as if the user typed it (prefixed with the gadget's name). */
    send(text) {
      return request('host/call', { method: 'agent.send', args: { text } })
    }
  },
  ui: {
    toast(title, detail) {
      return request('host/call', { method: 'ui.toast', args: { title, detail } })
    },
    openFile(path) {
      return request('host/call', { method: 'ui.openFile', args: { path } })
    },
    openPreview(path) {
      return request('host/call', { method: 'ui.openPreview', args: { path } })
    },
    /** Open this gadget's panel. */
    show() {
      return request('host/call', { method: 'ui.show', args: {} })
    },
    /** Hand the user a file as a card in their conversation; the phone can download it from there. */
    attach(path, note) {
      return request('host/call', { method: 'ui.attach', args: { path, note } })
    },
    /** News for the user, on the phone too when Prism is out of sight. */
    notify(title, body) {
      return request('host/call', { method: 'ui.notify', args: { title, body } })
    }
  },
  /** A picture of a web page or an HTML file: { mime, base64 }. opts: width, height, scale, waitMs. */
  capture(url, opts = {}) {
    return request('host/call', { method: 'page.capture', args: { url, ...opts } })
  },
  /** Passwords and keys, kept encrypted with the user's other secrets rather than in a file. */
  secrets: {
    get: (key) => request('host/call', { method: 'secret.get', args: { key } }),
    set: (key, value) => request('host/call', { method: 'secret.set', args: { key, value } })
  },
  workspace: {
    read: (path) => request('host/call', { method: 'workspace.read', args: { path } }),
    write: (path, content) => request('host/call', { method: 'workspace.write', args: { path, content } }),
    list: (path) => request('host/call', { method: 'workspace.list', args: { path } })
  },
  state: {
    async get(key, fallback) {
      const all = await readState()
      return key in all ? all[key] : fallback
    },
    async set(key, value) {
      const all = await readState()
      all[key] = value
      await mkdir(dirname(ctx.stateFile), { recursive: true })
      await writeFile(ctx.stateFile, JSON.stringify(all, null, 2))
    }
  },
  /** Run a command to completion. */
  shell(command, opts = {}) {
    return new Promise((resolve) => {
      exec(command, { cwd: opts.cwd || ctx.workspace || ctx.dir, timeout: opts.timeoutMs || 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: opts.shell, env: childEnv(opts.env) }, (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })
      })
    })
  },
  /** Start a long-running process (a VM, a server…). Output arrives through onData. */
  spawn(command, args = [], opts = {}) {
    const child = spawn(command, args, { cwd: opts.cwd || ctx.workspace || ctx.dir, windowsHide: true, env: childEnv(opts.env), shell: opts.shell })
    const handle = {
      pid: child.pid,
      write: (data) => child.stdin && child.stdin.write(data),
      kill: () => killTree(child),
      exited: new Promise((resolve) => child.on('close', (code) => resolve(code)))
    }
    children.set(child.pid, child)
    child.stdout?.on('data', (d) => opts.onData && opts.onData(String(d), 'stdout'))
    child.stderr?.on('data', (d) => opts.onData && opts.onData(String(d), 'stderr'))
    child.on('close', (code) => {
      children.delete(child.pid)
      opts.onExit && opts.onExit(code)
    })
    child.on('error', (e) => opts.onData && opts.onData(`[spawn error] ${e.message}\n`, 'stderr'))
    return handle
  },
  /** A local web server on a free port, for streaming media or frames to the UI. */
  serve(handler, opts = {}) {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        Promise.resolve()
          .then(() => handler(req, res))
          .catch((e) => {
            try {
              res.statusCode = 500
              res.end(String((e && e.message) || e))
            } catch {}
          })
      })
      server.on('error', reject)
      server.listen(opts.port || 0, '127.0.0.1', () => {
        servers.add(server)
        const port = server.address().port
        resolve({
          port,
          url: `http://127.0.0.1:${port}`,
          server,
          close: () => {
            servers.delete(server)
            server.close()
          }
        })
      })
    })
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(ctx.stateFile, 'utf8'))
  } catch {
    return {}
  }
}

function plain(message) {
  const e = new Error(message)
  e.plain = true
  return e
}

function toolList() {
  const tools = (mod && mod.tools) || []
  return tools.map((t) => ({ name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } }))
}

function handlerList() {
  return Object.keys((mod && mod.handlers) || {})
}

async function handle(msg) {
  const { id, method, params } = msg
  try {
    let result
    switch (method) {
      case 'init': {
        ctx = { dir: params.dir, workspace: params.workspace, permissions: params.permissions || {}, stateFile: params.stateFile, dataDir: params.dataDir || '' }
        if (ctx.dataDir) await mkdir(ctx.dataDir, { recursive: true })
        const imported = await import(pathToFileURL(backendPath).href + `?t=${Date.now()}`)
        mod = imported.default || imported
        if (typeof mod.start === 'function') await mod.start(api)
        result = { tools: toolList(), handlers: handlerList() }
        break
      }
      case 'tools/list':
        result = toolList()
        break
      case 'tools/call': {
        const tool = ((mod && mod.tools) || []).find((t) => t.name === params.name)
        if (!tool) throw plain(`No tool named ${params.name}. Tools: ${toolList().map((t) => t.name).join(', ') || 'none'}`)
        const r = await tool.execute(params.args || {}, api)
        result = typeof r === 'string' ? { content: r } : r && typeof r === 'object' ? r : { content: String(r ?? '') }
        break
      }
      case 'ui/call': {
        const fn = mod && mod.handlers && mod.handlers[params.method]
        if (typeof fn !== 'function') throw plain(`No handler named ${params.method}. Handlers: ${handlerList().join(', ') || 'none'}`)
        result = await fn(params.args || {}, api)
        break
      }
      case 'shutdown':
        try {
          if (mod && typeof mod.stop === 'function') await mod.stop(api)
        } catch (e) {
          notify('log', { text: `stop failed: ${(e && e.message) || e}` })
        }
        for (const c of children.values()) killTree(c)
        for (const s of servers) {
          try {
            s.close()
          } catch {}
        }
        send({ jsonrpc: '2.0', id, result: true })
        // the host ends this process, and anything it started, once it has the reply
        setTimeout(() => process.exit(0), 1500)
        return
      default:
        throw new Error(`Unknown method ${method}`)
    }
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: result === undefined ? null : result })
  } catch (e) {
    // the gadget's own failures keep a short trace so the agent can find the line
    const message = e && e.plain ? e.message : String((e && e.stack) || e).split('\n').slice(0, 5).join('\n')
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { message } })
    else notify('log', { text: `error: ${(e && e.message) || e}` })
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result)
      }
      continue
    }
    void handle(msg)
  }
})
// the host went away without a shutdown: do not leave machines running
process.stdin.on('end', () => {
  for (const c of children.values()) killTree(c)
  setTimeout(() => process.exit(0), 300)
})
process.on('uncaughtException', (e) => notify('log', { text: `uncaught: ${e.stack || e}` }))
process.on('unhandledRejection', (e) => notify('log', { text: `unhandled: ${(e && e.stack) || e}` }))
