// Runs the user's own agent tools (.prism/tools/*.ts). Started by
// core/customTools/manager.ts. Two layers keep a tool to what it declared:
//
// 1. Each file runs in its own bare V8 context (vm with DONT_CONTEXTIFY): no
//    process, require, fetch or timers exist there, and code cannot be built
//    from strings. Nothing from this process's own realm is ever handed to tool
//    code, because any such object leads back to this realm's Function and so
//    out of the context. Only strings cross, in both directions: GUEST below is
//    the part that lives inside the context and talks through one function it
//    keeps in a closure.
// 2. This process is started with Node's permission model, so even code that
//    did get out could not read or write files, start programs or load native
//    code. (The network is not covered by that layer.)
//
// What a tool may do it asks the main process for, through its `prism` object;
// the main process keeps paths inside the project and checks the tool's `uses`.
import vm from 'node:vm'

// Runs inside each context. `hostSend` takes a string and returns a string or
// undefined; it is called directly and never passed on, so tool code cannot get hold of it.
const GUEST = `(function (hostSend) {
  'use strict'
  const send = (m) => {
    let r
    try {
      r = hostSend(JSON.stringify(m))
    } catch {
      // whatever was thrown belongs to the other side: it is dropped here
      throw new Error('The tool helper could not be reached.')
    }
    return typeof r === 'string' ? JSON.parse(r) : undefined
  }
  const pending = new Map()
  const timers = new Map()
  let seq = 0
  let tool = null
  let lastLogs = null

  const show = (v) => {
    if (typeof v === 'string') return v
    if (v instanceof Error) return v.stack || v.message
    try {
      const s = JSON.stringify(v, null, 2)
      return s === undefined ? String(v) : s
    } catch {
      return String(v)
    }
  }
  const logTo = (logs) => (...a) => {
    if (logs && logs.length < 200) logs.push(a.map(show).join(' '))
  }
  const consoleLog = (...a) => logTo(lastLogs)(...a)

  const module = { exports: {} }
  globalThis.module = module
  globalThis.exports = module.exports
  globalThis.defineTool = (d) => d
  globalThis.require = () => {
    throw new Error('A tool cannot import modules. Everything it may use is on the prism object it is given.')
  }
  globalThis.console = { log: consoleLog, info: consoleLog, warn: consoleLog, error: consoleLog, debug: consoleLog }
  globalThis.setTimeout = (f, ms, ...a) => {
    const id = ++seq
    timers.set(id, () => f(...a))
    send({ t: 'timer', id, ms: Math.max(0, Math.min(Number(ms) || 0, 120000)) })
    return id
  }
  globalThis.clearTimeout = (id) => {
    timers.delete(id)
  }

  class URLSearchParams {
    #list = []
    constructor(init = '') {
      const dec = (s) => decodeURIComponent(s.replace(/\\+/g, ' '))
      if (typeof init === 'string') {
        for (const part of init.replace(/^\\?/, '').split('&')) {
          if (!part) continue
          const i = part.indexOf('=')
          this.#list.push(i < 0 ? [dec(part), ''] : [dec(part.slice(0, i)), dec(part.slice(i + 1))])
        }
      } else if (init && typeof init === 'object') for (const k of Object.keys(init)) this.#list.push([k, String(init[k])])
    }
    get(k) {
      const e = this.#list.find((x) => x[0] === k)
      return e ? e[1] : null
    }
    getAll(k) {
      return this.#list.filter((x) => x[0] === k).map((x) => x[1])
    }
    has(k) {
      return this.#list.some((x) => x[0] === k)
    }
    append(k, v) {
      this.#list.push([String(k), String(v)])
    }
    set(k, v) {
      this.delete(k)
      this.append(k, v)
    }
    delete(k) {
      this.#list = this.#list.filter((x) => x[0] !== k)
    }
    entries() {
      return this.#list.map((x) => [x[0], x[1]])[Symbol.iterator]()
    }
    [Symbol.iterator]() {
      return this.entries()
    }
    toString() {
      return this.#list.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')
    }
  }
  class URL {
    constructor(href, base) {
      const r = send({ t: 'url', href: String(href), base: base === undefined ? undefined : String(base) })
      if (!r || r.error) throw new TypeError('Invalid URL: ' + href)
      this.protocol = r.protocol
      this.host = r.host
      this.hostname = r.hostname
      this.port = r.port
      this.origin = r.origin
      this.pathname = r.pathname
      this.hash = r.hash
      this.searchParams = new URLSearchParams(r.search)
    }
    get search() {
      const q = this.searchParams.toString()
      return q ? '?' + q : ''
    }
    get href() {
      return this.protocol + '//' + this.host + this.pathname + this.search + this.hash
    }
    toString() {
      return this.href
    }
  }
  globalThis.URL = URL
  globalThis.URLSearchParams = URLSearchParams

  const ask = (call, method, args) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      send({ t: 'api', id, call, method, args })
    })
  const apiFor = (call, uses, logs) => {
    const need = (what) => (uses.includes(what) ? null : Promise.reject(new Error('This tool has not listed "' + what + '" in its uses, so it may not do that.')))
    return {
      fs: {
        read: (path) => ask(call, 'fs.read', [String(path)]),
        write: (path, content) => ask(call, 'fs.write', [String(path), String(content)]),
        list: (path = '.') => ask(call, 'fs.list', [String(path)]),
        exists: (path) => ask(call, 'fs.exists', [String(path)]),
        search: (query, options = {}) => ask(call, 'fs.search', [String(query), options])
      },
      shell: { run: (command, options = {}) => need('shell') ?? ask(call, 'shell.run', [String(command), options]) },
      fetch: (url, options = {}) => need('network') ?? ask(call, 'net.fetch', [String(url), options]),
      log: logTo(logs)
    }
  }

  const TYPES = ['string', 'number', 'boolean', 'array', 'object']
  /** Check the definition and turn its parameter list into the schema models are given. */
  const accept = (def) => {
    if (!def || typeof def !== 'object') throw new Error('The file must end with: export default defineTool({ … })')
    if (typeof def.name !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(def.name)) throw new Error('name must be lower-case letters, digits and underscores (for example count_lines).')
    if (typeof def.description !== 'string' || def.description.trim().length < 8) throw new Error('description must say what the tool does, in a sentence.')
    if (typeof def.run !== 'function') throw new Error('run must be a function.')
    const properties = {}
    const required = []
    for (const key of Object.keys(def.parameters ?? {})) {
      const p = def.parameters[key]
      const spec = typeof p === 'string' ? { type: p } : (p ?? {})
      if (!TYPES.includes(spec.type)) throw new Error('parameter ' + key + ': type must be one of string, number, boolean, array, object.')
      properties[key] = { type: spec.type }
      if (spec.description) properties[key].description = String(spec.description)
      if (Array.isArray(spec.enum)) properties[key].enum = spec.enum.filter((v) => typeof v === 'string' || typeof v === 'number')
      if (!spec.optional) required.push(key)
    }
    const uses = Array.isArray(def.uses) ? def.uses.filter((u) => u === 'shell' || u === 'network') : []
    const risk = ['none', 'low', 'medium', 'high'].includes(def.risk) ? def.risk : uses.includes('shell') ? 'medium' : 'low'
    const parameters = { type: 'object', properties }
    if (required.length) parameters.required = required
    return { name: def.name, description: def.description.trim(), parameters, uses, risk, run: def.run }
  }

  return {
    /** After the file has run: what it defined. */
    define() {
      try {
        tool = accept(module.exports.default ?? module.exports)
        return JSON.stringify({ ok: true, tool: { name: tool.name, description: tool.description, parameters: tool.parameters, uses: tool.uses, risk: tool.risk } })
      } catch (e) {
        return JSON.stringify({ ok: false, error: String((e && e.message) || e) })
      }
    },
    run(json) {
      const m = JSON.parse(json)
      const logs = []
      lastLogs = logs
      Promise.resolve()
        .then(() => tool.run(m.args ?? {}, apiFor(m.id, tool.uses, logs)))
        .then(
          (v) => send({ t: 'result', id: m.id, ok: true, value: v === undefined || v === null ? '' : show(v), logs }),
          (e) => send({ t: 'result', id: m.id, ok: false, error: String((e && e.message) || e), logs })
        )
    },
    deliver(json) {
      const m = JSON.parse(json)
      if (m.t === 'timer') {
        const f = timers.get(m.id)
        timers.delete(m.id)
        if (f) f()
        return
      }
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (p) m.ok ? p.resolve(m.value) : p.reject(new Error(m.error))
    }
  }
})`

/** name → { guest, file, scope, … } */
const tools = new Map()
/** main's call id → the guest running it, for results of what it asked. */
const running = new Map()

const send = (m) => {
  try {
    process.send(m)
  } catch {
    /* the app has gone */
  }
}

/** Hand a message to code in a context. Only a string goes in; whatever it throws stays there. */
function deliver(guest, m) {
  try {
    guest.deliver(JSON.stringify(m))
  } catch {
    /* a tool's own callback failed */
  }
}

/** What a context said. Returns a string for the few requests that are answered at once. */
function fromGuest(entry, json) {
  const m = JSON.parse(json)
  if ((m.t === 'api' && running.get(m.call) !== entry) || (m.t === 'result' && running.get(m.id) !== entry)) return undefined
  if (m.t === 'api') send({ type: 'api', id: Number(m.id), call: Number(m.call), tool: entry.name, method: String(m.method), args: Array.isArray(m.args) ? m.args : [] })
  else if (m.t === 'result') {
    running.delete(m.id)
    send({ type: 'result', id: Number(m.id), ok: m.ok === true, value: typeof m.value === 'string' ? m.value : '', error: typeof m.error === 'string' ? m.error : undefined, logs: Array.isArray(m.logs) ? m.logs.map(String) : [] })
  } else if (m.t === 'timer') setTimeout(() => deliver(entry.guest, { t: 'timer', id: m.id }), Number(m.ms) || 0)
  else if (m.t === 'url') {
    try {
      const u = new URL(m.href, m.base)
      return JSON.stringify({ protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash })
    } catch {
      return JSON.stringify({ error: true })
    }
  }
  return undefined
}

function load(files) {
  tools.clear()
  running.clear()
  const errors = []
  for (const f of files) {
    try {
      const entry = { name: '', file: f.file, scope: f.scope, guest: null }
      // a context of its own, holding nothing from this realm
      const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, { name: f.file, codeGeneration: { strings: false, wasm: false } })
      const hostSend = (json) => {
        try {
          return fromGuest(entry, String(json))
        } catch {
          return undefined
        }
      }
      entry.guest = vm.runInContext(GUEST, context, { filename: 'prism-tool-bridge' })(hostSend)
      vm.runInContext(f.code, context, { filename: f.file, timeout: 3000 })
      const r = JSON.parse(String(entry.guest.define()))
      if (!r.ok) throw new Error(r.error)
      if (tools.has(r.tool.name)) throw new Error(`another file already defines a tool named ${r.tool.name}.`)
      Object.assign(entry, r.tool)
      tools.set(entry.name, entry)
    } catch (e) {
      let error = 'The file could not be loaded.'
      try {
        error = String(e?.message ?? e)
      } catch {
        /* keep the plain message */
      }
      errors.push({ file: f.file, scope: f.scope, error })
    }
  }
  send({ type: 'loaded', tools: [...tools.values()].map(({ guest, ...rest }) => rest), errors })
}

process.on('message', (m) => {
  if (!m) return
  if (m.type === 'load') load(m.files)
  else if (m.type === 'api-result') {
    const entry = running.get(m.call)
    if (entry) deliver(entry.guest, { t: 'api-result', id: m.id, ok: m.ok === true, value: m.value, error: m.error })
  } else if (m.type === 'call') {
    const entry = tools.get(m.name)
    if (!entry) return send({ type: 'result', id: m.id, ok: false, error: `There is no tool named ${m.name} any more.`, logs: [] })
    running.set(m.id, entry)
    try {
      entry.guest.run(JSON.stringify({ id: m.id, args: m.args ?? {} }))
    } catch {
      running.delete(m.id)
      send({ type: 'result', id: m.id, ok: false, error: 'The tool could not be started.', logs: [] })
    }
  }
})

process.on('uncaughtException', () => {})
process.on('unhandledRejection', () => {})
send({ type: 'ready' })
