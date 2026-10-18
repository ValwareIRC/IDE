// Runs the scratchpad's JavaScript cells. One of these processes lives as long
// as the notebook's session, so what one cell defines the next can use. It is
// started by core/scratch/manager.ts with the project folder as its argument and
// talks to it over the process message channel; anything a cell prints reaches
// the notebook as output for the cell that is running.
import { format, inspect } from 'node:util'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = process.argv[2]
process.chdir(root)
const require = createRequire(path.join(root, 'scratch.js'))
globalThis.require = require

let cell = null
const send = (m) => {
  try {
    process.send(m)
  } catch {
    /* the notebook has gone */
  }
}
const emit = (output) => output && send({ type: 'output', cell, output })

// imports are looked up from the project, not from where this file sits
globalThis.__import = async (spec) => {
  const s = String(spec)
  if (s.startsWith('.') || path.isAbsolute(s)) {
    const abs = path.resolve(root, s)
    let v = ''
    try {
      // a changed file is loaded afresh instead of from the module cache
      v = `?v=${Math.floor(fs.statSync(abs).mtimeMs)}`
    } catch {
      /* let the import itself report that it is missing */
    }
    return import(pathToFileURL(abs).href + v)
  }
  if (/^(node:|file:|data:|https?:)/.test(s)) return import(s)
  try {
    return await import(pathToFileURL(require.resolve(s)).href)
  } catch (e) {
    if (e && (e.code === 'MODULE_NOT_FOUND' || e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')) return import(s)
    throw e
  }
}

const KINDS = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [[0x52, 0x49, 0x46, 0x46], 'image/webp']
]
const sniff = (bytes) => KINDS.find(([sig]) => sig.every((b, i) => bytes[i] === b))?.[1] ?? null
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }

function image(x) {
  if (typeof x === 'string') {
    if (/^(data:image\/|https?:)/.test(x)) return { kind: 'image', src: x }
    const abs = path.resolve(root, x)
    const type = TYPES[path.extname(abs).toLowerCase()] ?? 'image/png'
    return { kind: 'image', src: `data:${type};base64,${fs.readFileSync(abs).toString('base64')}` }
  }
  const bytes = x instanceof Uint8Array ? x : new Uint8Array(x)
  return { kind: 'image', src: `data:${sniff(bytes) ?? 'image/png'};base64,${Buffer.from(bytes).toString('base64')}` }
}

const plain = (v) => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const cellText = (v) => (v === null || v === undefined ? null : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : inspect(v, { depth: 2, breakLength: 80 }))

function table(rows) {
  if (!Array.isArray(rows) || !rows.length || !rows.slice(0, 50).every(plain)) return null
  const columns = []
  for (const r of rows.slice(0, 500)) for (const k of Object.keys(r)) if (!columns.includes(k) && columns.length < 30) columns.push(k)
  return { kind: 'table', columns, rows: rows.slice(0, 500).map((r) => columns.map((c) => cellText(r[c]))), total: rows.length }
}

function json(v) {
  try {
    const text = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x), 2)
    return text === undefined ? null : { kind: 'json', text: text.length > 200_000 ? `${text.slice(0, 200_000)}\n…` : text }
  } catch {
    return null
  }
}

/** How a cell's value is shown. */
function describe(v) {
  if (v === undefined) return null
  if (v instanceof Uint8Array && sniff(v)) return image(v)
  if (typeof v === 'string') return /^\s*<svg[\s>]/.test(v) ? { kind: 'html', html: v } : { kind: 'text', text: v }
  if (Array.isArray(v)) {
    const t = table(v)
    if (t) return t
  }
  if (Array.isArray(v) || plain(v)) {
    const j = json(v)
    if (j) return j
  }
  return { kind: 'text', text: inspect(v, { depth: 4, breakLength: 100 }) }
}

globalThis.show = Object.assign((v) => emit(describe(v)), {
  table: (rows) => emit(table(rows) ?? describe(rows)),
  json: (v) => emit(json(v) ?? describe(v)),
  html: (s) => emit({ kind: 'html', html: String(s) }),
  image: (x) => emit(image(x)),
  text: (s) => emit({ kind: 'text', text: String(s) })
})

for (const level of ['log', 'info', 'debug']) console[level] = (...a) => emit({ kind: 'text', text: `${format(...a)}\n` })
for (const level of ['warn', 'error']) console[level] = (...a) => emit({ kind: 'stderr', text: `${format(...a)}\n` })
console.table = (rows) => emit(table(rows) ?? { kind: 'text', text: `${inspect(rows)}\n` })

function problem(e) {
  if (!(e instanceof Error)) return String(e)
  const lines = String(e.stack ?? e.message).split('\n')
  const head = lines.filter((l) => !/^\s+at /.test(l)).join('\n')
  // of the stack, only the places inside the cell mean anything to its author
  const where = lines.map((l) => /<anonymous>:(\d+):(\d+)\)?$/.exec(l)).filter(Boolean).map((m) => `    at line ${m[1]}`)
  return [head, ...[...new Set(where)].slice(0, 6)].join('\n')
}

process.on('unhandledRejection', (e) => emit({ kind: 'error', text: problem(e) }))
process.on('uncaughtException', (e) => emit({ kind: 'error', text: problem(e) }))

process.on('message', async (m) => {
  if (!m || m.type !== 'run') return
  cell = m.cell
  const t0 = performance.now()
  let ok = true
  try {
    // indirect eval: the code runs at the top of the program, so what it assigns stays for later cells
    emit(describe(await (0, eval)(m.code)))
  } catch (e) {
    ok = false
    emit({ kind: 'error', text: problem(e) })
  }
  send({ type: 'done', cell: m.cell, ok, ms: Math.round(performance.now() - t0) })
})

send({ type: 'ready', version: process.version })
