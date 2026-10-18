// Profiling: finding out why something is slow by measuring it, not guessing.
//
// "Time it" runs a command several times and keeps the result with the commit it was
// measured at, so a history shows whether a change made it faster. "Where the time goes"
// runs a Node or Python program under its own profiler and says which functions the time
// was spent in, drawn as a flame chart. Results are kept per project, with Prism.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let api = null
let running = null
const RUN_LIMIT_MS = 10 * 60_000

const key = () => createHash('sha1').update((api.root || 'none').toLowerCase()).digest('hex').slice(0, 12)
const dir = () => join(api.dataDir, key())
const histFile = () => join(dir(), 'history.json')

function history() {
  try {
    return JSON.parse(readFileSync(histFile(), 'utf8'))
  } catch {
    return []
  }
}

function saveHistory(list) {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(histFile(), JSON.stringify(list.slice(0, 300)))
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.PRISM_GADGET
  return env
}

/** One run of a command, timed; never longer than the limit. */
function once(command, env) {
  return new Promise((res) => {
    const t0 = process.hrtime.bigint()
    const c = spawn(command, { cwd: api.root || undefined, shell: true, windowsHide: true, env: cleanEnv(env) })
    running = c
    let tail = ''
    const take = (d) => (tail = (tail + d).slice(-4000))
    c.stdout.on('data', take)
    c.stderr.on('data', take)
    const timer = setTimeout(() => kill(c), RUN_LIMIT_MS)
    c.on('close', (code) => {
      clearTimeout(timer)
      running = null
      res({ code: code ?? 1, ms: Number(process.hrtime.bigint() - t0) / 1e6, tail })
    })
    c.on('error', (e) => {
      clearTimeout(timer)
      running = null
      res({ code: 1, ms: 0, tail: e.message })
    })
  })
}

function kill(c) {
  if (!c?.pid) return
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true })
  else c.kill()
}

function commit() {
  return new Promise((res) => {
    const c = spawn('git rev-parse --short HEAD', { cwd: api.root || undefined, shell: true, windowsHide: true })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.on('close', () => res(out.trim()))
    c.on('error', () => res(''))
  })
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0
}

// ---------------------------------------------------------------- time it

async function timeIt({ name, command, runs = 5, warmup = 1 }) {
  if (running) throw new Error('Something is already being measured.')
  runs = Math.max(1, Math.min(50, Number(runs) || 5))
  const label = name || command
  api.emit('progress', { label, step: 'warming up' })
  for (let i = 0; i < warmup; i++) {
    const r = await once(command)
    if (r.code !== 0) throw new Error(`It failed before it could be timed (code ${r.code}):\n${r.tail.trim().split('\n').slice(-8).join('\n')}`)
  }
  const times = []
  for (let i = 0; i < runs; i++) {
    api.emit('progress', { label, step: `run ${i + 1} of ${runs}` })
    const r = await once(command)
    if (r.code !== 0) throw new Error(`Run ${i + 1} failed (code ${r.code}):\n${r.tail.trim().split('\n').slice(-8).join('\n')}`)
    times.push(r.ms)
  }
  const before = history().find((h) => h.kind === 'time' && h.name === label)
  const entry = { id: randomUUID().slice(0, 8), kind: 'time', name: label, command, at: Date.now(), commit: await commit(), runs: times, median: median(times), min: Math.min(...times), max: Math.max(...times) }
  saveHistory([entry, ...history()])
  api.emit('progress', null)
  api.emit('changed', null)
  return { ...entry, before: before ? { median: before.median, commit: before.commit, at: before.at } : null }
}

// ---------------------------------------------------------------- where the time goes

/** A V8 .cpuprofile, as functions with their own time and their time including what they call. */
function readCpuProfile(p) {
  const nodes = new Map(p.nodes.map((n) => [n.id, { ...n, self: 0 }]))
  const deltas = p.timeDeltas ?? []
  ;(p.samples ?? []).forEach((id, i) => {
    const n = nodes.get(id)
    if (n) n.self += (deltas[i + 1] ?? deltas[i] ?? 0) / 1000
  })
  const parent = new Map()
  for (const n of nodes.values()) for (const c of n.children ?? []) parent.set(c, n.id)
  const label = (n) => {
    const f = n.callFrame
    const fn = f.functionName || (f.url ? '(anonymous)' : `(${f.functionName || 'program'})`)
    const where = f.url ? `${f.url.replace(/^file:\/\/\/?/, '').split(/[\\/]/).slice(-2).join('/')}:${f.lineNumber + 1}` : ''
    return { fn, where }
  }
  // the call tree, for the flame chart
  const build = (id, depth) => {
    const n = nodes.get(id)
    const kids = (n.children ?? []).map((c) => build(c, depth + 1)).filter((k) => k.total > 0)
    const total = n.self + kids.reduce((s, k) => s + k.total, 0)
    const { fn, where } = label(n)
    return { name: fn, where, self: n.self, total, children: depth < 60 ? kids : [] }
  }
  const root = build(p.nodes[0].id, 0)
  // functions, self time summed wherever they appear
  const by = new Map()
  for (const n of nodes.values()) {
    const { fn, where } = label(n)
    if (/^\((idle|garbage collector|program|root)\)$/.test(fn) && !where) {
      const k = fn
      by.set(k, { fn, where: '', self: (by.get(k)?.self ?? 0) + n.self })
      continue
    }
    const k = `${fn}@${where}`
    by.set(k, { fn, where, self: (by.get(k)?.self ?? 0) + n.self })
  }
  const total = [...nodes.values()].reduce((s, n) => s + n.self, 0)
  const top = [...by.values()].filter((x) => x.self > 0).sort((a, b) => b.self - a.self).slice(0, 25)
  return { total, top, tree: root }
}

const PY_DUMP = `import json, pstats, sys
s = pstats.Stats(sys.argv[1])
rows = []
for (f, line, fn), (cc, nc, tt, ct, callers) in s.stats.items():
    rows.append({"fn": fn, "where": (f.replace("\\\\", "/").split("/")[-1] + ":" + str(line)) if f != "~" else "", "self": tt * 1000, "cum": ct * 1000, "calls": nc})
rows.sort(key=lambda r: -r["self"])
print(json.dumps({"total": s.total_tt * 1000, "top": rows[:25]}))`

async function profile({ name, command, kind }) {
  if (running) throw new Error('Something is already being measured.')
  const out = join(dir(), 'runs', randomUUID().slice(0, 8))
  mkdirSync(out, { recursive: true })
  const label = name || command
  api.emit('progress', { label, step: 'running under the profiler' })
  let result
  try {
    if (kind === 'node') {
      // the program is started as node normally would be, with the profiler switched on
      const r = await once(command, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --cpu-prof --cpu-prof-interval 200 --cpu-prof-dir="${out.split('\\').join('/')}"`.trim() })
      const files = readdirSync(out).filter((f) => f.endsWith('.cpuprofile'))
      if (!files.length) throw new Error(`No profile came out (code ${r.code}). Is it a Node program? ${r.tail.trim().split('\n').slice(-4).join(' ')}`)
      // several processes: the busiest one is the one worth reading
      const parsed = files.map((f) => readCpuProfile(JSON.parse(readFileSync(join(out, f), 'utf8')))).sort((a, b) => b.total - a.total)
      result = { ...parsed[0], ms: r.ms, code: r.code }
    } else if (kind === 'python') {
      const prof = join(out, 'run.prof')
      const cmd = command.replace(/^\s*(python3?|py)(\.exe)?\s+/i, (m) => `${m.trim()} -m cProfile -o "${prof}" `)
      if (cmd === command) throw new Error('Start the command with python (python script.py …) so it can be run under the profiler.')
      const r = await once(cmd)
      if (!existsSync(prof)) throw new Error(`No profile came out (code ${r.code}). ${r.tail.trim().split('\n').slice(-4).join(' ')}`)
      writeFileSync(join(out, 'dump.py'), PY_DUMP)
      const d = await new Promise((res) => {
        const c = spawn('python', [join(out, 'dump.py'), prof], { windowsHide: true, env: cleanEnv() })
        let s = ''
        c.stdout.on('data', (x) => (s += x))
        c.on('close', () => res(s))
        c.on('error', () => res(''))
      })
      const j = JSON.parse(d || '{}')
      result = { total: j.total ?? 0, top: (j.top ?? []).map((x) => ({ fn: x.fn, where: x.where, self: x.self, cum: x.cum, calls: x.calls })), tree: null, ms: r.ms, code: r.code }
    } else throw new Error('Say node or python.')
  } finally {
    api.emit('progress', null)
    rmSync(out, { recursive: true, force: true })
  }
  const entry = { id: randomUUID().slice(0, 8), kind, name: label, command, at: Date.now(), commit: await commit(), ms: result.ms, total: result.total, top: result.top, tree: result.tree }
  saveHistory([entry, ...history()])
  api.emit('changed', null)
  return entry
}

function topText(e) {
  const share = (x) => (e.total ? `${((x.self / e.total) * 100).toFixed(1)}%` : '')
  return `${e.name}: ran ${Math.round(e.ms)} ms${e.commit ? ` at ${e.commit}` : ''}. Where the time went (own time, not counting what it calls):\n${e.top.slice(0, 15).map((x) => `- ${x.fn}${x.where ? ` (${x.where})` : ''}: ${x.self.toFixed(1)} ms ${share(x)}${x.calls ? `, ${x.calls} calls` : ''}`).join('\n')}`
}

function timeText(e) {
  const change = e.before ? (e.median - e.before.median) / e.before.median : null
  return `${e.name}: median ${e.median.toFixed(0)} ms over ${e.runs.length} runs (fastest ${e.min.toFixed(0)}, slowest ${e.max.toFixed(0)})${e.commit ? ` at ${e.commit}` : ''}.${change != null ? ` Last time${e.before.commit ? ` (${e.before.commit})` : ''}: ${e.before.median.toFixed(0)} ms, so it is ${Math.abs(change * 100).toFixed(0)}% ${change < 0 ? 'faster' : 'slower'}.` : ''}`
}

export default {
  async start(a) {
    api = a
  },
  async stop() {
    kill(running)
  },
  handlers: {
    overview: () => ({ project: api.root || null, history: history().map(({ tree, ...rest }) => rest), running: !!running }),
    entry: (a) => history().find((h) => h.id === a.id) ?? null,
    time: (a) => timeIt(a),
    profile: (a) => profile(a),
    stop: () => {
      kill(running)
      return true
    },
    forget: (a) => {
      saveHistory(history().filter((h) => h.id !== a.id))
      return true
    },
    askAgent: async (a) => {
      await api.agent.send(String(a.text))
      return true
    }
  },
  tools: [
    {
      name: 'profile_time',
      description: 'Time a command: runs it once to warm up, then several times, and keeps the median with the commit it was measured at, so it can be compared with earlier runs (the result says how it compares with last time). Use before and after a change meant to make something faster.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, name: { type: 'string', description: 'What is being timed; the same name is compared over time' }, runs: { type: 'number', description: 'Default 5' } }, required: ['command'] },
      async execute(a) {
        api.ui.show().catch(() => {})
        return timeText(await timeIt(a))
      }
    },
    {
      name: 'profile_where',
      description: "Find where a program spends its time: runs a Node or Python program under its own profiler and lists the functions that took the most time, with where they are. The user sees it as a flame chart. Measure before guessing why something is slow.",
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'How the program is started, like node build.js or python main.py' }, kind: { type: 'string', enum: ['node', 'python'] }, name: { type: 'string' } }, required: ['command', 'kind'] },
      async execute(a) {
        api.ui.show().catch(() => {})
        return topText(await profile(a))
      }
    },
    {
      name: 'profile_history',
      description: 'Earlier measurements in this project: each timing and profile with when and at which commit, to see whether something got faster.',
      parameters: { type: 'object', properties: { name: { type: 'string' } } },
      async execute(a) {
        const list = history().filter((h) => !a.name || h.name === a.name).slice(0, 30)
        if (!list.length) return 'Nothing measured yet.'
        return list.map((h) => `- ${new Date(h.at).toLocaleString()} ${h.commit || ''} ${h.name}: ${h.kind === 'time' ? `median ${h.median.toFixed(0)} ms` : `${Math.round(h.ms)} ms, top: ${h.top[0]?.fn ?? '?'}`}`).join('\n')
      }
    }
  ]
}
