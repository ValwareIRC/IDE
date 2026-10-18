// The decisions ledger's panel. Prism itself writes the ledger (.prism/decisions.jsonl in
// the project) whenever a question is answered; this reads it, lets the user add a reason,
// add a decision by hand, or mark one as changed, and tells the page when it grows.
import { existsSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

let api = null
let watched = null

const file = () => (api.root ? join(api.root, '.prism', 'decisions.jsonl') : null)

function read() {
  const f = file()
  if (!f || !existsSync(f)) return []
  const out = []
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* a half-written line */
    }
  }
  return out
}

function write(list) {
  const f = file()
  mkdirSync(join(api.root, '.prism'), { recursive: true })
  writeFileSync(f, list.map((d) => JSON.stringify(d)).join('\n') + (list.length ? '\n' : ''), 'utf8')
}

function change(id, fn) {
  const list = read()
  const d = list.find((x) => x.id === id)
  if (!d) throw new Error('That decision is no longer in the ledger.')
  fn(d)
  write(list)
  return overview()
}

function overview() {
  return { project: api.root, decisions: read().reverse() }
}

function watch() {
  const f = file()
  if (watched === f) return
  if (watched) unwatchFile(watched)
  watched = f
  if (f) watchFile(f, { interval: 1500 }, () => api.emit('changed', null))
}

export default {
  async start(a) {
    api = a
    watch()
  },
  async stop() {
    if (watched) unwatchFile(watched)
  },
  handlers: {
    overview: () => {
      watch()
      return overview()
    },
    why: (a) => change(a.id, (d) => {
      d.why = String(a.why ?? '').trim() || undefined
    }),
    markChanged: (a) => change(a.id, (d) => {
      // kept, not deleted: what was decided once, and that it changed, are both part of the story
      d.changed = a.on ? { at: Date.now(), note: String(a.note ?? '').trim() || undefined } : undefined
    }),
    add: (a) => {
      const question = String(a.question ?? '').trim()
      const answer = String(a.answer ?? '').trim()
      if (!question || !answer) throw new Error('Write the question and what was decided.')
      write([...read(), { id: randomUUID().slice(0, 8), at: Date.now(), kind: 'recorded', by: 'user', question, answer, why: String(a.why ?? '').trim() || undefined }])
      return overview()
    }
  }
}
