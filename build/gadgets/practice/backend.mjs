// Keeping the user's own skills sharp, so working with an agent does not wear them away.
//
// The Pre-mortem: before the agent diagnoses a real problem, the user says in one line
// what they think is wrong and what they would try first; afterwards the two are
// compared and recorded, so over months there is a record of where their instincts are
// good and where they are going soft. The Workshop: now and then the agent hands over a
// small, real piece of the project to do by hand, and talks it over afterwards like a
// colleague. And the user's own courses, listed in its settings, run here as lessons.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let api = null
const servers = new Map()

const recordFile = () => join(api.dataDir, 'record.json')

function record() {
  try {
    return JSON.parse(readFileSync(recordFile(), 'utf8'))
  } catch {
    return []
  }
}

function saveRecord(list) {
  mkdirSync(api.dataDir, { recursive: true })
  writeFileSync(recordFile(), JSON.stringify(list.slice(0, 2000), null, 2))
}

function addEntry(e) {
  const list = record()
  const entry = { id: randomUUID().slice(0, 8), at: Date.now(), project: api.root ? api.root.split(/[\\/]/).pop() : '', ...e }
  list.unshift(entry)
  saveRecord(list)
  api.emit('record', list.slice(0, 200))
  return entry
}

/** Hit rate overall and by area, from the Pre-mortems. */
function tally() {
  const pm = record().filter((e) => e.kind === 'premortem')
  const score = (xs) => (xs.length ? (xs.filter((x) => x.verdict === 'right').length + xs.filter((x) => x.verdict === 'close').length * 0.5) / xs.length : null)
  const areas = new Map()
  for (const e of pm) areas.set(e.area || 'other', [...(areas.get(e.area || 'other') ?? []), e])
  const recent = pm.slice(0, 20)
  return {
    count: pm.length,
    score: score(pm),
    recent: score(recent),
    areas: [...areas.entries()].map(([area, xs]) => ({ area, count: xs.length, score: score(xs) })).sort((a, b) => b.count - a.count),
    workshops: record().filter((e) => e.kind === 'workshop').length,
    lastWorkshop: record().find((e) => e.kind === 'workshop')?.at ?? null
  }
}

// ---------------------------------------------------------------- the courses

/** Courses are each person's own: { name, title, dir (with a curriculum folder), port }, kept in the gadget's state. */
const DEFAULT_COURSES = []

async function courses() {
  const list = (await api.state.get('courses', null)) ?? DEFAULT_COURSES
  return list.filter((c) => existsSync(join(c.dir, 'curriculum'))).map((c) => {
    let lessons = []
    try {
      lessons = readdirSync(join(c.dir, 'curriculum'))
        .filter((n) => /^\d{3}-/.test(n))
        .sort()
        .map((id) => {
          let meta = {}
          try {
            meta = JSON.parse(readFileSync(join(c.dir, 'curriculum', id, 'meta.json'), 'utf8'))
          } catch {
            /* a lesson without meta */
          }
          return { id, n: meta.n ?? Number(id.slice(0, 3)), title: meta.title ?? id.slice(4).replace(/-/g, ' '), concept: meta.concept ?? '' }
        })
    } catch {
      /* unreadable */
    }
    let progress = {}
    try {
      progress = JSON.parse(readFileSync(join(c.dir, 'state', 'progress.json'), 'utf8'))
    } catch {
      /* not started */
    }
    const passed = lessons.filter((l) => progress[l.id]?.passed)
    const next = lessons.find((l) => !progress[l.id]?.passed) ?? null
    const lastAt = Object.values(progress).map((p) => Date.parse(p.passedAt ?? '') || 0).sort((a, b) => b - a)[0] || null
    return { ...c, total: lessons.length, passed: passed.length, next, lastAt, running: servers.has(c.name), url: `http://127.0.0.1:${c.port}` }
  })
}

async function answering(url) {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 1500)
    const r = await fetch(url, { signal: ctl.signal })
    clearTimeout(t)
    return r.ok || r.status < 500
  } catch {
    return false
  }
}

/** Starts a course's own server (or finds it already running) and gives its address. */
async function openCourse(name) {
  const c = (await courses()).find((x) => x.name === name)
  if (!c) throw new Error(`There is no course called ${name}.`)
  if (await answering(c.url)) return c.url
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.PRISM_GADGET
  const child = spawn('node', ['server/main.js'], { cwd: c.dir, windowsHide: true, env })
  servers.set(name, child)
  child.on('close', () => servers.delete(name))
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await answering(c.url)) return c.url
  }
  throw new Error(`${name} did not start within ten seconds.`)
}

// ---------------------------------------------------------------- the agent's prompts

const WORKSHOP = `Workshop time. Pick one small, real piece of this project for me to do by hand: a function to write, a bug to find in code I have not touched lately, or a design choice to make. It must be real (part of the work, with real consequences), small (well under an hour), and in an area I have not done myself recently. Set it up if it needs setting up (a failing test, a stub, a note of what "done" means), tell me in a few lines what it is and why you picked it, then stop: do not do it, do not hint unless I ask. When I say I am done, look at what I did like a colleague would, talk it over, and record it with practice_record (kind "workshop").`

export default {
  async start(a) {
    api = a
    // an offer now and then, if the user wants one
    const every = await api.state.get('workshopEvery', 'off')
    const days = { weekly: 7, fortnightly: 14 }[every]
    const last = tally().lastWorkshop
    if (days && (!last || Date.now() - last > days * 86400_000)) {
      const offered = await api.state.get('offeredAt', 0)
      if (Date.now() - offered > 86400_000) {
        await api.state.set('offeredAt', Date.now())
        api.ui.notify('Practice', 'It has been a while since your last Workshop piece. Open Practice when you fancy one.').catch(() => {})
      }
    }
  },
  async stop() {
    for (const c of servers.values()) {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true })
      else c.kill()
    }
  },
  handlers: {
    overview: async () => ({ premortem: (await api.state.get('premortem', 'on')) === 'on', workshopEvery: await api.state.get('workshopEvery', 'off'), tally: tally(), record: record().slice(0, 100), courses: await courses() }),
    setPremortem: async (a) => {
      await api.state.set('premortem', a.on ? 'on' : 'off')
      return true
    },
    setWorkshopEvery: async (a) => {
      await api.state.set('workshopEvery', a.every)
      return true
    },
    workshop: async () => {
      await api.agent.send(WORKSHOP)
      return true
    },
    openCourse: (a) => openCourse(String(a.name)),
    forget: (a) => {
      saveRecord(record().filter((e) => e.id !== a.id))
      return true
    }
  },
  tools: [
    {
      name: 'practice_record',
      description:
        'Record a Pre-mortem or a Workshop piece. Pre-mortem: after a diagnosis where the user said up front what they thought was wrong, give their guess, what it really was, a verdict ("right", "close" or "missed") and the area (like "networking", "build", "UI", "phone app", "concurrency"). Workshop: what the piece was and how it went. The panel keeps the record and the hit rate by area.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['premortem', 'workshop'] },
          area: { type: 'string' },
          guess: { type: 'string', description: 'What the user said they thought was wrong (and would try first)' },
          actual: { type: 'string', description: 'What it really was' },
          verdict: { type: 'string', enum: ['right', 'close', 'missed'] },
          note: { type: 'string', description: 'One or two sentences comparing notes, or how the Workshop piece went' }
        },
        required: ['kind']
      },
      async execute(a) {
        const e = addEntry({ kind: a.kind, area: a.area ?? '', guess: a.guess ?? '', actual: a.actual ?? '', verdict: a.verdict ?? null, note: a.note ?? '' })
        const t = tally()
        return `Recorded. ${a.kind === 'premortem' && t.score != null ? `Pre-mortems so far: ${t.count}, ${(t.score * 100).toFixed(0)}% right (counting close as half).` : ''}`.trim() + ` (${e.id})`
      }
    },
    {
      name: 'practice_status',
      description: "Whether the Pre-mortem is on, the user's record so far (hit rate overall and by area), Workshop history, and progress in their courses.",
      parameters: { type: 'object', properties: {} },
      async execute() {
        const t = tally()
        const on = (await api.state.get('premortem', 'on')) === 'on'
        const cs = await courses()
        return [
          `Pre-mortem: ${on ? 'on' : 'off'}. ${t.count ? `${t.count} so far, ${(t.score * 100).toFixed(0)}% right${t.recent != null ? ` (last 20: ${(t.recent * 100).toFixed(0)}%)` : ''}. By area: ${t.areas.map((x) => `${x.area} ${(x.score * 100).toFixed(0)}% of ${x.count}`).join(', ')}.` : 'None recorded yet.'}`,
          `Workshop pieces: ${t.workshops}${t.lastWorkshop ? `, last ${new Date(t.lastWorkshop).toLocaleDateString()}` : ''}.`,
          ...cs.map((c) => `Course ${c.name}: ${c.passed} of ${c.total} lessons passed${c.next ? `; next: ${c.next.n}. ${c.next.title}` : ', finished'}.`)
        ].join('\n')
      }
    }
  ]
}
