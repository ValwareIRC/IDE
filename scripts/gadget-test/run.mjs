// Runs one handler or tool of a gadget's backend outside Prism, with a stand-in for
// the api Prism gives it, so a gadget's insides can be tried without launching a
// second Prism (which would replace the one in use).
//
//   node scripts/gadget-test/run.mjs build/gadgets/release status
//   node scripts/gadget-test/run.mjs build/gadgets/release tool:release_status --root <project folder>
//   node scripts/gadget-test/run.mjs build/gadgets/release plan '{"bump":"patch"}'
//
// What the gadget emits and logs is printed as it happens; the result is printed last.
import { exec, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  if (i < 0) return null
  const v = argv[i + 1]
  argv.splice(i, 2)
  return v
}
const root = resolve(flag('--root') ?? process.cwd())
const quiet = argv.includes('--quiet') ? (argv.splice(argv.indexOf('--quiet'), 1), true) : false
const [dirArg, what, json] = argv
if (!dirArg || !what) {
  console.error('usage: run.mjs <gadget-folder> <handler | tool:name> [json-args] [--root <project>]')
  process.exit(2)
}
const dir = resolve(dirArg)
const manifest = JSON.parse(readFileSync(join(dir, 'gadget.json'), 'utf8'))
const dataDir = join(tmpdir(), 'prism-gadget-test', manifest.id)
mkdirSync(dataDir, { recursive: true })
const stateFile = join(dataDir, '..', `${manifest.id}.state.json`)
const secrets = new Map()

const readState = () => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return {}
  }
}
const children = new Set()
const api = {
  dir,
  root,
  dataDir,
  emit: (event, data) => quiet || console.log(`[emit ${event}]`, JSON.stringify(data)?.slice(0, 400)),
  log: (...p) => console.log('[log]', ...p),
  agent: { send: async (text) => console.log('[agent.send]', text) },
  ui: {
    toast: async (t, d) => console.log('[toast]', t, d ?? ''),
    openFile: async (p) => console.log('[openFile]', p),
    openPreview: async (p) => console.log('[openPreview]', p),
    show: async () => console.log('[show]'),
    attach: async (p, n) => console.log('[attach]', p, n ?? ''),
    notify: async (t, b) => console.log('[notify]', t, b ?? '')
  },
  capture: async () => {
    throw new Error('pictures of pages need Prism itself')
  },
  secrets: { get: async (k) => secrets.get(k) ?? null, set: async (k, v) => (v == null ? secrets.delete(k) : secrets.set(k, v)) },
  workspace: {
    read: async (p) => readFileSync(join(root, p), 'utf8'),
    write: async (p, c) => {
      mkdirSync(join(root, p, '..'), { recursive: true })
      writeFileSync(join(root, p), c)
    },
    list: async (p) => readdirSync(join(root, p ?? '.')).map((name) => ({ name, type: statSync(join(root, p ?? '.', name)).isDirectory() ? 'dir' : 'file' }))
  },
  state: {
    get: async (k, f) => (k in readState() ? readState()[k] : f),
    set: async (k, v) => writeFileSync(stateFile, JSON.stringify({ ...readState(), [k]: v }, null, 2))
  },
  shell: (command, opts = {}) =>
    new Promise((res) =>
      exec(command, { cwd: opts.cwd || root, timeout: opts.timeoutMs || 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: opts.shell }, (err, stdout, stderr) =>
        res({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })
      )
    ),
  spawn(command, args = [], opts = {}) {
    const child = spawn(command, args, { cwd: opts.cwd || root, windowsHide: true, env: { ...process.env, ...(opts.env || {}) }, shell: opts.shell })
    children.add(child)
    child.stdout?.on('data', (d) => opts.onData?.(String(d), 'stdout'))
    child.stderr?.on('data', (d) => opts.onData?.(String(d), 'stderr'))
    child.on('close', (code) => {
      children.delete(child)
      opts.onExit?.(code)
    })
    child.on('error', (e) => opts.onData?.(`[spawn error] ${e.message}\n`, 'stderr'))
    return {
      pid: child.pid,
      write: (d) => child.stdin?.write(d),
      kill: () => (process.platform === 'win32' ? spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) : child.kill()),
      exited: new Promise((r) => child.on('close', r))
    }
  },
  serve: () => Promise.reject(new Error('not in the test bench'))
}

const mod = (await import(pathToFileURL(join(dir, manifest.backend ?? 'backend.mjs')).href)).default
await mod.start?.(api)
// @path reads the arguments from a file, which keeps backslashes away from the shell
const args = json ? JSON.parse(json.startsWith('@') ? readFileSync(json.slice(1), 'utf8') : json) : {}
let result
try {
  if (what.startsWith('tool:')) {
    const tool = mod.tools.find((t) => t.name === what.slice(5))
    if (!tool) throw new Error(`no tool ${what.slice(5)}; tools: ${mod.tools.map((t) => t.name).join(', ')}`)
    result = await tool.execute(args, api)
  } else {
    const fn = mod.handlers[what]
    if (!fn) throw new Error(`no handler ${what}; handlers: ${Object.keys(mod.handlers).join(', ')}`)
    result = await fn(args, api)
  }
  if (result && typeof result === 'object' && Array.isArray(result.images)) result = { ...result, images: result.images.map((i) => `${i.mime}, ${i.base64.length} chars`) }
  console.log('\n=== result ===')
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
} catch (e) {
  console.log('\n=== failed ===')
  console.log(e?.stack ?? e)
  process.exitCode = 1
} finally {
  await mod.stop?.(api)
  for (const c of children) c.kill()
}
