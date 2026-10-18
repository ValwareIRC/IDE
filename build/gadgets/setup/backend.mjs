// Reproducible setups: what a project needs to build and run (tools, versions,
// settings, folders), each with why, and how to get it. Recorded once, it can be
// checked on any machine, after any update, and turned into a setup script, so a new
// computer or a broken update is a list of fixes instead of an afternoon of guessing.
//
// Two lists. The project's lives in the project (.prism/setup.json) and travels with
// it. This computer's own pins (like the setting that keeps ollama on CUDA 12 for this
// graphics card) are kept with Prism, because they belong to the machine, not to any
// one project.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { dirname, join } from 'node:path'

const PROJECT = '.prism/setup.json'
let api = null
let lastCheck = null

const here = (p) => join(api.root, p)
const machineFile = () => join(api.dataDir, 'machine.json')

function cleanEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.PRISM_GADGET
  return env
}

function run(command, timeout = 20_000) {
  return new Promise((res) => {
    execFile(command, { shell: true, cwd: api.root || homedir(), timeout, windowsHide: true, env: cleanEnv(), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}`.trim() })
    })
  })
}

// ---------------------------------------------------------------- the lists

function readList(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    return { needs: Array.isArray(j.needs) ? j.needs : [], recordedOn: j.recordedOn ?? null }
  } catch {
    return { needs: [], recordedOn: null }
  }
}

function writeList(file, list) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(list, null, 2) + '\n')
}

const listFile = (scope) => (scope === 'machine' ? machineFile() : here(PROJECT))

function tidy(n) {
  const out = { name: String(n.name ?? '').trim() }
  for (const k of ['check', 'env', 'path', 'want', 'why', 'fix', 'fixWindows', 'fixLinux', 'fixMac']) if (n[k] != null && String(n[k]).trim()) out[k] = String(n[k]).trim()
  return out
}

function upsert(scope, needs) {
  const file = listFile(scope)
  const list = readList(file)
  for (const raw of needs) {
    const n = tidy(raw)
    if (!n.name || !(n.check || n.env || n.path)) continue
    const i = list.needs.findIndex((x) => x.name.toLowerCase() === n.name.toLowerCase())
    if (i >= 0) list.needs[i] = { ...list.needs[i], ...n }
    else list.needs.push(n)
  }
  list.recordedOn ??= null
  writeList(file, list)
  return list
}

function remove(scope, name) {
  const file = listFile(scope)
  const list = readList(file)
  list.needs = list.needs.filter((x) => x.name !== name)
  writeList(file, list)
  return list
}

// ---------------------------------------------------------------- checking

const VERSION = /(\d+)\.(\d+)(?:\.(\d+))?/

function parts(v) {
  const m = VERSION.exec(String(v))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** Whether what was found satisfies what is wanted: a version rule, a pattern, or words it must contain. */
function satisfies(found, want) {
  if (!want) return true
  const w = want.trim()
  if (w.startsWith('/') && w.lastIndexOf('/') > 0) {
    try {
      return new RegExp(w.slice(1, w.lastIndexOf('/')), w.slice(w.lastIndexOf('/') + 1)).test(found)
    } catch {
      return false
    }
  }
  const rule = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?)$/i.exec(w)
  if (!rule) return found.toLowerCase().includes(w.toLowerCase())
  const have = parts(found)
  if (!have) return false
  const [op, ver] = [rule[1] ?? '', rule[2]]
  const loose = /x|\*/i.test(ver) || ver.split('.').length < 3
  const want3 = parts(ver.replace(/[x*]/gi, '0') + (ver.split('.').length === 1 ? '.0' : '')) ?? [Number(ver), 0, 0]
  const c = cmp(have, want3)
  switch (op) {
    case '>=':
      return c >= 0
    case '>':
      return c > 0
    case '<=':
      return c <= 0
    case '<':
      return c < 0
    case '^':
      return have[0] === want3[0] && c >= 0
    case '~':
      return have[0] === want3[0] && have[1] === want3[1] && c >= 0
    default: {
      if (!loose) return c === 0
      const depth = ver.split('.').filter((p) => /^\d+$/.test(p)).length
      return have.slice(0, depth).every((x, i) => x === want3[i])
    }
  }
}

async function readEnv(name) {
  if (process.platform === 'win32') {
    for (const key of ['HKCU\\Environment', '"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"']) {
      const r = await run(`reg query ${key} /v ${name}`)
      const m = r.out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`, 'i'))
      if (m) return m[1].trim()
    }
    return null
  }
  return process.env[name] ?? null
}

async function checkOne(n) {
  let found = null
  let ok = false
  let said = ''
  try {
    if (n.env) {
      found = await readEnv(n.env)
      ok = found != null && satisfies(found, n.want ?? '')
      said = found == null ? `${n.env} is not set` : `${n.env} = ${found}`
    } else if (n.path) {
      const p = n.path.replace(/^~(?=[\\/])/, homedir())
      ok = existsSync(p)
      found = ok ? 'there' : null
      said = ok ? `${p} is there` : `${p} is missing`
    } else {
      const r = await run(n.check)
      const text = r.out.split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 200)
      if (r.code !== 0 && !text) {
        said = 'not found'
      } else if (r.code !== 0 && /not recognized|not found|no such file|cannot find/i.test(text)) {
        said = 'not installed'
      } else {
        found = text
        ok = satisfies(text, n.want ?? '')
        said = text
      }
    }
  } catch (e) {
    said = String(e?.message ?? e)
  }
  return { name: n.name, ok, found, said, want: n.want ?? '' }
}

function fixFor(n) {
  if (process.platform === 'win32') return n.fixWindows ?? n.fix ?? ''
  if (process.platform === 'darwin') return n.fixMac ?? n.fix ?? ''
  return n.fixLinux ?? n.fix ?? ''
}

async function checkAll() {
  const project = api.root ? readList(here(PROJECT)) : { needs: [] }
  const machine = readList(machineFile())
  const results = []
  for (const [scope, list] of [['project', project], ['machine', machine]]) {
    const done = await Promise.all(list.needs.map((n) => checkOne(n)))
    done.forEach((r, i) => results.push({ ...r, scope, fix: fixFor(list.needs[i]), why: list.needs[i].why ?? '' }))
  }
  lastCheck = { at: Date.now(), results }
  api.emit('check', lastCheck)
  return lastCheck
}

// ---------------------------------------------------------------- finding what a project needs

async function machineFacts() {
  // Windows 11 still calls itself 10.0; its build number tells them apart
  const build = Number(release().split('.')[2] ?? 0)
  const facts = { os: process.platform === 'win32' ? `Windows ${build >= 22000 ? '11' : '10'} (build ${build})` : `${process.platform === 'darwin' ? 'macOS' : 'Linux'} ${release()}` }
  const gpu = await run('nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader')
  if (gpu.code === 0 && gpu.out) {
    const [name, driver, mem] = gpu.out.split('\n')[0].split(',').map((x) => x.trim())
    facts.gpu = `${name}, driver ${driver}, ${mem}`
  }
  return facts
}

/** What the project's own files say it needs, measured against what this machine has now. */
async function detect() {
  const out = []
  const add = (n) => out.push(n)
  const read = (f) => {
    try {
      return readFileSync(here(f), 'utf8')
    } catch {
      return null
    }
  }
  const have = async (cmd) => {
    const r = await run(cmd)
    return r.code === 0 ? (VERSION.exec(r.out)?.[0] ?? r.out.split('\n')[0]) : null
  }
  const major = (v) => (v ? `${v.split('.')[0]}.x` : '')
  add({ name: 'git', check: 'git --version', want: '', why: 'The project is kept in git.', fix: 'winget install --id Git.Git -e', fixLinux: 'sudo apt install git', fixMac: 'xcode-select --install' })
  const pkgText = read('package.json')
  if (pkgText) {
    let pkg = {}
    try {
      pkg = JSON.parse(pkgText)
    } catch {
      /* broken */
    }
    const nodeWant = pkg.engines?.node ?? read('.nvmrc')?.trim() ?? read('.node-version')?.trim() ?? `>=${(await have('node --version'))?.split('.')[0] ?? '20'}`
    add({ name: 'Node.js', check: 'node --version', want: nodeWant.replace(/^v/, ''), why: 'Runs the build and the project\u2019s scripts.', fix: 'winget install --id OpenJS.NodeJS.LTS -e', fixLinux: 'Install from https://nodejs.org or with nvm', fixMac: 'brew install node' })
    const pm = String(pkg.packageManager ?? '')
    if (pm.startsWith('pnpm')) add({ name: 'pnpm (through corepack)', check: 'corepack pnpm --version', want: pm.split('@')[1]?.split('+')[0] ?? '', why: `package.json pins ${pm}; corepack fetches exactly that one.`, fix: 'corepack enable' })
    else if (pm.startsWith('yarn')) add({ name: 'yarn (through corepack)', check: 'corepack yarn --version', want: pm.split('@')[1] ?? '', why: `package.json pins ${pm}.`, fix: 'corepack enable' })
    if (pkg.devDependencies?.electron || pkg.dependencies?.electron) add({ name: 'Visual C++ redistributable', path: 'C:/Windows/System32/vcruntime140.dll', why: 'Electron and native modules need it on Windows.', fix: 'winget install --id Microsoft.VCRedist.2015+.x64 -e' })
  }
  const py = read('requirements.txt') ?? read('pyproject.toml')
  if (py != null) {
    const pv = await have('python --version')
    const req = read('pyproject.toml')?.match(/requires-python\s*=\s*"([^"]+)"/)?.[1]
    add({ name: 'Python', check: 'python --version', want: req ?? (pv ? major(pv) : ''), why: 'Runs the project\u2019s Python code.', fix: 'winget install --id Python.Python.3.12 -e', fixLinux: 'sudo apt install python3 python3-venv', fixMac: 'brew install python' })
    if (/torch|cuda|onnxruntime-gpu|tensorflow/i.test(py)) {
      const smi = await run('nvidia-smi --query-gpu=driver_version --format=csv,noheader')
      add({ name: 'NVIDIA driver', check: 'nvidia-smi --query-gpu=driver_version --format=csv,noheader', want: smi.code === 0 ? `>=${smi.out.split('\n')[0].trim()}` : '', why: 'The project uses the graphics card (torch or CUDA).', fix: 'Install the latest Game Ready or Studio driver from nvidia.com' })
    }
  }
  if (read('Cargo.toml') != null) {
    const want = read('Cargo.toml').match(/rust-version\s*=\s*"([^"]+)"/)?.[1]
    add({ name: 'Rust', check: 'rustc --version', want: want ? `>=${want}` : '', why: 'Builds the project.', fix: 'winget install --id Rustlang.Rustup -e', fixLinux: 'curl https://sh.rustup.rs -sSf | sh' })
  }
  const goMod = read('go.mod')
  if (goMod != null) add({ name: 'Go', check: 'go version', want: `>=${goMod.match(/^go\s+([\d.]+)/m)?.[1] ?? '1.21'}`, why: 'Builds the project.', fix: 'winget install --id GoLang.Go -e' })
  if (existsSync(here('android')) || existsSync(here('app/build.gradle'))) {
    const javaHome = await readEnv('JAVA_HOME')
    add({ name: 'Java (JDK)', check: javaHome ? `"${javaHome}\\bin\\java" -version` : 'java -version', want: '', why: 'Gradle needs it to build the Android app.', fix: 'winget install --id Microsoft.OpenJDK.21 -e' })
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : '')
    if (sdk) add({ name: 'Android SDK', path: sdk.replace(/\\/g, '/'), why: 'Builds and installs the Android app (adb lives in its platform-tools).', fix: 'Install Android Studio, or the command-line tools from developer.android.com' })
  }
  const uproject = (() => {
    try {
      return readdirSync(api.root).find((f) => f.endsWith('.uproject'))
    } catch {
      return null
    }
  })()
  if (uproject) {
    const assoc = JSON.parse(read(uproject) ?? '{}').EngineAssociation
    if (assoc) add({ name: `Unreal Engine ${assoc}`, path: `C:/Program Files/Epic Games/UE_${assoc}`, why: `${uproject} is made for this engine version.`, fix: 'Install it from the Epic Games Launcher' })
  }
  if (existsSync(here('Dockerfile')) || existsSync(here('docker-compose.yml')) || existsSync(here('compose.yaml'))) add({ name: 'Docker', check: 'docker --version', want: '', why: 'The project runs in containers.', fix: 'winget install --id Docker.DockerDesktop -e' })
  // anything already recorded is not suggested again
  const known = new Set(readList(here(PROJECT)).needs.map((n) => n.name.toLowerCase()))
  const fresh = out.filter((n) => !known.has(n.name.toLowerCase()))
  // what this machine has now, so the suggestion can say so
  const results = await Promise.all(fresh.map((n) => checkOne(n)))
  return fresh.map((n, i) => ({ ...n, now: results[i].said, ok: results[i].ok }))
}

// ---------------------------------------------------------------- writing it down

function setupScript() {
  const lists = [['This project', readList(here(PROJECT)).needs], ['This computer', readList(machineFile()).needs]]
  const lines = ['# Gets this computer ready for the project. Written by Prism\'s Setup panel.', '# Each step checks first and does nothing if it is already in place.', '$ErrorActionPreference = "Continue"', '']
  for (const [title, needs] of lists) {
    if (!needs.length) continue
    lines.push(`# ---------------------------------------------------------------- ${title.toLowerCase()}`)
    for (const n of needs) {
      const fix = n.fixWindows ?? n.fix
      lines.push(`# ${n.name}${n.why ? `: ${n.why}` : ''}`)
      if (!fix) {
        lines.push(`Write-Host "${n.name}: check by hand${n.want ? ` (needs ${n.want})` : ''}"`, '')
        continue
      }
      const test = n.env ? `[Environment]::GetEnvironmentVariable('${n.env}', 'User')${n.want ? ` -eq '${n.want}'` : ''}` : n.path ? `Test-Path '${n.path}'` : `(cmd /c "${n.check.replace(/"/g, '\\"')} 2>nul") -ne $null`
      lines.push(`if (-not (${test})) {`, `  Write-Host "Setting up ${n.name}…"`, `  ${/^\w+:\/\//.test(fix) || /^(Install|Download|Get) /.test(fix) ? `Write-Host "${fix.replace(/"/g, "'")}"` : fix}`, '}', '')
    }
  }
  return lines.join('\r\n')
}

function setupDoc(facts) {
  const lists = [['This project needs', readList(here(PROJECT))], ['This computer needs', readList(machineFile())]]
  const out = ['# Setting up', '', 'What this project needs to build and run, and why. Kept by Prism\'s Setup panel; `setup.ps1` does the same steps on Windows.', '']
  for (const [title, list] of lists) {
    if (!list.needs.length) continue
    out.push(`## ${title}`, '')
    for (const n of list.needs) {
      out.push(`- **${n.name}**${n.want ? ` (${n.want})` : ''}${n.why ? `: ${n.why}` : ''}${(n.fixWindows ?? n.fix) ? `\n  Get it: \`${n.fixWindows ?? n.fix}\`` : ''}`)
    }
    out.push('')
  }
  const rec = readList(here(PROJECT)).recordedOn ?? facts
  if (rec) out.push('## Known to work on', '', `${rec.os ?? ''}${rec.gpu ? `, ${rec.gpu}` : ''}${rec.at ? ` (${rec.at.slice(0, 10)})` : ''}`, '')
  return out.join('\n')
}

async function writeFiles() {
  const facts = await machineFacts()
  const list = readList(here(PROJECT))
  list.recordedOn = { ...facts, at: new Date().toISOString() }
  writeList(here(PROJECT), list)
  writeFileSync(here('setup.ps1'), setupScript())
  writeFileSync(here('SETUP.md'), setupDoc(list.recordedOn))
  return { files: [here('SETUP.md'), here('setup.ps1')] }
}

async function overview() {
  return { project: api.root || null, projectNeeds: api.root ? readList(here(PROJECT)) : { needs: [] }, machineNeeds: readList(machineFile()), lastCheck, facts: await machineFacts() }
}

function report(c) {
  const bad = c.results.filter((r) => !r.ok)
  const lines = c.results.map((r) => `- ${r.ok ? 'ok' : 'NOT OK'} ${r.name} (${r.scope === 'machine' ? 'this computer' : 'project'})${r.want ? `, needs ${r.want}` : ''}: ${r.said}${!r.ok && r.fix ? `. Fix: ${r.fix}` : ''}`)
  return `${c.results.length ? `${c.results.length - bad.length} of ${c.results.length} in place.` : 'Nothing is recorded yet: use setup_record.'}\n${lines.join('\n')}`
}

export default {
  async start(a) {
    api = a
  },
  handlers: {
    overview,
    check: () => checkAll(),
    checkOne: async (a) => checkOne(a.need ?? {}),
    detect: () => detect(),
    add: (a) => upsert(a.scope === 'machine' ? 'machine' : 'project', a.needs ?? [a.need]),
    remove: (a) => remove(a.scope === 'machine' ? 'machine' : 'project', String(a.name)),
    fix: async (a) => {
      const r = await run(String(a.command), 600_000)
      return { code: r.code, out: r.out.slice(-3000) }
    },
    write: () => writeFiles(),
    openFile: async (a) => {
      await api.ui.openFile(String(a.path))
      return true
    },
    askAgent: async (a) => {
      await api.agent.send(String(a.text))
      return true
    }
  },
  tools: [
    {
      name: 'setup_check',
      description: "Check this computer against what the project needs (.prism/setup.json) and the computer's own pins: each tool, version, setting and folder, in place or not, with the fix for each one that is not.",
      parameters: { type: 'object', properties: {} },
      async execute() {
        return report(await checkAll())
      }
    },
    {
      name: 'setup_record',
      description:
        "Record what the project (or this computer) needs, with why: a tool and the version it must be (check: a command that prints it, want: '>=22', '^5.4', '21.x', words it must say, or /pattern/), a setting (env: its name, want: its value), or a folder (path). Give fix: the command that gets it. Record the reason in why, especially for pins learned the hard way (like a driver or library version that crashes).",
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['project', 'machine'], description: 'project (default) or machine: something about this computer, not one project' },
          needs: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, check: { type: 'string' }, env: { type: 'string' }, path: { type: 'string' }, want: { type: 'string' }, why: { type: 'string' }, fix: { type: 'string' } }, required: ['name'] }
          }
        },
        required: ['needs']
      },
      async execute(a) {
        const list = upsert(a.scope === 'machine' ? 'machine' : 'project', a.needs ?? [])
        api.emit('changed', null)
        return `Recorded. ${a.scope === 'machine' ? 'This computer' : 'The project'} now has ${list.needs.length} need(s): ${list.needs.map((n) => n.name).join(', ')}.`
      }
    },
    {
      name: 'setup_detect',
      description: "Find what the project's own files say it needs (package.json, requirements, Cargo, go.mod, Android, Unreal, Docker…), with what this computer has now. Record the ones that matter with setup_record.",
      parameters: { type: 'object', properties: {} },
      async execute() {
        const found = await detect()
        return found.length ? found.map((n) => `- ${n.name}${n.want ? ` (${n.want})` : ''}: now ${n.now}${n.why ? `. ${n.why}` : ''}`).join('\n') : 'Nothing new to suggest.'
      }
    }
  ]
}
