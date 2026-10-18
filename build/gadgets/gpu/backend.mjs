// A traffic controller for the graphics card. ollama, ComfyUI, Hunyuan3D, Kokoro and
// games all want the same 16 GB, and two big models loading at once is how a card runs
// out and something crashes. This shows what holds the card now, frees what is idle,
// and runs heavy jobs one at a time, each waiting until there is room for it.
//
// Totals come from nvidia-smi, which is exact. Windows' per-program figures over-count
// (a screenshot tool can claim gigabytes), so other programs are only named; the AI
// servers report what they hold themselves, and that is what is shown for them.
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

let api = null
let poll = null
let last = null
const jobs = []
let current = null

const DEFAULT_SERVICES = [
  { name: 'ollama', kind: 'ollama', url: 'http://127.0.0.1:11434' },
  { name: 'ComfyUI', kind: 'comfyui', url: 'http://127.0.0.1:8188' }
]

function run(cmd, args, timeout = 15_000) {
  return new Promise((res) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => res(err ? '' : String(stdout)))
  })
}

async function getJson(url, opts = {}) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), opts.timeout ?? 2500)
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal })
    if (!r.ok) return { ok: false, status: r.status }
    const text = await r.text()
    try {
      return { ok: true, data: JSON.parse(text) }
    } catch {
      return { ok: true, data: text }
    }
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function services() {
  return (await api.state.get('services', null)) ?? DEFAULT_SERVICES
}

// ---------------------------------------------------------------- what holds the card

async function card() {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw', '--format=csv,noheader,nounits'])
  const line = out.split('\n').find((l) => l.trim())
  if (!line) return null
  const [name, total, used, util, temp, power] = line.split(',').map((x) => x.trim())
  return { name, totalMB: Number(total), usedMB: Number(used), freeMB: Number(total) - Number(used), util: Number(util), temp: Number(temp), power: Number(power) }
}

/** Programs with memory on the card, by name, largest first. Windows' sizes are not shown: they over-count. */
async function programs() {
  if (process.platform !== 'win32') return []
  const ps = `$s=(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples | Where-Object CookedValue -gt 100MB | Sort-Object CookedValue -Descending | Select-Object -First 12; foreach($x in $s){ if($x.InstanceName -match 'pid_(\\d+)'){ $p=Get-Process -Id $matches[1] -ErrorAction SilentlyContinue; if($p){ "$($p.Id)|$($p.ProcessName)" } } }`
  const out = await run('powershell', ['-NoProfile', '-Command', ps], 20_000)
  const seen = new Set()
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [pid, name] = l.split('|')
      return { pid: Number(pid), name }
    })
    .filter((p) => !seen.has(p.name) && seen.add(p.name))
}

async function serviceStatus(s) {
  if (s.kind === 'ollama') {
    const ps = await getJson(`${s.url}/api/ps`)
    if (!ps) return { ...s, up: false }
    const models = (ps.data?.models ?? []).map((m) => ({ name: m.name, vramMB: Math.round((m.size_vram ?? 0) / 1048576), sizeMB: Math.round((m.size ?? 0) / 1048576), until: m.expires_at ? Date.parse(m.expires_at) : null }))
    return { ...s, up: true, models, holdsMB: models.reduce((a, m) => a + m.vramMB, 0) }
  }
  if (s.kind === 'comfyui') {
    const [q, st] = await Promise.all([getJson(`${s.url}/queue`), getJson(`${s.url}/system_stats`)])
    if (!q && !st) return { ...s, up: false }
    const dev = st?.data?.devices?.[0]
    return { ...s, up: true, running: q?.data?.queue_running?.length ?? 0, waiting: q?.data?.queue_pending?.length ?? 0, holdsMB: dev ? Math.round((dev.vram_total - dev.vram_free) / 1048576) : null }
  }
  const r = await getJson(s.url, { timeout: 1500 })
  return { ...s, up: !!r }
}

async function status() {
  const [c, progs, svc] = await Promise.all([card(), programs(), Promise.all((await services()).map(serviceStatus))])
  last = { at: Date.now(), card: c, programs: progs, services: svc, jobs: publicJobs(), current: current ? publicJob(current) : null }
  api.emit('status', last)
  return last
}

// ---------------------------------------------------------------- making room

async function unloadOllama(s, model) {
  const st = await serviceStatus(s)
  const names = model ? [model] : (st.models ?? []).map((m) => m.name)
  for (const n of names) await getJson(`${s.url}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: n, keep_alive: 0 }), timeout: 15_000 })
  return names
}

/** Frees what is loaded but not working: ollama's models, ComfyUI's cache. Never stops a program. */
async function free(what = 'all', model) {
  const done = []
  for (const s of await services()) {
    if ((what === 'all' || what === 'ollama') && s.kind === 'ollama') {
      const names = await unloadOllama(s, model).catch(() => [])
      if (names.length) done.push(`ollama let go of ${names.join(', ')}`)
    }
    if ((what === 'all' || what === 'comfyui') && s.kind === 'comfyui') {
      const st = await serviceStatus(s)
      if (st.up && !st.running) {
        const r = await getJson(`${s.url}/free`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }), timeout: 15_000 })
        if (r) done.push('ComfyUI let go of its models')
      } else if (st.up) done.push('ComfyUI is working, so it was left alone')
    }
  }
  await new Promise((r) => setTimeout(r, 1500))
  await status()
  return done.length ? done.join('; ') : 'Nothing idle was holding the card.'
}

// ---------------------------------------------------------------- one heavy job at a time

const publicJob = (j) => ({ id: j.id, name: j.name, command: j.command, needMB: j.needMB, state: j.state, at: j.at, startedAt: j.startedAt ?? null, endedAt: j.endedAt ?? null, code: j.code ?? null, note: j.note ?? '', by: j.by, log: (j.log ?? []).slice(-60) })
const publicJobs = () => jobs.slice(-20).map(publicJob)

function enqueue({ name, command, needGB = 4, cwd, makeRoom = true, by = 'you' }) {
  const j = { id: randomUUID().slice(0, 8), name: name || command, command, cwd, needMB: Math.round(Number(needGB) * 1024), makeRoom, by, state: 'waiting', at: Date.now(), log: [], waiters: [] }
  jobs.push(j)
  api.emit('jobs', publicJobs())
  void pump()
  return j
}

async function pump() {
  if (current) return
  const next = jobs.find((j) => j.state === 'waiting')
  if (!next) return
  current = next
  let tries = 0
  // wait until the card has room, making some once if allowed
  for (;;) {
    if (next.state !== 'waiting') break
    const c = await card()
    if (!c || c.freeMB >= next.needMB) break
    if (next.makeRoom && tries === 0) {
      next.note = `Making room: ${await free('all')}`
      api.emit('jobs', publicJobs())
    } else next.note = `Waiting for ${(next.needMB / 1024).toFixed(1)} GB; ${(c.freeMB / 1024).toFixed(1)} GB free`
    api.emit('jobs', publicJobs())
    tries++
    if (tries > 360) {
      next.state = 'gave up'
      next.note = 'There was not enough room on the card for an hour, so it was not started.'
      break
    }
    await new Promise((r) => setTimeout(r, 10_000))
  }
  if (next.state === 'waiting') {
    next.state = 'running'
    next.startedAt = Date.now()
    api.emit('jobs', publicJobs())
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.PRISM_GADGET
    next.code = await new Promise((res) => {
      const c = spawn(next.command, { cwd: next.cwd || api.root || undefined, shell: true, windowsHide: true, env })
      next.proc = c
      const take = (d) => {
        for (const l of String(d).split(/\r?\n/)) if (l.trim()) next.log.push(l)
        if (next.log.length > 400) next.log.splice(0, next.log.length - 400)
      }
      c.stdout.on('data', take)
      c.stderr.on('data', take)
      c.on('close', (code) => res(code ?? 1))
      c.on('error', (e) => {
        take(e.message)
        res(1)
      })
    })
    next.state = next.state === 'stopped' ? 'stopped' : next.code === 0 ? 'done' : 'failed'
    next.endedAt = Date.now()
  }
  delete next.proc
  current = null
  for (const w of next.waiters.splice(0)) w(next)
  api.emit('jobs', publicJobs())
  if (next.by !== 'you') api.ui.notify('Graphics card', `${next.name}: ${next.state}`).catch(() => {})
  void pump()
}

function stopJob(id) {
  const j = jobs.find((x) => x.id === id)
  if (!j) return false
  if (j.state === 'waiting') {
    j.state = 'stopped'
    if (current === j) current = null
  } else if (j.state === 'running' && j.proc?.pid) {
    j.state = 'stopped'
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(j.proc.pid), '/T', '/F'], { windowsHide: true })
    else j.proc.kill()
  }
  api.emit('jobs', publicJobs())
  void pump()
  return true
}

function statusText(s) {
  if (!s.card) return 'No NVIDIA card was found (nvidia-smi did not answer).'
  const c = s.card
  const lines = [`${c.name}: ${(c.usedMB / 1024).toFixed(1)} of ${(c.totalMB / 1024).toFixed(1)} GB in use, ${(c.freeMB / 1024).toFixed(1)} GB free; ${c.util}% busy, ${c.temp}°C, ${c.power} W.`]
  for (const sv of s.services) {
    if (!sv.up) continue
    if (sv.kind === 'ollama') lines.push(`ollama: ${sv.models.length ? sv.models.map((m) => `${m.name} (${(m.vramMB / 1024).toFixed(1)} GB on the card${m.until ? `, let go ${new Date(m.until).toLocaleTimeString()}` : ''})`).join(', ') : 'running, nothing loaded'}.`)
    else if (sv.kind === 'comfyui') lines.push(`ComfyUI: running${sv.running ? `, working on ${sv.running} job(s)` : ', idle'}${sv.waiting ? `, ${sv.waiting} waiting` : ''}${sv.holdsMB != null ? `, ${(sv.holdsMB / 1024).toFixed(1)} GB in use by it` : ''}.`)
    else lines.push(`${sv.name}: running.`)
  }
  if (s.programs.length) lines.push(`Other programs with memory on the card: ${s.programs.map((p) => p.name).join(', ')}.`)
  const q = s.jobs.filter((j) => ['waiting', 'running'].includes(j.state))
  if (q.length) lines.push(`Queue: ${q.map((j) => `${j.name} (${j.state}${j.note ? `: ${j.note}` : ''})`).join('; ')}.`)
  return lines.join('\n')
}

export default {
  async start(a) {
    api = a
  },
  async stop() {
    clearInterval(poll)
    for (const j of jobs) if (j.state === 'running' || j.state === 'waiting') stopJob(j.id)
  },
  handlers: {
    status: () => status(),
    watch: (a) => {
      clearInterval(poll)
      if (a.on) poll = setInterval(() => void status().catch(() => {}), 4000)
      return true
    },
    free: (a) => free(a.what ?? 'all', a.model),
    enqueue: (a) => publicJob(enqueue({ ...a, by: 'you' })),
    stopJob: (a) => stopJob(String(a.id)),
    services: () => services(),
    saveServices: async (a) => {
      await api.state.set('services', a.services)
      return status()
    }
  },
  tools: [
    {
      name: 'gpu_status',
      description: "What is on the graphics card now: memory used and free, what ollama has loaded, whether ComfyUI is working, which other programs hold memory, and the job queue. Check before starting anything that loads a model or renders on the card.",
      parameters: { type: 'object', properties: {} },
      async execute() {
        return statusText(await status())
      }
    },
    {
      name: 'gpu_free',
      description: 'Make room on the graphics card by letting go of what is loaded but idle: ollama models (all, or one by name) and ComfyUI\'s cache when it is not working. Never stops a program.',
      parameters: { type: 'object', properties: { what: { type: 'string', enum: ['all', 'ollama', 'comfyui'] }, model: { type: 'string', description: 'One ollama model' } } },
      async execute(a) {
        return free(a.what ?? 'all', a.model)
      }
    },
    {
      name: 'gpu_run',
      description: 'Run a heavy job on the graphics card through the queue: one at a time, each waiting until the card has the memory it needs (making room from idle models first). Waits for it to finish and reports its last lines. Use it for anything that loads a big model or renders, so two never crash into each other.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, needGB: { type: 'number', description: 'Memory it needs on the card, in GB' }, name: { type: 'string' }, cwd: { type: 'string' } }, required: ['command', 'needGB'] },
      async execute(a) {
        api.ui.show().catch(() => {})
        const j = enqueue({ ...a, by: 'Prism' })
        const done = await new Promise((res) => j.waiters.push(res))
        return { content: `${done.name}: ${done.state}${done.code != null ? ` (code ${done.code})` : ''}${done.note ? `. ${done.note}` : ''}\n${done.log.slice(-20).join('\n')}`, isError: done.state !== 'done' }
      }
    }
  ]
}
