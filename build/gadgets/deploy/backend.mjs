// Deploying to servers, with a way back. Each place a project is deployed to is a
// target: the steps that put the new version there, a health check that says whether
// it is working, and the steps that put the previous version back. A deploy keeps the
// running copy first, deploys, checks, and if the check fails puts the old one back
// by itself and checks again.
//
// It always asks first. A server is often shared (with a real site and
// other people's things on it), so nothing runs until the user has said yes in the
// panel: the agent's request waits there, with exactly what would run.
//
// The targets live in the project, in .prism/deploy.json. Passwords and secret
// addresses never do: a command or address says {secret:NAME}, and the value is kept
// encrypted with the user's other secrets.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const CONFIG = '.prism/deploy.json'
const LOG_LINES = 500

let api = null
let pending = null
let run = null
let child = null
let stopping = false
let emitTimer = null
const lastHealth = new Map()

const here = (p) => join(api.root, p)
const projectKey = () => createHash('sha1').update(api.root.toLowerCase()).digest('hex').slice(0, 12)
const historyFile = () => join(api.dataDir, projectKey(), 'deploys.json')

function history() {
  try {
    return JSON.parse(readFileSync(historyFile(), 'utf8'))
  } catch {
    return []
  }
}

function saveHistory(list) {
  mkdirSync(dirname(historyFile()), { recursive: true })
  writeFileSync(historyFile(), JSON.stringify(list.slice(0, 80), null, 2))
}

function cleanEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.PRISM_GADGET
  return env
}

// ---------------------------------------------------------------- the targets

function readConfig() {
  let text
  try {
    text = readFileSync(here(CONFIG), 'utf8')
  } catch {
    return { targets: [], missing: true }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { targets: [], error: `${CONFIG} is not valid JSON: ${e.message}` }
  }
  const steps = (list) => (Array.isArray(list) ? list.filter((s) => s && typeof s.run === 'string').map((s, i) => ({ name: String(s.name ?? `Step ${i + 1}`), run: s.run })) : [])
  const targets = (Array.isArray(raw.targets) ? raw.targets : [])
    .filter((t) => t && typeof t.name === 'string')
    .map((t) => ({
      name: t.name,
      server: t.server ? String(t.server) : '',
      shared: t.shared === true,
      note: t.note ? String(t.note) : '',
      backup: steps(t.backup),
      steps: steps(t.steps),
      health: t.health && (t.health.url || t.health.command) ? { url: t.health.url ? String(t.health.url) : '', command: t.health.command ? String(t.health.command) : '', expect: Number(t.health.expect ?? 200), contains: t.health.contains ? String(t.health.contains) : '', tries: Math.max(1, Math.min(30, Number(t.health.tries ?? 5))), waitMs: Math.max(500, Math.min(60_000, Number(t.health.waitMs ?? 3000))) } : null,
      rollback: steps(t.rollback)
    }))
  return { targets }
}

function target(name) {
  const t = readConfig().targets.find((x) => x.name.toLowerCase() === String(name ?? '').toLowerCase())
  if (!t) throw new Error(`There is no deploy target called "${name}". Targets: ${readConfig().targets.map((x) => x.name).join(', ') || 'none yet'}.`)
  return t
}

/** The names of the secrets a target uses. */
function secretsOf(t) {
  const all = JSON.stringify(t)
  return [...new Set([...all.matchAll(/\{secret:([\w-]+)\}/g)].map((m) => m[1]))]
}

async function fill(text, values, ctx = {}) {
  let out = String(text)
    .replaceAll('{root}', api.root)
    .replaceAll('{temp}', tmpdir())
    .replaceAll('{date}', new Date().toISOString().slice(0, 10))
    .replaceAll('{commit}', ctx.commit ?? '')
  for (const [k, v] of Object.entries(values)) out = out.replaceAll(`{secret:${k}}`, v)
  return out
}

async function secretValues(t) {
  const out = {}
  for (const name of secretsOf(t)) {
    const v = await api.secrets.get(`${projectKey()}:${name}`)
    if (v == null || v === '') throw new Error(`The secret ${name} that "${t.name}" uses is not set. Set it in the Deploy panel's settings.`)
    out[name] = v
  }
  return out
}

/** A secret's value never reaches a log, a question or the agent. */
function mask(text, values) {
  let out = String(text)
  for (const v of Object.values(values)) if (v && v.length >= 3) out = out.split(v).join('••••')
  return out
}

// ---------------------------------------------------------------- running

function emitSoon() {
  if (emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = null
    api.emit('run', publicRun())
  }, 250)
}

function publicRun() {
  if (!run) return null
  return { ...run, steps: run.steps.map((s) => ({ ...s, log: s.log.slice(-160) })) }
}

function addLog(step, chunk, values) {
  for (const line of String(chunk).replace(/\r(?!\n)/g, '\n').split(/\r?\n/)) {
    if (!line.trim()) continue
    step.log.push(mask(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), values))
  }
  if (step.log.length > LOG_LINES) step.log.splice(0, step.log.length - LOG_LINES)
  emitSoon()
}

function exec(step, command, values) {
  return new Promise((res) => {
    addLog(step, `> ${command}`, values)
    const c = spawn(command, { cwd: api.root, shell: true, windowsHide: true, env: cleanEnv() })
    child = c
    // nothing a deploy runs should sit waiting for a password nobody can type
    c.stdin.end()
    c.stdout.on('data', (d) => addLog(step, d, values))
    c.stderr.on('data', (d) => addLog(step, d, values))
    c.on('error', (e) => addLog(step, e.message, values))
    c.on('close', (code) => {
      child = null
      res(code ?? 1)
    })
  })
}

function killChild() {
  if (!child?.pid) return
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill()
}

async function checkHealth(t, values, step) {
  const h = t.health
  if (!h) return { ok: true, said: 'No health check is set, so it is taken on trust.' }
  let said = ''
  for (let i = 0; i < h.tries; i++) {
    if (stopping) return { ok: false, said: 'Stopped.' }
    let ok = true
    const parts = []
    if (h.url) {
      const url = await fill(h.url, values)
      try {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), 10_000)
        const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' })
        clearTimeout(timer)
        const body = (await r.text()).slice(0, 2000)
        const good = r.status === h.expect && (!h.contains || body.includes(h.contains))
        ok &&= good
        parts.push(`${mask(url, values)} answered ${r.status}${h.contains ? (body.includes(h.contains) ? `, says "${h.contains}"` : `, does not say "${h.contains}"`) : ''}`)
      } catch (e) {
        ok = false
        parts.push(`${mask(url, values)} did not answer (${e.name === 'AbortError' ? 'no reply in 10 seconds' : e.message})`)
      }
    }
    if (h.command) {
      const probe = step ?? { log: [] }
      const before = probe.log.length
      const code = await exec(probe, await fill(h.command, values), values)
      const out = probe.log.slice(before + 1).join('\n')
      const good = code === 0 && (!h.contains || out.includes(h.contains))
      ok &&= good
      parts.push(`the check command ${good ? 'passed' : `failed (code ${code})`}`)
    }
    said = parts.join('; ')
    if (step) addLog(step, `try ${i + 1}: ${said}`, values)
    if (ok) return { ok: true, said }
    if (i < h.tries - 1) await new Promise((r) => setTimeout(r, h.waitMs))
  }
  return { ok: false, said }
}

/** Asks the user in the panel and waits for the answer. Nothing runs before a yes. */
function askFirst(t, kind, by, values) {
  if (pending) pending.resolve(false)
  const list = kind === 'rollback' ? t.rollback : [...t.backup, ...t.steps]
  return new Promise((resolve) => {
    const id = randomUUID()
    const timer = setTimeout(() => answer(id, false, 'no answer in 15 minutes'), 15 * 60_000)
    pending = { id, target: t.name, server: t.server, shared: t.shared, kind, by, at: Date.now(), commands: list.map((s) => ({ name: s.name, run: mask(s.run, values) })), resolve: (yes) => { clearTimeout(timer); resolve(yes) } }
    api.emit('pending', publicPending())
    api.ui.show().catch(() => {})
    api.ui.notify('Deploy', `${by === 'you' ? 'Confirm' : 'Prism asks'}: ${kind === 'rollback' ? 'put back the previous version of' : 'deploy'} ${t.name}${t.server ? ` on ${t.server}` : ''}? Answer in the Deploy panel.`).catch(() => {})
  })
}

function publicPending() {
  if (!pending) return null
  const { resolve: _r, ...rest } = pending
  return rest
}

function answer(id, yes, why) {
  if (!pending || pending.id !== id) return false
  const p = pending
  pending = null
  api.emit('pending', null)
  p.resolve(!!yes)
  if (!yes && why) api.log(`deploy of ${p.target} not done: ${why}`)
  return true
}

async function commit() {
  return new Promise((res) => {
    const c = spawn('git rev-parse --short HEAD', { cwd: api.root, shell: true, windowsHide: true, env: cleanEnv() })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.on('close', () => res(out.trim()))
    c.on('error', () => res(''))
  })
}

async function deploy(name, by, alreadyAsked) {
  if (run?.status === 'running') throw new Error(`A deploy of ${run.target} is under way.`)
  const t = target(name)
  if (!t.steps.length) throw new Error(`"${t.name}" has no steps to deploy with.`)
  const values = await secretValues(t)
  if (!alreadyAsked && !(await askFirst(t, 'deploy', by, values))) return { target: t.name, status: 'declined', steps: [], health: null }
  const at = await commit()
  const mk = (s, stage) => ({ name: s.name, run: s.run, stage, status: 'waiting', startedAt: null, endedAt: null, log: [], note: '' })
  run = { id: randomUUID(), target: t.name, server: t.server, commit: at, by, status: 'running', startedAt: Date.now(), endedAt: null, steps: [...t.backup.map((s) => mk(s, 'backup')), ...t.steps.map((s) => mk(s, 'deploy')), mk({ name: 'Check it is working', run: '' }, 'health')], health: null, rolledBack: false, error: null }
  stopping = false
  emitSoon()
  let failedAt = null
  for (const step of run.steps) {
    if (failedAt) {
      step.status = 'skipped'
      continue
    }
    step.status = 'running'
    step.startedAt = Date.now()
    emitSoon()
    if (step.stage === 'health') {
      const h = await checkHealth(t, values, step)
      run.health = h
      lastHealth.set(t.name, { ...h, at: Date.now() })
      step.status = h.ok ? 'done' : 'failed'
      step.note = h.said
      if (!h.ok) failedAt = step
    } else {
      const code = await exec(step, await fill(step.run, values, { commit: at }), values)
      step.status = code === 0 ? 'done' : stopping ? 'skipped' : 'failed'
      if (code !== 0) {
        step.note = stopping ? 'Stopped.' : `Stopped with code ${code}.`
        failedAt = step
      }
    }
    step.endedAt = Date.now()
    emitSoon()
  }
  // the way back: anything that went wrong after the running copy was touched is undone
  const touched = failedAt && failedAt.stage !== 'backup'
  if (touched && t.rollback.length && !stopping) {
    run.rolledBack = true
    const back = t.rollback.map((s) => mk(s, 'rollback'))
    run.steps.push(...back, mk({ name: 'Check the old one works', run: '' }, 'recheck'))
    emitSoon()
    let backOk = true
    for (const step of run.steps.filter((s) => s.stage === 'rollback' || s.stage === 'recheck')) {
      step.status = 'running'
      step.startedAt = Date.now()
      emitSoon()
      if (step.stage === 'recheck') {
        if (!backOk) {
          step.status = 'skipped'
        } else {
          const h = await checkHealth(t, values, step)
          step.status = h.ok ? 'done' : 'failed'
          step.note = h.said
          lastHealth.set(t.name, { ...h, at: Date.now() })
        }
      } else {
        const code = await exec(step, await fill(step.run, values, { commit: at }), values)
        step.status = code === 0 ? 'done' : 'failed'
        if (code !== 0) {
          step.note = `Stopped with code ${code}.`
          backOk = false
        }
      }
      step.endedAt = Date.now()
      emitSoon()
    }
    run.status = backOk && run.steps.at(-1).status === 'done' ? 'rolled back' : 'broken'
  } else run.status = failedAt ? (stopping ? 'stopped' : 'failed') : 'deployed'
  if (failedAt) run.error = `${failedAt.name}: ${failedAt.note}`
  run.endedAt = Date.now()
  emitSoon()
  saveHistory([{ target: t.name, server: t.server, commit: at, by, at: run.startedAt, status: run.status, error: run.error, health: run.health?.said ?? null }, ...history()])
  const say = { deployed: `${t.name} is deployed and working.`, 'rolled back': `${t.name} did not work after deploying, so the previous version was put back. ${run.error ?? ''}`, broken: `${t.name} did not work after deploying, and putting the previous version back failed too. Look now.`, failed: `Deploying ${t.name} failed before it changed anything that runs. ${run.error ?? ''}`, stopped: `Deploying ${t.name} was stopped.` }[run.status]
  api.ui.notify('Deploy', say).catch(() => {})
  return run
}

async function rollBack(name, by, alreadyAsked) {
  if (run?.status === 'running') throw new Error(`A deploy of ${run.target} is under way.`)
  const t = target(name)
  if (!t.rollback.length) throw new Error(`"${t.name}" has no steps for putting the previous version back.`)
  const values = await secretValues(t)
  if (!alreadyAsked && !(await askFirst(t, 'rollback', by, values))) return { target: t.name, status: 'declined', steps: [] }
  const mk = (s, stage) => ({ name: s.name, run: s.run, stage, status: 'waiting', startedAt: null, endedAt: null, log: [], note: '' })
  run = { id: randomUUID(), target: t.name, server: t.server, commit: '', by, status: 'running', startedAt: Date.now(), endedAt: null, steps: [...t.rollback.map((s) => mk(s, 'rollback')), mk({ name: 'Check it is working', run: '' }, 'recheck')], health: null, rolledBack: true, error: null, manual: true }
  stopping = false
  let ok = true
  for (const step of run.steps) {
    step.status = 'running'
    step.startedAt = Date.now()
    emitSoon()
    if (step.stage === 'recheck') {
      if (!ok) step.status = 'skipped'
      else {
        const h = await checkHealth(t, values, step)
        run.health = h
        lastHealth.set(t.name, { ...h, at: Date.now() })
        step.status = h.ok ? 'done' : 'failed'
        step.note = h.said
        ok = h.ok
      }
    } else {
      const code = await exec(step, await fill(step.run, values), values)
      step.status = code === 0 ? 'done' : 'failed'
      if (code !== 0) {
        ok = false
        step.note = `Stopped with code ${code}.`
        run.error = `${step.name}: ${step.note}`
      }
    }
    step.endedAt = Date.now()
    emitSoon()
  }
  run.status = ok ? 'rolled back' : 'broken'
  run.endedAt = Date.now()
  emitSoon()
  saveHistory([{ target: t.name, server: t.server, commit: '', by, at: run.startedAt, status: ok ? 'put back' : 'broken', error: run.error, health: run.health?.said ?? null }, ...history()])
  return run
}

async function overview() {
  if (!api.root) return { project: null }
  const cfg = readConfig()
  const targets = []
  for (const t of cfg.targets) {
    const names = secretsOf(t)
    const set = {}
    for (const n of names) set[n] = !!(await api.secrets.get(`${projectKey()}:${n}`))
    targets.push({ ...t, secrets: set, health: t.health, lastHealth: lastHealth.get(t.name) ?? null, last: history().find((h) => h.target === t.name) ?? null })
  }
  return { project: api.root, configFile: existsSync(here(CONFIG)) ? CONFIG : null, error: cfg.error ?? null, text: existsSync(here(CONFIG)) ? readFileSync(here(CONFIG), 'utf8') : '', targets, pending: publicPending(), run: publicRun(), history: history().slice(0, 25) }
}

function runSummary(r) {
  if (r.status === 'declined') return `The user said no (or did not answer), so ${r.target} was not ${r.manual ? 'rolled back' : 'deployed'}.`
  return `${r.target}: ${r.status}.${r.error ? ` ${r.error}` : ''}\n${r.steps.map((s) => `- ${s.name}: ${s.status}${s.note ? ` (${s.note})` : ''}`).join('\n')}${['failed', 'broken', 'rolled back'].includes(r.status) ? `\nLast lines:\n${(r.steps.find((s) => s.status === 'failed')?.log ?? []).slice(-15).join('\n')}` : ''}`
}

const EXAMPLE = {
  targets: [
    {
      name: 'My service',
      server: 'myserver',
      shared: false,
      backup: [{ name: 'Keep the running copy', run: 'ssh myserver "cp -a /opt/app /opt/app.prev"' }],
      steps: [
        { name: 'Copy the new version', run: 'scp -r dist/* myserver:/opt/app/' },
        { name: 'Restart it', run: 'ssh myserver "systemctl restart app"' }
      ],
      health: { url: 'https://example.com/healthz', expect: 200, tries: 5, waitMs: 3000 },
      rollback: [{ name: 'Put the old copy back', run: 'ssh myserver "rm -rf /opt/app && mv /opt/app.prev /opt/app && systemctl restart app"' }]
    }
  ]
}

export default {
  async start(a) {
    api = a
  },
  async stop() {
    stopping = true
    killChild()
    if (pending) answer(pending.id, false, 'the deploy panel stopped')
  },
  handlers: {
    overview,
    answer: (a) => answer(String(a.id), !!a.yes, a.yes ? '' : 'the user said no'),
    deploy: (a) => {
      deploy(String(a.target), 'you', a.confirmed === true).catch((e) => api.ui.toast('Deploy', String(e?.message ?? e)))
      return true
    },
    rollBack: (a) => {
      rollBack(String(a.target), 'you', a.confirmed === true).catch((e) => api.ui.toast('Deploy', String(e?.message ?? e)))
      return true
    },
    check: async (a) => {
      const t = target(a.target)
      const values = await secretValues(t)
      const h = await checkHealth({ ...t, health: t.health ? { ...t.health, tries: 1 } : null }, values, null)
      lastHealth.set(t.name, { ...h, at: Date.now() })
      return h
    },
    stop: () => {
      stopping = true
      killChild()
      return true
    },
    saveText: async (a) => {
      const text = String(a.text ?? '')
      JSON.parse(text)
      mkdirSync(here('.prism'), { recursive: true })
      writeFileSync(here(CONFIG), text.endsWith('\n') ? text : text + '\n')
      return overview()
    },
    example: () => JSON.stringify(EXAMPLE, null, 2),
    setSecret: async (a) => {
      await api.secrets.set(`${projectKey()}:${String(a.name)}`, a.value ? String(a.value) : null)
      return true
    },
    askAgent: async () => {
      await api.agent.send(
        `Set up deploying for this project: write ${CONFIG} with a target for each place it is deployed. Each target: { "name", "server" (the ssh name, for the question I am asked), "shared" (true if other things run on that server), "backup": [steps that keep the running copy], "steps": [steps that put the new version in place and restart it], "health": { "url" and/or "command", "expect": 200, "contains"?, "tries": 5, "waitMs": 3000 }, "rollback": [steps that put the kept copy back and restart it] }. A step is { "name", "run" } and runs from the project folder in cmd on Windows (use ssh/scp; keys are in the Windows ssh-agent). Never write a password or secret address into the file: write {secret:NAME} and tell me which secrets to set in the Deploy panel. Do not deploy anything.`
      )
      return true
    }
  },
  tools: [
    {
      name: 'deploy_status',
      description: "This project's deploy targets (from .prism/deploy.json): where each goes, its steps, its health check, the way back, and how the last deploys went.",
      parameters: { type: 'object', properties: {} },
      async execute() {
        const o = await overview()
        if (!o.project) return 'No project is open.'
        if (o.error) return o.error
        if (!o.targets.length) return `No deploy targets yet (${CONFIG} ${o.configFile ? 'has none' : 'does not exist'}). The Deploy panel can ask you to set them up.`
        return o.targets
          .map((t) => `${t.name}${t.server ? ` on ${t.server}` : ''}${t.shared ? ' (shared server)' : ''}\n  steps: ${[...t.backup, ...t.steps].map((s) => s.name).join(' → ') || 'none'}\n  health: ${t.health ? [t.health.url && 'address', t.health.command && 'command'].filter(Boolean).join(' and ') : 'none'}; way back: ${t.rollback.map((s) => s.name).join(' → ') || 'none'}\n  secrets: ${Object.entries(t.secrets).map(([k, v]) => `${k} ${v ? 'set' : 'NOT SET'}`).join(', ') || 'none'}\n  last: ${t.last ? `${t.last.status}, ${new Date(t.last.at).toLocaleString()}${t.last.commit ? ` at ${t.last.commit}` : ''}` : 'never deployed from here'}`)
          .join('\n')
      }
    },
    {
      name: 'deploy_run',
      description:
        'Deploy one target. This ALWAYS asks the user first, in the Deploy panel (and on their phone), and waits up to 15 minutes for their answer; nothing runs without a yes. Then: keep the running copy, deploy, check health, and if unhealthy put the previous version back by itself. Only deploy when the user has asked for it.',
      parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
      async execute(a) {
        const r = await deploy(String(a.target), 'Prism', false)
        return { content: runSummary(r), isError: !['deployed', 'declined'].includes(r.status) }
      }
    },
    {
      name: 'deploy_check',
      description: 'Check whether a deployed target is working, with its health check, now. Changes nothing.',
      parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
      async execute(a) {
        const t = target(a.target)
        const values = await secretValues(t)
        const h = await checkHealth({ ...t, health: t.health ? { ...t.health, tries: 1 } : null }, values, null)
        lastHealth.set(t.name, { ...h, at: Date.now() })
        api.emit('health', { target: t.name, ...h, at: Date.now() })
        return `${t.name}: ${h.ok ? 'working' : 'NOT working'}. ${h.said}`
      }
    },
    {
      name: 'deploy_put_back',
      description: "Put a target's previous version back with its way-back steps. Asks the user first, like deploy_run. Only when the user has asked.",
      parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
      async execute(a) {
        const r = await rollBack(String(a.target), 'Prism', false)
        return { content: runSummary(r), isError: !['rolled back', 'declined'].includes(r.status) }
      }
    }
  ]
}
