import type { GadgetFiles } from './types'

/** Installed into the global gadgets folder on first run, as a working reference. */
export const EXAMPLE_GADGET_ID = 'system-pulse'

export const EXAMPLE_GADGET: GadgetFiles = {
  'gadget.json': JSON.stringify(
    {
      id: 'system-pulse',
      name: 'System pulse',
      description: 'Live CPU, memory and top processes for this machine. The agent can read the same numbers with system_stats.',
      icon: 'activity',
      backend: 'backend.mjs',
      permissions: { shell: true, network: false, workspace: 'none' }
    },
    null,
    2
  ),
  'index.html': `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="prism-gadget://_sdk/base.css">
  <script src="prism-gadget://_sdk/prism.js"></script>
  <style>
    .wrap { padding: 14px; display: grid; gap: 12px; }
    .row { display: flex; gap: 12px; }
    .stat { flex: 1; }
    .label { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-3, #6d7489); }
    .value { font-family: var(--font-mono, monospace); font-size: 22px; }
    .bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,.08); overflow: hidden; margin-top: 6px; }
    .bar i { display: block; height: 100%; background: var(--accent, #8ad8ff); transition: width .4s ease; box-shadow: 0 0 10px var(--accent, #8ad8ff); }
    .hist { display: flex; align-items: flex-end; gap: 2px; height: 60px; }
    .hist i { flex: 1; background: color-mix(in srgb, var(--accent, #8ad8ff) 55%, transparent); border-radius: 2px 2px 0 0; min-height: 1px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    td { padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,.05); }
    td.num { text-align: right; font-family: var(--font-mono, monospace); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="row">
      <div class="stat card"><div class="label">CPU</div><div class="value" id="cpu">—</div><div class="bar"><i id="cpuBar"></i></div></div>
      <div class="stat card"><div class="label">Memory</div><div class="value" id="mem">—</div><div class="bar"><i id="memBar"></i></div></div>
      <div class="stat card"><div class="label">Uptime</div><div class="value" id="up">—</div><div class="dim" id="host"></div></div>
    </div>
    <div class="card"><div class="label">CPU, last minute</div><div class="hist" id="hist"></div></div>
    <div class="card">
      <div class="label" style="display:flex;justify-content:space-between;align-items:center">Top processes <button id="ask">Ask the agent what is eating CPU</button></div>
      <table id="procs"></table>
    </div>
  </div>
  <script>
    const hist = []
    const el = (id) => document.getElementById(id)
    function render(s) {
      el('cpu').textContent = s.cpu.toFixed(0) + '%'
      el('cpuBar').style.width = s.cpu + '%'
      el('mem').textContent = (s.memUsed / 1073741824).toFixed(1) + ' / ' + (s.memTotal / 1073741824).toFixed(0) + ' GB'
      el('memBar').style.width = (100 * s.memUsed / s.memTotal) + '%'
      el('up').textContent = Math.floor(s.uptime / 3600) + 'h ' + Math.floor((s.uptime % 3600) / 60) + 'm'
      el('host').textContent = s.host + ' · ' + s.cores + ' cores'
      hist.push(s.cpu); if (hist.length > 60) hist.shift()
      el('hist').innerHTML = hist.map((v) => '<i style="height:' + Math.max(2, v) + '%"></i>').join('')
      el('procs').innerHTML = (s.procs || []).map((p) => '<tr><td>' + p.name + '</td><td class="num">' + p.cpu.toFixed(0) + '%</td><td class="num">' + (p.mem / 1048576).toFixed(0) + ' MB</td></tr>').join('')
    }
    prism.on('stats', render)
    prism.ready(async () => { try { render(await prism.call('stats')) } catch (e) { console.error(e) } })
    el('ask').onclick = () => prism.agent.send('Using the system_stats tool, tell me what is using the most CPU right now and whether anything looks wrong.')
  </script>
</body>
</html>
`,
  'backend.mjs': `import os from 'node:os'

let prev = cpuTimes()
let timer = null
let last = null

function cpuTimes() {
  let idle = 0, total = 0
  for (const c of os.cpus()) { for (const k in c.times) total += c.times[k]; idle += c.times.idle }
  return { idle, total }
}

async function topProcesses(api) {
  if (process.platform === 'win32') {
    const r = await api.shell('powershell -NoProfile -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Name,CPU,WorkingSet64 | ConvertTo-Json -Compress"', { timeoutMs: 15000 })
    try {
      const arr = JSON.parse(r.stdout || '[]')
      const totalCpu = arr.reduce((a, p) => a + (p.CPU || 0), 0) || 1
      return (Array.isArray(arr) ? arr : [arr]).map((p) => ({ name: p.Name, cpu: 100 * (p.CPU || 0) / totalCpu, mem: p.WorkingSet64 || 0 }))
    } catch { return [] }
  }
  const r = await api.shell('ps -eo comm,%cpu,rss --sort=-%cpu | head -9', { timeoutMs: 15000 })
  return r.stdout.split('\\n').slice(1).filter(Boolean).map((l) => { const [name, cpu, rss] = l.trim().split(/\\s+/); return { name, cpu: Number(cpu), mem: Number(rss) * 1024 } })
}

async function sample(api, withProcs) {
  const now = cpuTimes()
  const cpu = now.total === prev.total ? 0 : 100 * (1 - (now.idle - prev.idle) / (now.total - prev.total))
  prev = now
  last = {
    cpu, cores: os.cpus().length, host: os.hostname(), uptime: os.uptime(),
    memTotal: os.totalmem(), memUsed: os.totalmem() - os.freemem(),
    procs: withProcs ? await topProcesses(api) : (last && last.procs) || []
  }
  return last
}

export default {
  async start(api) {
    let tick = 0
    timer = setInterval(async () => { api.emit('stats', await sample(api, tick++ % 5 === 0)) }, 1000)
  },
  async stop() { clearInterval(timer) },
  handlers: {
    stats: (args, api) => sample(api, true)
  },
  tools: [
    {
      name: 'system_stats',
      description: 'Current CPU %, memory use and the top processes on this machine.',
      parameters: { type: 'object', properties: {} },
      async execute(args, api) {
        const s = await sample(api, true)
        return \`CPU \${s.cpu.toFixed(0)}% · memory \${(s.memUsed / 1073741824).toFixed(1)}/\${(s.memTotal / 1073741824).toFixed(0)} GB · uptime \${Math.floor(s.uptime / 3600)}h\\nTop processes:\\n\` +
          s.procs.map((p) => \`  \${p.name}  \${p.cpu.toFixed(0)}%  \${(p.mem / 1048576).toFixed(0)} MB\`).join('\\n')
      }
    }
  ]
}
`
}
