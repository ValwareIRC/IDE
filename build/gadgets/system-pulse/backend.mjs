// How busy this computer is, in plain words: how hard the processor is working, how full
// the memory is, and which programs are doing the most right now.
//
// A program's share is measured over the last few seconds (the change in the time it
// has spent working), not since it started, which would make a program that was busy an
// hour ago look busy now.
import os from 'node:os'

let prev = cpuTimes()
let timer = null
let last = null
let prevProcs = new Map()
let prevAt = 0

function cpuTimes() {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    for (const k in c.times) total += c.times[k]
    idle += c.times.idle
  }
  return { idle, total }
}

/** Programs by how much of the processor they used since the last look, with their memory. */
async function programs(api) {
  let list = []
  if (process.platform === 'win32') {
    const r = await api.shell('powershell -NoProfile -Command "Get-Process | Select-Object Id,Name,CPU,WorkingSet64 | ConvertTo-Json -Compress"', { timeoutMs: 15000 })
    try {
      const arr = JSON.parse(r.stdout || '[]')
      list = (Array.isArray(arr) ? arr : [arr]).map((p) => ({ id: p.Id, name: p.Name, cpuSeconds: p.CPU || 0, mem: p.WorkingSet64 || 0 }))
    } catch {
      return last?.procs ?? []
    }
  } else {
    const r = await api.shell('ps -eo pid,comm,time,rss', { timeoutMs: 15000 })
    list = r.stdout
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map((l) => {
        const [pid, name, time, rss] = l.trim().split(/\s+/)
        const [h, m, s] = time.split(':').map(Number)
        return { id: Number(pid), name, cpuSeconds: (h || 0) * 3600 + (m || 0) * 60 + (s || 0), mem: Number(rss) * 1024 }
      })
  }
  const now = Date.now()
  const seconds = prevAt ? (now - prevAt) / 1000 : 0
  const cores = os.cpus().length
  // the same program often runs as many processes (a browser's tabs): they are added up
  const byName = new Map()
  for (const p of list) {
    const before = prevProcs.get(p.id)
    const used = seconds && before != null ? Math.max(0, p.cpuSeconds - before) : 0
    const share = seconds ? (100 * used) / seconds / cores : 0
    const g = byName.get(p.name) ?? { name: p.name, cpu: 0, mem: 0, count: 0 }
    g.cpu += share
    g.mem += p.mem
    g.count++
    byName.set(p.name, g)
  }
  prevProcs = new Map(list.map((p) => [p.id, p.cpuSeconds]))
  prevAt = now
  return [...byName.values()].filter((g) => g.name !== 'Idle' && g.name !== 'System Idle Process')
}

async function sample(api, withProcs) {
  const now = cpuTimes()
  const cpu = now.total === prev.total ? 0 : 100 * (1 - (now.idle - prev.idle) / (now.total - prev.total))
  prev = now
  last = {
    cpu,
    cores: os.cpus().length,
    host: os.hostname(),
    uptime: os.uptime(),
    memTotal: os.totalmem(),
    memUsed: os.totalmem() - os.freemem(),
    procs: withProcs ? await programs(api) : (last?.procs ?? [])
  }
  return last
}

const gb = (b) => (b / 1073741824).toFixed(1)

export default {
  async start(api) {
    let tick = 0
    await programs(api).catch(() => {})
    timer = setInterval(async () => {
      api.emit('stats', await sample(api, tick++ % 5 === 0))
    }, 1000)
  },
  async stop() {
    clearInterval(timer)
  },
  handlers: {
    stats: (args, api) => sample(api, true)
  },
  tools: [
    {
      name: 'system_stats',
      description: "How busy this computer is: processor use, memory use, and the programs using the most processor and memory right now.",
      parameters: { type: 'object', properties: {} },
      async execute(args, api) {
        const s = await sample(api, true)
        const busy = [...s.procs].sort((a, b) => b.cpu - a.cpu).slice(0, 8)
        const heavy = [...s.procs].sort((a, b) => b.mem - a.mem).slice(0, 8)
        return `Processor ${s.cpu.toFixed(0)}% busy (${s.cores} cores) · memory ${gb(s.memUsed)} of ${gb(s.memTotal)} GB · on for ${Math.floor(s.uptime / 3600)} hours\nBusiest right now:\n${busy.map((p) => `  ${p.name}${p.count > 1 ? ` (${p.count})` : ''}  ${p.cpu.toFixed(0)}%`).join('\n')}\nUsing the most memory:\n${heavy.map((p) => `  ${p.name}${p.count > 1 ? ` (${p.count})` : ''}  ${gb(p.mem)} GB`).join('\n')}`
      }
    }
  ]
}
