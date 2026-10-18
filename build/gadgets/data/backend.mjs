// Databases and APIs, inside Prism: look into a project's database, try a request
// against an API, and see every query and request the agent makes, with the ones that
// would change something held for the user's yes first.
//
// SQLite needs nothing extra (Node has it). PostgreSQL and MySQL need a small add-on,
// fetched once into this gadget's own data folder when first asked for. Connections and
// saved requests live in the project (.prism/data.json); passwords and tokens never do:
// they are written {secret:NAME} and kept encrypted with the user's other secrets.
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, isAbsolute, join, relative } from 'node:path'

const CONFIG = '.prism/data.json'
const ROW_LIMIT = 500
let api = null
const pending = new Map()
const history = []

const here = (p) => join(api.root, p)
const projectKey = () => createHash('sha1').update((api.root || 'none').toLowerCase()).digest('hex').slice(0, 12)

function config() {
  try {
    const j = JSON.parse(readFileSync(here(CONFIG), 'utf8'))
    return { connections: Array.isArray(j.connections) ? j.connections : [], requests: Array.isArray(j.requests) ? j.requests : [], vars: j.vars && typeof j.vars === 'object' ? j.vars : {} }
  } catch {
    return { connections: [], requests: [], vars: {} }
  }
}

function saveConfig(c) {
  mkdirSync(here('.prism'), { recursive: true })
  writeFileSync(here(CONFIG), JSON.stringify(c, null, 2) + '\n')
  api.emit('config', c)
  return c
}

function remember(entry) {
  history.unshift({ id: randomUUID().slice(0, 8), at: Date.now(), ...entry })
  history.splice(80)
  api.emit('history', history.slice(0, 40))
}

/** {secret:NAME} and {{var}} filled in; secrets never reach a log or the agent. */
async function fill(text, values = {}) {
  let out = String(text ?? '')
  const c = config()
  out = out.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => (k in c.vars ? String(c.vars[k]) : m))
  for (const m of [...out.matchAll(/\{secret:([\w-]+)\}/g)]) {
    const v = await api.secrets.get(`${projectKey()}:${m[1]}`)
    if (v == null) throw new Error(`The secret ${m[1]} is not set. Set it in the Data panel.`)
    values[m[1]] = v
    out = out.split(m[0]).join(v)
  }
  return out
}

function mask(text, values) {
  let out = String(text ?? '')
  for (const v of Object.values(values)) if (v && v.length >= 3) out = out.split(v).join('••••')
  return out
}

// ---------------------------------------------------------------- what a statement does

/** Whether SQL only reads. Comments are ignored; a statement that writes anywhere counts as writing. */
export function readsOnly(sql) {
  const text = String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .trim()
  const parts = text.split(';').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return true
  return parts.every((s) => {
    const first = s.split(/\s+/)[0].toUpperCase()
    if (['SELECT', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE'].includes(first)) return !/\bINTO\s+\w/i.test(s) || first === 'EXPLAIN'
    if (first === 'WITH') return !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(s)
    if (first === 'PRAGMA') return !s.includes('=')
    return false
  })
}

// ---------------------------------------------------------------- the engines

const addonDir = () => join(api.dataDir, 'addons')

function addon(name) {
  const req = createRequire(join(addonDir(), 'node_modules', '.prism'))
  try {
    return req(name)
  } catch {
    return null
  }
}

function getAddon(name) {
  mkdirSync(addonDir(), { recursive: true })
  if (!existsSync(join(addonDir(), 'package.json'))) writeFileSync(join(addonDir(), 'package.json'), JSON.stringify({ name: 'prism-data-addons', private: true }))
  return new Promise((res, rej) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    execFile(`npm install --no-audit --no-fund --loglevel=error ${name}`, { cwd: addonDir(), shell: true, windowsHide: true, timeout: 300_000, env }, (err, _o, stderr) => (err ? rej(new Error(`Getting ${name} failed: ${String(stderr).trim().split('\n').slice(-2).join(' ') || err.message}`)) : res(true)))
  })
}

function sqlitePath(conn) {
  const p = String(conn.path ?? '')
  return isAbsolute(p) ? p : here(p)
}

/** Runs SQL on a connection. Reading statements go through a connection that cannot write. */
async function run(conn, sql, { write = false } = {}) {
  const t0 = Date.now()
  if (conn.kind === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite')
    const file = sqlitePath(conn)
    if (!existsSync(file)) throw new Error(`${conn.path} is not there.`)
    const db = new DatabaseSync(file, write ? {} : { readOnly: true })
    try {
      const statements = sql.split(/;\s*(?=\S)/).filter((s) => s.trim())
      let rows = []
      let columns = []
      let changed = 0
      for (const s of statements) {
        const st = db.prepare(s)
        const cols = typeof st.columns === 'function' ? st.columns().map((c) => c.name) : []
        if (cols.length) {
          rows = st.all().slice(0, ROW_LIMIT + 1)
          columns = cols
        } else changed += Number(st.run().changes ?? 0)
      }
      return { columns, rows: rows.slice(0, ROW_LIMIT), more: rows.length > ROW_LIMIT, changed, ms: Date.now() - t0 }
    } finally {
      db.close()
    }
  }
  const values = {}
  const url = await fill(conn.url, values)
  if (conn.kind === 'postgres') {
    const pg = addon('pg')
    if (!pg) throw Object.assign(new Error('PostgreSQL needs its add-on (pg). Get it from the Data panel.'), { needs: 'pg' })
    const client = new pg.Client({ connectionString: url, statement_timeout: 30_000, query_timeout: 35_000, connectionTimeoutMillis: 10_000 })
    await client.connect()
    try {
      if (!write) await client.query('BEGIN TRANSACTION READ ONLY')
      const r = await client.query(sql)
      if (!write) await client.query('ROLLBACK')
      const last = Array.isArray(r) ? r[r.length - 1] : r
      return { columns: (last.fields ?? []).map((f) => f.name), rows: (last.rows ?? []).slice(0, ROW_LIMIT), more: (last.rows ?? []).length > ROW_LIMIT, changed: last.command && last.command !== 'SELECT' ? (last.rowCount ?? 0) : 0, ms: Date.now() - t0 }
    } catch (e) {
      throw new Error(mask(e.message, values))
    } finally {
      await client.end().catch(() => {})
    }
  }
  if (conn.kind === 'mysql') {
    const my = addon('mysql2/promise')
    if (!my) throw Object.assign(new Error('MySQL needs its add-on (mysql2). Get it from the Data panel.'), { needs: 'mysql2' })
    const c = await my.createConnection({ uri: url, connectTimeout: 10_000, multipleStatements: true })
    try {
      if (!write) await c.query('START TRANSACTION READ ONLY')
      const [rows, fields] = await c.query({ sql, timeout: 30_000 })
      if (!write) await c.query('ROLLBACK')
      const list = Array.isArray(rows) ? rows : []
      return { columns: (fields ?? []).map((f) => f.name), rows: list.slice(0, ROW_LIMIT), more: list.length > ROW_LIMIT, changed: Array.isArray(rows) ? 0 : (rows.affectedRows ?? 0), ms: Date.now() - t0 }
    } catch (e) {
      throw new Error(mask(e.message, values))
    } finally {
      await c.end().catch(() => {})
    }
  }
  throw new Error(`Unknown kind of database: ${conn.kind}`)
}

async function tables(conn) {
  const q = {
    sqlite: "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    postgres: "SELECT table_schema || '.' || table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1",
    mysql: 'SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1'
  }[conn.kind]
  const r = await run(conn, q)
  return r.rows.map((x) => ({ name: x.name ?? x.NAME ?? x.TABLE_NAME, type: String(x.type ?? x.TYPE ?? x.TABLE_TYPE ?? '').toLowerCase().includes('view') ? 'view' : 'table' }))
}

async function schema(conn, table) {
  if (conn.kind === 'sqlite') {
    const r = await run(conn, table ? `SELECT sql FROM sqlite_master WHERE name = '${String(table).replace(/'/g, "''")}'` : "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
    return r.rows.map((x) => x.sql).join(';\n\n')
  }
  const [schemaName, tableName] = String(table ?? '').includes('.') ? String(table).split('.') : [null, table]
  const q =
    conn.kind === 'postgres'
      ? `SELECT table_schema || '.' || table_name AS t, column_name AS c, data_type AS d, is_nullable AS n FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema')${tableName ? ` AND table_name = '${String(tableName).replace(/'/g, "''")}'${schemaName ? ` AND table_schema = '${schemaName.replace(/'/g, "''")}'` : ''}` : ''} ORDER BY 1, ordinal_position`
      : `SELECT table_name AS t, column_name AS c, column_type AS d, is_nullable AS n FROM information_schema.columns WHERE table_schema = DATABASE()${tableName ? ` AND table_name = '${String(tableName).replace(/'/g, "''")}'` : ''} ORDER BY 1, ordinal_position`
  const r = await run(conn, q)
  const by = new Map()
  for (const x of r.rows) by.set(x.t ?? x.T, [...(by.get(x.t ?? x.T) ?? []), `${x.c ?? x.C} ${x.d ?? x.D}${(x.n ?? x.N) === 'NO' ? ' not null' : ''}`])
  return [...by.entries()].map(([t, cols]) => `${t} (\n  ${cols.join(',\n  ')}\n)`).join('\n\n')
}

/** SQLite files in the project, to offer as connections. */
function findSqlite() {
  const out = []
  const walk = (dir, depth) => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      if (/^(node_modules|\.git|dist|out|build|target|\.venv|venv)$/.test(n)) continue
      const p = join(dir, n)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        if (depth < 4) walk(p, depth + 1)
      } else if (/\.(db|sqlite3?|db3)$/i.test(n) && s.size > 0) out.push(relative(api.root, p).replace(/\\/g, '/'))
    }
  }
  if (api.root) walk(api.root, 0)
  return out.slice(0, 20)
}

// ---------------------------------------------------------------- asking first

/** Holds something that would change data for the user's yes in the panel. */
function askFirst(kind, what, by) {
  return new Promise((resolve) => {
    const id = randomUUID().slice(0, 8)
    const timer = setTimeout(() => decide(id, false), 15 * 60_000)
    pending.set(id, { id, kind, what, by, at: Date.now(), resolve: (yes) => { clearTimeout(timer); resolve(yes) } })
    api.emit('pending', publicPending())
    api.ui.show().catch(() => {})
    api.ui.notify('Data', `${by === 'you' ? 'Confirm' : 'Prism asks'}: ${kind === 'query' ? `run a query that changes ${what.connection}` : `send ${what.method} ${what.url}`}? Answer in the Data panel.`).catch(() => {})
  })
}

function decide(id, yes) {
  const p = pending.get(id)
  if (!p) return false
  pending.delete(id)
  api.emit('pending', publicPending())
  p.resolve(!!yes)
  return true
}

function publicPending() {
  return [...pending.values()].map(({ resolve: _r, ...rest }) => rest)
}

async function query(name, sql, by) {
  const conn = config().connections.find((c) => c.name.toLowerCase() === String(name).toLowerCase())
  if (!conn) throw new Error(`There is no connection called "${name}". Connections: ${config().connections.map((c) => c.name).join(', ') || 'none yet'}.`)
  const write = !readsOnly(sql)
  if (write && by !== 'you-confirmed' && !(await askFirst('query', { connection: conn.name, sql }, by))) {
    remember({ kind: 'query', connection: conn.name, sql, by, outcome: 'not run: the user said no' })
    return { declined: true }
  }
  try {
    const r = await run(conn, sql, { write })
    remember({ kind: 'query', connection: conn.name, sql, by: by === 'you-confirmed' ? 'you' : by, outcome: write ? `${r.changed} row(s) changed` : `${r.rows.length}${r.more ? '+' : ''} row(s)`, ms: r.ms })
    return r
  } catch (e) {
    remember({ kind: 'query', connection: conn.name, sql, by: by === 'you-confirmed' ? 'you' : by, outcome: `failed: ${e.message}` })
    throw e
  }
}

// ---------------------------------------------------------------- requests

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i

async function send(req, by) {
  const values = {}
  const method = String(req.method ?? 'GET').toUpperCase()
  const url = await fill(req.url, values)
  if (!/^https?:\/\//i.test(url)) throw new Error('The address has to start with http:// or https://.')
  const headers = {}
  for (const h of req.headers ?? []) if (h && h.name) headers[h.name] = await fill(h.value, values)
  const body = ['GET', 'HEAD'].includes(method) ? undefined : req.body ? await fill(req.body, values) : undefined
  const changes = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  if (changes && !LOCAL.test(url) && by !== 'you-confirmed' && !(await askFirst('request', { method, url: mask(url, values), body: mask(body ?? '', values).slice(0, 2000) }, by))) {
    remember({ kind: 'request', method, url: mask(url, values), by, outcome: 'not sent: the user said no' })
    return { declined: true }
  }
  const t0 = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 30_000)
  try {
    const r = await fetch(url, { method, headers, body, signal: ctl.signal, redirect: 'follow' })
    const buf = Buffer.from(await r.arrayBuffer())
    const type = r.headers.get('content-type') ?? ''
    const text = /json|text|xml|html|javascript|csv|yaml/i.test(type) || !type ? buf.toString('utf8') : null
    const out = { status: r.status, statusText: r.statusText, ms: Date.now() - t0, size: buf.length, type, headers: Object.fromEntries(r.headers.entries()), body: text != null ? mask(text.slice(0, 200_000), values) : null, binary: text == null ? `${buf.length} bytes of ${type}` : null }
    remember({ kind: 'request', method, url: mask(url, values), by: by === 'you-confirmed' ? 'you' : by, outcome: `${r.status} in ${out.ms} ms`, ms: out.ms })
    return out
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'No answer in 30 seconds.' : mask(e.message, values)
    remember({ kind: 'request', method, url: mask(url, values), by: by === 'you-confirmed' ? 'you' : by, outcome: `failed: ${msg}` })
    throw new Error(msg)
  } finally {
    clearTimeout(timer)
  }
}

/** A curl command, as copied from a browser's developer tools or an API's docs. */
function fromCurl(cmd) {
  const words = []
  let cur = ''
  let quote = null
  const text = String(cmd).replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ')
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (/\s/.test(ch)) {
      if (cur) words.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) words.push(cur)
  const req = { method: '', url: '', headers: [], body: '' }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === 'curl') continue
    if (w === '-X' || w === '--request') req.method = words[++i]
    else if (w === '-H' || w === '--header') {
      const h = words[++i] ?? ''
      const at = h.indexOf(':')
      if (at > 0) req.headers.push({ name: h.slice(0, at).trim(), value: h.slice(at + 1).trim() })
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--json'].includes(w)) {
      req.body = words[++i] ?? ''
      if (w === '--json') req.headers.push({ name: 'Content-Type', value: 'application/json' })
    } else if (w === '-u' || w === '--user') req.headers.push({ name: 'Authorization', value: `Basic ${Buffer.from(words[++i] ?? '').toString('base64')}` })
    else if (/^https?:\/\//i.test(w)) req.url = w
  }
  req.method ||= req.body ? 'POST' : 'GET'
  return req
}

function tableText(r) {
  if (r.declined) return 'Not run: the user said no in the Data panel.'
  if (!r.columns.length) return `Done in ${r.ms} ms. ${r.changed} row(s) changed.`
  const cell = (v) => (v == null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\s+/g, ' ').slice(0, 80)
  const rows = r.rows.slice(0, 100)
  return `${r.rows.length}${r.more ? '+' : ''} row(s) in ${r.ms} ms${rows.length < r.rows.length ? `, first ${rows.length} shown` : ''}.\n${r.columns.join(' | ')}\n${rows.map((x) => r.columns.map((c) => cell(x[c])).join(' | ')).join('\n')}`
}

export default {
  async start(a) {
    api = a
  },
  async stop() {
    for (const id of [...pending.keys()]) decide(id, false)
  },
  handlers: {
    overview: async () => ({ project: api.root || null, config: config(), found: findSqlite(), pending: publicPending(), history: history.slice(0, 40), addons: { pg: !!addon('pg'), mysql2: !!addon('mysql2/promise') } }),
    addConnection: (a) => {
      const c = config()
      const conn = { name: String(a.name ?? '').trim() || (a.path ? basename(String(a.path)) : 'Database'), kind: a.kind, ...(a.kind === 'sqlite' ? { path: String(a.path ?? '') } : { url: String(a.url ?? '') }) }
      c.connections = [...c.connections.filter((x) => x.name !== conn.name), conn]
      return saveConfig(c)
    },
    removeConnection: (a) => {
      const c = config()
      c.connections = c.connections.filter((x) => x.name !== a.name)
      return saveConfig(c)
    },
    tables: async (a) => tables(config().connections.find((c) => c.name === a.name)),
    schema: async (a) => schema(config().connections.find((c) => c.name === a.name), a.table),
    query: async (a) => query(a.name, String(a.sql ?? ''), a.confirmed ? 'you-confirmed' : 'you'),
    readsOnly: (a) => readsOnly(String(a.sql ?? '')),
    send: async (a) => send(a.request ?? {}, a.confirmed ? 'you-confirmed' : 'you'),
    saveRequest: (a) => {
      const c = config()
      const r = { name: String(a.request?.name ?? '').trim() || 'A request', method: a.request?.method ?? 'GET', url: a.request?.url ?? '', headers: (a.request?.headers ?? []).filter((h) => h.name), body: a.request?.body ?? '' }
      c.requests = [...c.requests.filter((x) => x.name !== r.name), r]
      return saveConfig(c)
    },
    removeRequest: (a) => {
      const c = config()
      c.requests = c.requests.filter((x) => x.name !== a.name)
      return saveConfig(c)
    },
    setVar: (a) => {
      const c = config()
      if (a.value == null || a.value === '') delete c.vars[a.name]
      else c.vars[a.name] = String(a.value)
      return saveConfig(c)
    },
    setSecret: async (a) => {
      await api.secrets.set(`${projectKey()}:${a.name}`, a.value ? String(a.value) : null)
      return true
    },
    hasSecret: async (a) => !!(await api.secrets.get(`${projectKey()}:${a.name}`)),
    fromCurl: (a) => fromCurl(a.text),
    decide: (a) => decide(String(a.id), !!a.yes),
    getAddon: async (a) => {
      if (!['pg', 'mysql2'].includes(a.name)) throw new Error('Unknown add-on.')
      await getAddon(a.name)
      return true
    },
    askAgent: async (a) => {
      await api.agent.send(String(a.text))
      return true
    }
  },
  tools: [
    {
      name: 'db_connections',
      description: "The project's databases (from .prism/data.json) with their tables, and SQLite files found in the project that are not connected yet. With a connection name, its schema.",
      parameters: { type: 'object', properties: { connection: { type: 'string' }, table: { type: 'string' } } },
      async execute(a) {
        const c = config()
        if (a.connection) {
          const conn = c.connections.find((x) => x.name.toLowerCase() === String(a.connection).toLowerCase())
          if (!conn) return { content: `No connection called ${a.connection}.`, isError: true }
          return (await schema(conn, a.table)) || '(no tables)'
        }
        const lines = []
        for (const conn of c.connections) {
          const t = await tables(conn).catch((e) => e)
          lines.push(`- ${conn.name} (${conn.kind}${conn.path ? `, ${conn.path}` : ''}): ${t instanceof Error ? `cannot reach it: ${t.message}` : t.map((x) => x.name).join(', ') || 'no tables'}`)
        }
        const found = findSqlite().filter((p) => !c.connections.some((x) => x.path === p))
        return `${lines.length ? `Connections:\n${lines.join('\n')}` : 'No connections yet.'}${found.length ? `\nSQLite files in the project not connected: ${found.join(', ')} (the user can connect them in the Data panel).` : ''}`
      }
    },
    {
      name: 'db_query',
      description:
        "Run SQL on one of the project's databases and get the rows back. Reading (SELECT, WITH, EXPLAIN, PRAGMA, SHOW) runs at once through a connection that cannot change anything. Anything that would change data or the schema waits in the Data panel for the user to say yes first (up to 15 minutes), and the user sees every query you run there.",
      parameters: { type: 'object', properties: { connection: { type: 'string' }, sql: { type: 'string' } }, required: ['connection', 'sql'] },
      async execute(a) {
        const r = await query(a.connection, String(a.sql), 'Prism')
        return { content: tableText(r), isError: false }
      }
    },
    {
      name: 'api_request',
      description:
        "Send an HTTP request and get the answer (status, headers, body). GET, HEAD and OPTIONS, and anything to this computer (localhost), go at once; POST, PUT, PATCH and DELETE to anywhere else wait in the Data panel for the user's yes. Write {{name}} for a saved variable and {secret:NAME} for a saved secret; their values are filled in here and never shown. Saved requests: give name to send one of them.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A saved request, instead of the rest' },
          method: { type: 'string' },
          url: { type: 'string' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          body: { type: 'string' }
        }
      },
      async execute(a) {
        let req
        if (a.name) {
          req = config().requests.find((r) => r.name.toLowerCase() === String(a.name).toLowerCase())
          if (!req) return { content: `No saved request called ${a.name}. Saved: ${config().requests.map((r) => r.name).join(', ') || 'none'}.`, isError: true }
        } else req = { method: a.method ?? 'GET', url: a.url, headers: Object.entries(a.headers ?? {}).map(([name, value]) => ({ name, value })), body: a.body ?? '' }
        const r = await send(req, 'Prism')
        if (r.declined) return 'Not sent: the user said no in the Data panel.'
        return `${r.status} ${r.statusText} in ${r.ms} ms, ${r.size} bytes${r.type ? `, ${r.type}` : ''}\n${Object.entries(r.headers).slice(0, 20).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${r.body != null ? r.body.slice(0, 20_000) : r.binary}`
      }
    }
  ]
}
