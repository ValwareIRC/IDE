// The release desk: the steps of putting out a new version, in order, on one screen.
// What is new since the last release, the new number, the builds, handing the result
// over, bringing the work into the main copy, installing, and going back to an
// earlier version if the new one is wrong.
//
// How a project releases is kept in the project, in .prism/release.json, so it can be
// read, changed by hand or by the agent, and shared. Without one, the desk guesses
// from the project and says what it guessed. The record of earlier releases is kept
// with Prism (not in the project), one per project.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const CONFIG = '.prism/release.json'
const LOG_LINES = 600

let api = null
/** The release under way, or the last one: what the panel shows. */
let run = null
/** The command running now, so Stop can end it. */
let child = null
let stopping = false
let emitTimer = null

// ---------------------------------------------------------------- small things

const root = () => api.root
const here = (p) => (isAbsolute(p) ? p : join(root(), p))
const read = (p) => {
  try {
    return readFileSync(here(p), 'utf8')
  } catch {
    return null
  }
}
const projectKey = () => createHash('sha1').update(root().toLowerCase()).digest('hex').slice(0, 12)
const historyFile = () => join(api.dataDir, projectKey(), 'history.json')

function history() {
  try {
    return JSON.parse(readFileSync(historyFile(), 'utf8'))
  } catch {
    return []
  }
}

function saveHistory(list) {
  mkdirSync(dirname(historyFile()), { recursive: true })
  writeFileSync(historyFile(), JSON.stringify(list.slice(0, 60), null, 2))
}

/** {version}, {root}, {temp} and {date} in a command or a path. */
function fill(text, version) {
  return String(text)
    .replaceAll('{version}', version ?? '')
    .replaceAll('{root}', root())
    .replaceAll('{temp}', tmpdir())
    .replaceAll('{date}', new Date().toISOString().slice(0, 10))
}

function cleanEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.PRISM_GADGET
  return env
}

/** A command to completion, quietly. */
function quiet(command, cwd = root()) {
  return new Promise((res) => {
    const c = spawn(command, { cwd, shell: true, windowsHide: true, env: cleanEnv() })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (out += d))
    c.on('close', (code) => res({ code: code ?? 1, out }))
    c.on('error', (e) => res({ code: 1, out: e.message }))
  })
}

const git = (args) => quiet(`git ${args}`)

// ---------------------------------------------------------------- versions

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/

/** Where a project keeps its version number, and how to read and change it there. */
const SOURCES = [
  {
    file: 'package.json',
    read: (t) => JSON.parse(t).version,
    write: (t, v) => t.replace(/("version"\s*:\s*")[^"]*(")/, `$1${v}$2`)
  },
  {
    file: 'Cargo.toml',
    read: (t) => t.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1],
    write: (t, v) => t.replace(/(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/, `$1${v}$2`)
  },
  {
    file: 'pyproject.toml',
    read: (t) => t.match(/\[(?:project|tool\.poetry)\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1],
    write: (t, v) => t.replace(/(\[(?:project|tool\.poetry)\][\s\S]*?\nversion\s*=\s*")[^"]+(")/, `$1${v}$2`)
  },
  { file: 'VERSION', read: (t) => t.trim(), write: (_t, v) => v + '\n' },
  { file: 'version.txt', read: (t) => t.trim(), write: (_t, v) => v + '\n' },
  {
    file: 'android/app/build.gradle',
    read: (t) => t.match(/versionName\s+"([^"]+)"/)?.[1],
    // an Android app also needs a bigger whole number every time
    write: (t, v) => t.replace(/versionName\s+"[^"]+"/, `versionName "${v}"`).replace(/versionCode\s+(\d+)/, (_m, n) => `versionCode ${Number(n) + 1}`)
  },
  {
    file: 'app/build.gradle.kts',
    read: (t) => t.match(/versionName\s*=\s*"([^"]+)"/)?.[1],
    write: (t, v) => t.replace(/versionName\s*=\s*"[^"]+"/, `versionName = "${v}"`).replace(/versionCode\s*=\s*(\d+)/, (_m, n) => `versionCode = ${Number(n) + 1}`)
  }
]

function sourceFor(file) {
  return SOURCES.find((s) => s.file === file.replace(/\\/g, '/')) ?? { file, read: (t) => t.match(/\d+\.\d+\.\d+/)?.[0], write: (t, v) => t.replace(/\d+\.\d+\.\d+/, v) }
}

function currentVersion(cfg) {
  for (const f of cfg.versionFiles) {
    const t = read(f)
    if (t == null) continue
    try {
      const v = sourceFor(f).read(t)
      if (v) return v
    } catch {
      /* not readable as that kind of file */
    }
  }
  return null
}

function nextVersion(current, bump) {
  if (!bump || bump === 'none') return current
  if (SEMVER.test(bump)) return bump
  const m = SEMVER.exec(current ?? '0.0.0')
  if (!m) throw new Error(`"${current}" is not a version number I can count up from. Give the new one instead.`)
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (bump === 'major') return `${maj + 1}.0.0`
  if (bump === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

function compare(a, b) {
  const x = SEMVER.exec(a)
  const y = SEMVER.exec(b)
  if (!x || !y) return String(a).localeCompare(String(b))
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i])
  return 0
}

// ---------------------------------------------------------------- the project's way of releasing

/** What the desk would do in a project that has not said: its best guess, and why. */
function guess() {
  const versionFiles = SOURCES.map((s) => s.file).filter((f) => existsSync(here(f))).slice(0, 1)
  const steps = []
  const notes = []
  const pkgText = read('package.json')
  if (pkgText) {
    let pkg = {}
    try {
      pkg = JSON.parse(pkgText)
    } catch {
      /* broken package.json */
    }
    const scripts = pkg.scripts ?? {}
    const pm = String(pkg.packageManager ?? '').startsWith('pnpm') || existsSync(here('pnpm-lock.yaml')) ? 'corepack pnpm' : existsSync(here('yarn.lock')) ? 'yarn' : 'npm run'
    const pick = ['dist', 'package', 'make', 'release:build', 'build'].find((s) => scripts[s])
    if (pick) {
      steps.push({ name: pick === 'build' ? 'Build' : 'Build the installer', run: `${pm} ${pick}` })
      notes.push(`builds with the "${pick}" script in package.json`)
    }
  } else if (existsSync(here('Cargo.toml'))) {
    steps.push({ name: 'Build', run: 'cargo build --release' })
  } else if (existsSync(here('pyproject.toml'))) {
    steps.push({ name: 'Build', run: 'python -m build' })
  } else if (existsSync(here('gradlew.bat')) || existsSync(here('android/gradlew.bat'))) {
    steps.push({ name: 'Build the app', run: existsSync(here('gradlew.bat')) ? 'gradlew.bat assembleRelease' : 'cd android && gradlew.bat assembleRelease' })
  }
  if (!versionFiles.length) notes.push('found no version number in the usual places')
  return { name: basename(root()), versionFiles, commit: true, tag: false, changelog: existsSync(here('CHANGELOG.md')), steps, artifacts: [], deliver: [], install: null, extras: [], guessed: true, notes }
}

function config() {
  const text = read(CONFIG)
  if (text == null) return guess()
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`${CONFIG} is not valid JSON: ${e.message}`)
  }
  const steps = (list) => (Array.isArray(list) ? list.filter((s) => s && typeof s.run === 'string').map((s, i) => ({ name: String(s.name ?? `Step ${i + 1}`), run: s.run, cwd: s.cwd })) : [])
  return {
    name: String(raw.name ?? basename(root())),
    versionFiles: Array.isArray(raw.versionFiles) ? raw.versionFiles.map(String) : guess().versionFiles,
    commit: raw.commit !== false,
    tag: raw.tag === true,
    changelog: raw.changelog === true,
    steps: steps(raw.steps),
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.map(String) : [],
    deliver: steps(raw.deliver),
    install: raw.install && typeof raw.install.run === 'string' ? { run: raw.install.run, log: raw.install.log ? String(raw.install.log) : null, note: raw.install.note ? String(raw.install.note) : '' } : null,
    rollback: raw.rollback && typeof raw.rollback.run === 'string' ? { run: raw.rollback.run } : null,
    extras: Array.isArray(raw.extras) ? raw.extras.filter((x) => x && typeof x.run === 'string').map((x) => ({ name: String(x.name ?? 'Extra'), run: x.run, artifacts: Array.isArray(x.artifacts) ? x.artifacts.map(String) : [], note: x.note ? String(x.note) : '' })) : [],
    guessed: false,
    notes: []
  }
}

// ---------------------------------------------------------------- what is new

/** Commits since the last release: the last commit named after a version, or the last version tag. */
async function changes(current) {
  const r = await git('log -n 400 --format=%H%x09%ct%x09%s')
  if (r.code !== 0) return { since: null, list: [], git: false }
  const rows = r.out.trim().split('\n').filter(Boolean).map((l) => {
    const [hash, ct, ...s] = l.split('\t')
    return { hash, at: Number(ct) * 1000, subject: s.join('\t') }
  })
  const isRelease = (s) => /^(v|version |release )?\d+\.\d+\.\d+([-+][\w.]+)?$/i.test(s.trim())
  let cut = rows.findIndex((c) => isRelease(c.subject))
  // a tag can mark a release too
  if (cut < 0 && current) {
    const t = await git(`rev-list -n 1 v${current}`)
    const t2 = t.code === 0 ? t : await git(`rev-list -n 1 ${current}`)
    if (t2.code === 0) cut = rows.findIndex((c) => c.hash === t2.out.trim())
  }
  const list = (cut < 0 ? rows.slice(0, 30) : rows.slice(0, cut)).filter((c) => !/^Merge (branch|pull request)/.test(c.subject))
  return { since: cut >= 0 ? rows[cut].subject.replace(/^(v|version |release )/i, '') : null, sinceAt: cut >= 0 ? rows[cut].at : null, list, git: true }
}

// ---------------------------------------------------------------- what came out of a build

function expand(pattern, version) {
  const p = here(fill(pattern, version))
  if (!/[*?]/.test(basename(p))) return existsSync(p) ? [p] : []
  const dir = dirname(p)
  const re = new RegExp('^' + basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
  try {
    return readdirSync(dir).filter((n) => re.test(n)).map((n) => join(dir, n))
  } catch {
    return []
  }
}

function describeFile(p) {
  try {
    const s = statSync(p)
    return { path: p, name: basename(p), size: s.size, at: s.mtimeMs }
  } catch {
    return null
  }
}

const OUTPUT_DIRS = ['dist', 'out', 'release', 'build', 'target/release', 'android/app/build/outputs/apk', 'app/build/outputs/apk']
const OUTPUT_EXT = /\.(exe|msi|msix|appx|apk|aab|dmg|pkg|appimage|deb|rpm|zip|tar\.gz|tgz|vsix|whl|crate|nupkg)$/i

/** No artifacts listed: whatever installable files appeared in the usual places during the run. */
function freshFiles(since) {
  const out = []
  const walk = (dir, depth) => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        if (depth < 3 && !/node_modules|unpacked|\.cache/i.test(n)) walk(p, depth + 1)
      } else if (OUTPUT_EXT.test(n) && s.mtimeMs >= since - 2000) out.push({ path: p, name: n, size: s.size, at: s.mtimeMs })
    }
  }
  for (const d of OUTPUT_DIRS) walk(here(d), 0)
  return out.sort((a, b) => b.at - a.at).slice(0, 12)
}

function artifactsFor(cfg, version, since) {
  if (!cfg.artifacts.length) return since ? freshFiles(since) : []
  return cfg.artifacts.flatMap((a) => expand(a, version)).map(describeFile).filter(Boolean)
}

/** Every version that still has its build on disk, newest first: the ones that can be put back. */
function onDisk(cfg) {
  const found = new Map()
  for (const a of cfg.artifacts) {
    if (!a.includes('{version}')) continue
    const p = here(fill(a.replaceAll('{version}', '\u0000'), ''))
    const dir = dirname(p)
    const [pre, post] = basename(p).split('\u0000')
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.toLowerCase().startsWith(pre.toLowerCase()) || !n.toLowerCase().endsWith((post ?? '').toLowerCase())) continue
      const v = n.slice(pre.length, n.length - (post ?? '').length)
      if (!SEMVER.test(v)) continue
      const f = describeFile(join(dir, n))
      if (f) found.set(v, [...(found.get(v) ?? []), f])
    }
  }
  return [...found.entries()].sort((a, b) => compare(b[0], a[0])).map(([version, files]) => ({ version, files }))
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
  return { ...run, steps: run.steps.map((s) => ({ ...s, log: s.log.slice(-200) })) }
}

function addLog(step, text) {
  for (const line of String(text).replace(/\r(?!\n)/g, '\n').split(/\r?\n/)) {
    if (!line.trim()) continue
    step.log.push(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))
  }
  if (step.log.length > LOG_LINES) step.log.splice(0, step.log.length - LOG_LINES)
  emitSoon()
}

function exec(step, command, cwd) {
  return new Promise((res) => {
    addLog(step, `> ${command}`)
    const c = spawn(command, { cwd: cwd ? here(cwd) : root(), shell: true, windowsHide: true, env: cleanEnv() })
    child = c
    c.stdout.on('data', (d) => addLog(step, d))
    c.stderr.on('data', (d) => addLog(step, d))
    c.on('error', (e) => addLog(step, e.message))
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

const STAGES = ['bump', 'build', 'handover', 'deliver', 'install']

/** The steps a release will go through, from the bump up to `through`. */
function plan(cfg, opts) {
  const through = STAGES.indexOf(opts.through ?? 'handover')
  const steps = []
  if (opts.bump !== 'none') steps.push({ id: 'bump', stage: 'bump', name: 'New version number' })
  cfg.steps.forEach((s, i) => steps.push({ id: `build-${i}`, stage: 'build', name: s.name, run: s.run, cwd: s.cwd }))
  if (through >= 2) steps.push({ id: 'handover', stage: 'handover', name: 'Find what was built' })
  if (through >= 3) cfg.deliver.forEach((s, i) => steps.push({ id: `deliver-${i}`, stage: 'deliver', name: s.name, run: s.run, cwd: s.cwd }))
  if (through >= 4 && cfg.install) steps.push({ id: 'install', stage: 'install', name: 'Install it', run: cfg.install.run })
  return steps.filter((s) => STAGES.indexOf(s.stage) <= through)
}

async function bump(step, cfg, version, notes) {
  if (!cfg.versionFiles.length) throw new Error('There is nowhere to write the version number. Say which file holds it in the release settings.')
  const touched = []
  for (const f of cfg.versionFiles) {
    const t = read(f)
    if (t == null) {
      addLog(step, `${f} is not there; left alone`)
      continue
    }
    const next = sourceFor(f).write(t, version)
    if (next !== t) {
      writeFileSync(here(f), next)
      touched.push(f)
      addLog(step, `${f}: ${version}`)
    }
  }
  if (cfg.changelog && notes.trim()) {
    const file = here('CHANGELOG.md')
    const old = existsSync(file) ? readFileSync(file, 'utf8') : '# Changelog\n'
    const entry = `## ${version} (${new Date().toISOString().slice(0, 10)})\n\n${notes
      .trim()
      .split('\n')
      .map((l) => (l.trim() ? (/^[-*] /.test(l.trim()) ? l.trim() : `- ${l.trim()}`) : ''))
      .filter(Boolean)
      .join('\n')}\n`
    const at = old.search(/^## /m)
    writeFileSync(file, at < 0 ? `${old.trimEnd()}\n\n${entry}` : `${old.slice(0, at)}${entry}\n${old.slice(at)}`)
    touched.push('CHANGELOG.md')
    addLog(step, 'CHANGELOG.md: notes added')
  }
  if (cfg.commit && touched.length) {
    // only the files changed here, whatever else is waiting to be committed
    const c = await exec(step, `git commit -m "${version}" -- ${touched.map((f) => `"${f}"`).join(' ')}`)
    if (c !== 0) {
      const added = await exec(step, `git add -- ${touched.map((f) => `"${f}"`).join(' ')} && git commit -m "${version}" -- ${touched.map((f) => `"${f}"`).join(' ')}`)
      if (added !== 0) throw new Error('The version was written, but committing it failed. See the log.')
    }
  }
  if (cfg.tag) {
    if ((await exec(step, `git tag v${version}`)) !== 0) throw new Error(`Tagging v${version} failed. See the log.`)
  }
}

/** Waits for an installer's log to say how it went (an install that restarts Prism ends this process first). */
async function watchInstall(step, logPath) {
  const deadline = Date.now() + 8 * 60_000
  let seen = 0
  while (Date.now() < deadline && !stopping) {
    await new Promise((r) => setTimeout(r, 2000))
    let text = ''
    try {
      text = readFileSync(logPath, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/).filter(Boolean)
    for (const l of lines.slice(seen)) addLog(step, l)
    seen = lines.length
    const verdict = installVerdict(text)
    if (verdict) return verdict
  }
  return stopping ? 'stopped' : 'unknown'
}

/** How an install's log says it went: failed, done, or nothing yet. */
function installVerdict(text) {
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (lines.some((l) => /\bFAILED\b/.test(l))) return 'failed'
  if (/\bis up\b|\binstall(ed|ation)? (ok|complete|completed|succeeded|finished)\b|\bsucce(ss|eded)\b|\bdone\b/i.test(lines.slice(-2).join('\n'))) return 'done'
  return null
}

async function release(opts) {
  if (run?.status === 'running') throw new Error('A release is already under way.')
  const cfg = config()
  const current = currentVersion(cfg)
  const version = opts.bump === 'none' ? current : nextVersion(current, opts.bump ?? 'patch')
  if (!version) throw new Error('No version number was found, and none was given.')
  const what = await changes(current)
  const notes = typeof opts.notes === 'string' ? opts.notes : what.list.map((c) => c.subject).join('\n')
  const steps = plan(cfg, opts).map((s) => ({ ...s, status: 'waiting', startedAt: null, endedAt: null, log: [], note: '' }))
  run = { id: Date.now().toString(36), version, from: current, through: opts.through ?? 'handover', status: 'running', startedAt: Date.now(), endedAt: null, steps, artifacts: [], error: null, by: opts.by ?? 'you' }
  stopping = false
  emitSoon()
  const record = { version, from: current, at: run.startedAt, notes, outcome: 'running', steps: [], artifacts: [], install: null, by: run.by }
  const list = history()
  list.unshift(record)
  saveHistory(list)
  const save = () => {
    const all = history()
    const i = all.findIndex((r) => r.at === record.at)
    record.steps = run.steps.map((s) => ({ name: s.name, status: s.status, ms: s.endedAt && s.startedAt ? s.endedAt - s.startedAt : null }))
    record.artifacts = run.artifacts.map((a) => ({ path: a.path, name: a.name, size: a.size }))
    if (i >= 0) all[i] = record
    else all.unshift(record)
    saveHistory(all)
  }
  for (const step of run.steps) {
    if (stopping) {
      step.status = 'skipped'
      continue
    }
    step.status = 'running'
    step.startedAt = Date.now()
    emitSoon()
    try {
      if (step.stage === 'bump') await bump(step, cfg, version, notes)
      else if (step.stage === 'handover') {
        run.artifacts = artifactsFor(cfg, version, run.startedAt)
        if (!run.artifacts.length) throw new Error(cfg.artifacts.length ? `Nothing was found at ${cfg.artifacts.map((a) => fill(a, version)).join(', ')}.` : 'No new installable files were found in the usual folders. Say where the build puts them in the release settings.')
        for (const a of run.artifacts) addLog(step, `${a.name}  ${(a.size / 1048576).toFixed(1)} MB  ${a.path}`)
      } else if (step.stage === 'install') {
        const code = await exec(step, fill(step.run, version))
        if (code !== 0) throw new Error(`Installing stopped with code ${code}.`)
        if (cfg.install.log) {
          const logPath = here(fill(cfg.install.log, version))
          record.install = { at: Date.now(), log: logPath, outcome: 'running' }
          save()
          if (cfg.install.note) addLog(step, cfg.install.note)
          const verdict = await watchInstall(step, logPath)
          record.install.outcome = verdict
          if (verdict === 'failed') throw new Error('The install reported a failure. See the log.')
          if (verdict === 'unknown') step.note = 'The install has not said how it went yet.'
        }
      } else {
        const code = await exec(step, fill(step.run, version), step.cwd)
        if (code !== 0) throw new Error(stopping ? 'Stopped.' : `Stopped with code ${code}.`)
      }
      step.status = 'done'
    } catch (e) {
      step.status = stopping ? 'skipped' : 'failed'
      step.note = String(e?.message ?? e)
      addLog(step, step.note)
      run.error = `${step.name}: ${step.note}`
      stopping = true
    }
    step.endedAt = Date.now()
    save()
    emitSoon()
  }
  run.status = run.error ? (run.steps.some((s) => s.status === 'failed') ? 'failed' : 'stopped') : 'done'
  run.endedAt = Date.now()
  record.outcome = run.status
  save()
  emitSoon()
  if (run.status === 'done') await api.ui.notify('Release desk', `${cfg.name} ${version} is ready${run.artifacts.length ? `: ${run.artifacts.map((a) => a.name).join(', ')}` : ''}.`).catch(() => {})
  else if (run.status === 'failed') await api.ui.notify('Release desk', `${cfg.name} ${version} did not finish. ${run.error}`).catch(() => {})
  return run
}

/** Installing an earlier version again: the way back. */
async function putBack(version, by = 'you') {
  if (run?.status === 'running') throw new Error('A release is under way; wait for it or stop it first.')
  const cfg = config()
  const command = cfg.rollback?.run ?? cfg.install?.run
  if (!command) throw new Error('This project has no install command, so there is nothing to put back with. Add one in the release settings.')
  const step = { id: 'install', stage: 'install', name: `Put back ${version}`, status: 'running', startedAt: Date.now(), endedAt: null, log: [], note: '' }
  run = { id: Date.now().toString(36), version, from: currentVersion(cfg), through: 'install', status: 'running', startedAt: Date.now(), endedAt: null, steps: [step], artifacts: [], error: null, by, rollback: true }
  stopping = false
  emitSoon()
  const record = { version, from: run.from, at: run.startedAt, notes: `Put back ${version}`, outcome: 'running', steps: [], artifacts: [], install: null, rollback: true, by }
  saveHistory([record, ...history()])
  const code = await exec(step, fill(command, version))
  let outcome = code === 0 ? 'done' : 'failed'
  if (code === 0 && cfg.install?.log) {
    const logPath = here(fill(cfg.install.log, version))
    record.install = { at: Date.now(), log: logPath, outcome: 'running' }
    saveHistory([record, ...history().filter((r) => r.at !== record.at)])
    const verdict = await watchInstall(step, logPath)
    record.install.outcome = verdict
    if (verdict === 'failed') outcome = 'failed'
  }
  step.status = outcome === 'done' ? 'done' : 'failed'
  step.endedAt = Date.now()
  run.status = outcome
  run.endedAt = Date.now()
  record.outcome = outcome
  record.steps = [{ name: step.name, status: step.status, ms: step.endedAt - step.startedAt }]
  saveHistory([record, ...history().filter((r) => r.at !== record.at)])
  emitSoon()
  return run
}

/** An install that was still going when Prism closed (installing Prism itself does that): finish its story from the log. */
function settleInstalls() {
  const list = history()
  let changed = false
  for (const r of list) {
    if (r.install?.outcome === 'running' || (r.install && r.install.outcome === 'unknown')) {
      try {
        const text = readFileSync(r.install.log, 'utf8')
        const v = installVerdict(text)
        if (v) {
          r.install.outcome = v
          r.install.tail = text.split(/\r?\n/).filter(Boolean).slice(-4)
          if (r.outcome === 'running') r.outcome = v === 'done' ? 'done' : 'failed'
          changed = true
        }
      } catch {
        /* the log has gone */
      }
    }
    // a release cut short by Prism closing, with no install to explain it
    if (r.outcome === 'running' && !r.install && (!run || run.startedAt !== r.at)) {
      r.outcome = 'stopped'
      changed = true
    }
  }
  if (changed) saveHistory(list)
}

async function extra(index, by = 'you') {
  if (run?.status === 'running') throw new Error('Something is already running.')
  const cfg = config()
  const x = cfg.extras[index]
  if (!x) throw new Error('There is no such extra build.')
  const version = currentVersion(cfg)
  const step = { id: `extra-${index}`, stage: 'build', name: x.name, status: 'running', startedAt: Date.now(), endedAt: null, log: [], note: '' }
  run = { id: Date.now().toString(36), version, from: version, through: 'build', status: 'running', startedAt: Date.now(), endedAt: null, steps: [step], artifacts: [], error: null, by, extra: x.name }
  stopping = false
  emitSoon()
  const code = await exec(step, fill(x.run, version))
  step.status = code === 0 ? 'done' : stopping ? 'skipped' : 'failed'
  step.endedAt = Date.now()
  run.artifacts = code === 0 ? (x.artifacts.length ? x.artifacts.flatMap((a) => expand(a, version)).map(describeFile).filter(Boolean) : freshFiles(run.startedAt)) : []
  run.status = code === 0 ? 'done' : 'failed'
  if (code !== 0) run.error = `${x.name}: stopped with code ${code}`
  run.endedAt = Date.now()
  emitSoon()
  return run
}

// ---------------------------------------------------------------- what the panel and the agent see

async function overview() {
  if (!root()) return { project: null }
  const cfg = config()
  const current = currentVersion(cfg)
  const what = await changes(current)
  let next = null
  try {
    next = { patch: nextVersion(current, 'patch'), minor: nextVersion(current, 'minor'), major: nextVersion(current, 'major') }
  } catch {
    /* not a counting version */
  }
  return {
    project: cfg.name,
    root: root(),
    config: cfg,
    configFile: existsSync(here(CONFIG)) ? CONFIG : null,
    version: current,
    next,
    changes: what,
    run: publicRun(),
    history: history().slice(0, 20),
    onDisk: onDisk(cfg).slice(0, 12)
  }
}

function summary(o) {
  if (!o.project) return 'No project is open.'
  const lines = [`${o.project}: version ${o.version ?? 'unknown'}${o.config.guessed ? ` (no ${CONFIG}; guessed: ${o.config.notes.join('; ') || 'nothing to go on'})` : ''}.`]
  lines.push(o.changes.list.length ? `${o.changes.list.length} change(s) since ${o.changes.since ?? 'the start'}:\n${o.changes.list.slice(0, 25).map((c) => `- ${c.subject}`).join('\n')}` : `Nothing new since ${o.changes.since ?? 'the last release'}.`)
  lines.push(`Steps: ${o.config.steps.map((s) => `${s.name} (${s.run})`).join(' → ') || 'none set'}${o.config.deliver.length ? `; then ${o.config.deliver.map((s) => s.name).join(', ')}` : ''}${o.config.install ? `; install: ${o.config.install.run}` : '; no install step'}.`)
  if (o.run) lines.push(`Latest run: ${o.run.version} ${o.run.status}${o.run.error ? ` (${o.run.error})` : ''}.${o.run.artifacts.length ? ` Built: ${o.run.artifacts.map((a) => a.path).join(', ')}` : ''}`)
  const last = o.history[0]
  if (last?.install) lines.push(`Last install (${last.version}): ${last.install.outcome}.`)
  if (o.onDisk.length) lines.push(`Versions that can be put back: ${o.onDisk.map((v) => v.version).join(', ')}.`)
  return lines.join('\n')
}

function runSummary(r) {
  return `${r.rollback ? 'Putting back' : 'Release'} ${r.version}: ${r.status}.${r.error ? ` ${r.error}` : ''}\n${r.steps.map((s) => `- ${s.name}: ${s.status}${s.note ? ` (${s.note})` : ''}`).join('\n')}${r.artifacts.length ? `\nBuilt:\n${r.artifacts.map((a) => `- ${a.path} (${(a.size / 1048576).toFixed(1)} MB)`).join('\n')}` : ''}${r.status === 'failed' ? `\nLast lines:\n${(r.steps.find((s) => s.status === 'failed')?.log ?? []).slice(-15).join('\n')}` : ''}`
}

export default {
  async start(a) {
    api = a
    if (api.root) settleInstalls()
  },
  async stop() {
    stopping = true
    killChild()
  },
  handlers: {
    overview: () => overview(),
    release: (args) => {
      // runs on: the panel follows it through 'run' events
      release({ bump: args.bump ?? 'patch', notes: args.notes, through: args.through ?? 'handover', by: 'you' }).catch((e) => api.ui.toast('Release desk', String(e?.message ?? e)))
      return true
    },
    stop: () => {
      stopping = true
      killChild()
      return true
    },
    putBack: (args) => {
      putBack(String(args.version), 'you').catch((e) => api.ui.toast('Release desk', String(e?.message ?? e)))
      return true
    },
    extra: (args) => {
      extra(Number(args.index), 'you').catch((e) => api.ui.toast('Release desk', String(e?.message ?? e)))
      return true
    },
    attach: async (args) => {
      await api.ui.attach(String(args.path), String(args.note ?? ''))
      return true
    },
    reveal: async (args) => {
      await api.ui.openFile(String(args.path))
      return true
    },
    saveConfig: async (args) => {
      const cfg = args.config ?? {}
      const clean = {
        name: cfg.name,
        versionFiles: cfg.versionFiles,
        commit: cfg.commit !== false,
        tag: cfg.tag === true,
        changelog: cfg.changelog === true,
        steps: cfg.steps,
        artifacts: cfg.artifacts,
        deliver: cfg.deliver,
        install: cfg.install?.run ? cfg.install : undefined,
        rollback: cfg.rollback?.run ? cfg.rollback : undefined,
        extras: cfg.extras?.length ? cfg.extras : undefined
      }
      mkdirSync(here('.prism'), { recursive: true })
      writeFileSync(here(CONFIG), JSON.stringify(clean, null, 2) + '\n')
      return overview()
    },
    askAgent: async () => {
      await api.agent.send(
        `Set up the release desk for this project: write ${CONFIG} with how it is really released (where the version number lives, the build steps in order, where the built files land with {version} in the path, any step that brings the work in, how it is installed and, if different, how an earlier version is put back). Read how the project builds first; ask me about anything you cannot tell. The format: { "name", "versionFiles": [], "commit": true, "tag": false, "changelog": false, "steps": [{ "name", "run" }], "artifacts": [], "deliver": [{ "name", "run" }], "install": { "run", "log"?, "note"? }, "rollback"?: { "run" }, "extras"?: [{ "name", "run", "artifacts": [], "note" }] }. Commands run from the project folder; {version}, {root}, {temp} and {date} are filled in.`
      )
      return true
    }
  },
  tools: [
    {
      name: 'release_status',
      description: "The project's release desk: current version, what changed since the last release, the release steps, the latest run, the last install's outcome, and which earlier versions can be put back.",
      parameters: { type: 'object', properties: {} },
      async execute() {
        return summary(await overview())
      }
    },
    {
      name: 'release_run',
      description:
        "Put out a new version through the project's release steps, shown live in the Release desk panel: new version number (committed), the builds, finding what was built, then optionally the deliver steps and the install. Waits until it finishes and reports each step. Install only when the user has asked for it: installing Prism itself closes this conversation's app and brings it back.",
      parameters: {
        type: 'object',
        properties: {
          bump: { type: 'string', description: '"patch" (default), "minor", "major", an exact version like "1.4.0", or "none" to rebuild the current version' },
          through: { type: 'string', enum: ['build', 'handover', 'deliver', 'install'], description: 'How far to go; default "handover" (built and found, nothing delivered or installed)' },
          notes: { type: 'string', description: "What is new, one line each; defaults to the commits' subjects" }
        }
      },
      async execute(args) {
        api.ui.show().catch(() => {})
        const r = await release({ bump: args.bump ?? 'patch', through: args.through ?? 'handover', notes: args.notes, by: 'Prism' })
        return { content: runSummary(r), isError: r.status !== 'done' }
      }
    },
    {
      name: 'release_put_back',
      description: 'Install an earlier version again (the way back after a bad release). Only when the user has asked. Lists what can be put back if no version is given.',
      parameters: { type: 'object', properties: { version: { type: 'string' } } },
      async execute(args) {
        const cfg = config()
        if (!args.version) {
          const v = onDisk(cfg)
          return v.length ? `Versions with their builds still on disk: ${v.map((x) => x.version).join(', ')}` : 'No earlier builds were found on disk.'
        }
        api.ui.show().catch(() => {})
        const r = await putBack(String(args.version), 'Prism')
        return { content: runSummary(r), isError: r.status !== 'done' }
      }
    },
    {
      name: 'release_hand_over',
      description: 'Hand the user the files the latest release built (or any file), as cards in the conversation that the phone can download.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'A particular file; default every file the latest run found' } } },
      async execute(args) {
        const files = args.path ? [describeFile(here(String(args.path)))].filter(Boolean) : (run?.artifacts ?? [])
        if (!files.length) return { content: 'There is nothing to hand over: no release has built anything yet.', isError: true }
        for (const f of files) await api.ui.attach(f.path, `${config().name} ${run?.version ?? ''}`.trim())
        return `Handed over ${files.map((f) => f.name).join(', ')}.`
      }
    }
  ]
}
