// Dependencies and safety: which updates are safe to take, which known security holes
// the project carries, which licences it must honour (and the credits it owes, like the
// OpenStreetMap credit for map data), and secrets about to be committed by mistake.
//
// It asks the project's own tools (pnpm, npm, pip, cargo) rather than guessing, and
// says plainly when one is not installed. Results are kept between visits, with the
// time they were taken, because the slow ones ask the internet.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanProject } from './secrets.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CREDITS = '.prism/credits.json'
const ALLOW = '.prism/secrets-allow.json'
const HOOK_MARK = 'Added by Prism\'s Safety gadget'

let api = null
const busy = new Set()

const here = (p) => join(api.root, p)
const projectKey = () => createHash('sha1').update(api.root.toLowerCase()).digest('hex').slice(0, 12)
const cacheFile = () => join(api.dataDir, projectKey(), 'last.json')

function cache() {
  try {
    return JSON.parse(readFileSync(cacheFile(), 'utf8'))
  } catch {
    return {}
  }
}

function remember(key, value) {
  const all = cache()
  all[key] = { ...value, at: Date.now() }
  mkdirSync(dirname(cacheFile()), { recursive: true })
  writeFileSync(cacheFile(), JSON.stringify(all))
  api.emit('result', { key, value: all[key] })
  return all[key]
}

function cleanEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.PRISM_GADGET
  return env
}

function run(command, { timeout = 180_000 } = {}) {
  return new Promise((res) => {
    execFile(command, { cwd: api.root, shell: true, timeout, windowsHide: true, env: cleanEnv(), maxBuffer: 128 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout ?? ''), err: String(stderr ?? '') })
    })
  })
}

/** The first JSON value in a command's output (package tools print notices around it). */
function json(text) {
  const start = text.search(/[[{]/)
  if (start < 0) return null
  try {
    return JSON.parse(text.slice(start))
  } catch {
    // trailing notices after the JSON
    for (let end = text.length; end > start; end = text.lastIndexOf(text[start] === '{' ? '}' : ']', end - 1)) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        /* shorter */
      }
      if (end <= start) break
    }
    return null
  }
}

// ---------------------------------------------------------------- what the project is made with

function kinds() {
  const out = []
  if (existsSync(here('package.json'))) {
    let pm = 'npm'
    try {
      const pkg = JSON.parse(readFileSync(here('package.json'), 'utf8'))
      if (String(pkg.packageManager ?? '').startsWith('pnpm') || existsSync(here('pnpm-lock.yaml'))) pm = 'pnpm'
      else if (existsSync(here('yarn.lock'))) pm = 'yarn'
    } catch {
      /* a broken package.json: npm will say so */
    }
    out.push({ kind: 'node', pm })
  }
  if (existsSync(here('requirements.txt')) || existsSync(here('pyproject.toml'))) out.push({ kind: 'python' })
  if (existsSync(here('Cargo.toml'))) out.push({ kind: 'rust' })
  return out
}

const pnpm = (args) => run(`corepack pnpm ${args}`)

// ---------------------------------------------------------------- updates

function sameMajor(a, b) {
  const x = String(a).match(/^(\d+)\.(\d+)/)
  const y = String(b).match(/^(\d+)\.(\d+)/)
  if (!x || !y) return false
  // below 1.0 a minor step can break things too
  return x[1] === y[1] && (x[1] !== '0' || x[2] === y[2])
}

async function updates() {
  const list = []
  const notes = []
  for (const k of kinds()) {
    if (k.kind === 'node') {
      const r = k.pm === 'pnpm' ? await pnpm('outdated --format json') : await run('npm outdated --json')
      const j = json(r.out) ?? {}
      for (const [name, v] of Object.entries(j)) {
        const current = v.current ?? (Array.isArray(v) ? v[0]?.current : '')
        if (!current || current === v.latest) continue
        list.push({ name, from: current, to: v.latest, wanted: v.wanted, kind: 'node', dev: /dev/i.test(v.dependencyType ?? v.type ?? ''), deprecated: !!v.isDeprecated, safe: sameMajor(current, v.latest) })
      }
      if (r.code !== 0 && !Object.keys(j).length && r.err.trim()) notes.push(`${k.pm}: ${r.err.trim().split('\n').slice(-2).join(' ')}`)
    } else if (k.kind === 'python') {
      const r = await run('python -m pip list --outdated --format json')
      const j = json(r.out)
      if (Array.isArray(j)) for (const p of j) list.push({ name: p.name, from: p.version, to: p.latest_version, kind: 'python', dev: false, deprecated: false, safe: sameMajor(p.version, p.latest_version) })
      else notes.push('Python packages could not be checked (is Python on the path?).')
    } else if (k.kind === 'rust') {
      const r = await run('cargo outdated --format json --depth 1')
      const j = json(r.out)
      if (j?.dependencies) for (const d of j.dependencies) if (d.latest && d.latest !== '---' && d.latest !== d.project) list.push({ name: d.name, from: d.project, to: d.latest, kind: 'rust', dev: d.kind === 'Development', deprecated: false, safe: sameMajor(d.project, d.latest) })
      else notes.push('Rust crates need cargo-outdated to be checked: cargo install cargo-outdated')
    }
  }
  list.sort((a, b) => Number(b.safe) - Number(a.safe) || Number(a.dev) - Number(b.dev) || a.name.localeCompare(b.name))
  return remember('updates', { list, notes })
}

// ---------------------------------------------------------------- known holes

const RANK = { critical: 4, high: 3, moderate: 2, medium: 2, low: 1, info: 0 }

async function holes() {
  const list = []
  const notes = []
  for (const k of kinds()) {
    if (k.kind === 'node') {
      const r = k.pm === 'pnpm' ? await pnpm('audit --json') : await run('npm audit --json')
      const j = json(r.out)
      if (j?.advisories) {
        for (const a of Object.values(j.advisories)) {
          const f = a.findings ?? []
          list.push({ id: String(a.github_advisory_id ?? a.id), name: a.module_name, title: a.title, severity: a.severity, url: a.url, versions: [...new Set(f.map((x) => x.version))], fixedIn: a.patched_versions && a.patched_versions !== '<0.0.0' ? a.patched_versions : 'no fix yet', via: f.flatMap((x) => x.paths ?? []).slice(0, 4).map((p) => p.replace(/^\.>/, '').split('>').join(' › ')), onlyWhileBuilding: f.length > 0 && f.every((x) => x.dev), kind: 'node' })
        }
      } else if (j?.vulnerabilities) {
        for (const [name, v] of Object.entries(j.vulnerabilities)) {
          const direct = (v.via ?? []).filter((x) => typeof x === 'object')
          if (!direct.length) continue
          for (const d of direct) list.push({ id: String(d.source ?? d.url ?? name), name, title: d.title, severity: d.severity, url: d.url, versions: [v.range], fixedIn: v.fixAvailable ? 'an update is available' : 'no fix yet', via: (v.nodes ?? []).slice(0, 4).map((n) => n.replace(/node_modules\//g, '').split('/').join(' › ')), onlyWhileBuilding: false, kind: 'node' })
        }
      } else if (r.err.trim()) notes.push(`${k.pm} audit: ${r.err.trim().split('\n').slice(-2).join(' ')}`)
    } else if (k.kind === 'python') {
      const r = await run('pip-audit -f json')
      const j = json(r.out)
      if (j?.dependencies) for (const d of j.dependencies) for (const v of d.vulns ?? []) list.push({ id: v.id, name: d.name, title: v.description?.split('\n')[0]?.slice(0, 160) ?? v.id, severity: 'unknown', url: `https://osv.dev/vulnerability/${v.id}`, versions: [d.version], fixedIn: (v.fix_versions ?? []).join(', ') || 'no fix yet', via: [], onlyWhileBuilding: false, kind: 'python' })
      else notes.push('Python packages need pip-audit to be checked: python -m pip install pip-audit')
    } else if (k.kind === 'rust') {
      const r = await run('cargo audit --json')
      const j = json(r.out)
      if (j?.vulnerabilities) for (const v of j.vulnerabilities.list ?? []) list.push({ id: v.advisory.id, name: v.package.name, title: v.advisory.title, severity: v.advisory.cvss ? 'high' : 'unknown', url: v.advisory.url ?? `https://rustsec.org/advisories/${v.advisory.id}`, versions: [v.package.version], fixedIn: (v.versions?.patched ?? []).join(', ') || 'no fix yet', via: [], onlyWhileBuilding: false, kind: 'rust' })
      else notes.push('Rust crates need cargo-audit to be checked: cargo install cargo-audit')
    }
  }
  list.sort((a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) || Number(a.onlyWhileBuilding) - Number(b.onlyWhileBuilding))
  return remember('holes', { list, notes })
}

// ---------------------------------------------------------------- licences and credits

const STRONG = /\b(A?GPL|SSPL|EUPL|OSL|CC-BY-NC|CC-BY-SA|Commons-Clause|BUSL|Elastic)/i
const WEAK = /\b(LGPL|MPL|EPL|CDDL|CPL)/i
const FREE = /^(\(?)(MIT|ISC|BSD|Apache|0BSD|Unlicense|CC0|Zlib|BlueOak|Python|PSF|WTFPL|OFL|Artistic|X11|BSL-1\.0)/i
const NO_CREDIT = /^(\(?)(0BSD|Unlicense|CC0|WTFPL)/i

function classify(licence) {
  const l = String(licence ?? '').trim()
  if (!l || /^(unknown|unlicensed|see license in|custom)/i.test(l)) return 'unknown'
  // "A OR B": the friendliest choice counts
  if (/\bOR\b/i.test(l) && l.split(/\bOR\b/i).some((p) => FREE.test(p.trim().replace(/^\(/, '')))) return NO_CREDIT.test(l) ? 'free' : 'credit'
  if (STRONG.test(l)) return 'strong'
  if (WEAK.test(l)) return 'weak'
  if (NO_CREDIT.test(l)) return 'free'
  if (FREE.test(l)) return 'credit'
  return 'unknown'
}

const MEANING = {
  free: 'Free to use with no conditions.',
  credit: 'Free to use; its notice must be kept with what you ship.',
  weak: 'Usable; changes to its own files must be shared under the same licence.',
  strong: 'Shipping it can oblige you to share your whole program under the same licence. Check before you release.',
  unknown: 'No licence was found in the package itself. Look at its page to see what it allows.'
}

async function licences({ all = false } = {}) {
  const packages = []
  const notes = []
  for (const k of kinds()) {
    if (k.kind !== 'node') continue
    if (k.pm === 'pnpm') {
      const r = await pnpm(`licenses list --json${all ? '' : ' --prod'}`)
      const j = json(r.out)
      if (j) for (const [licence, list] of Object.entries(j)) for (const p of list) packages.push({ name: p.name, version: (p.versions ?? []).join(', '), licence, author: p.author ?? '', homepage: p.homepage ?? '', path: p.paths?.[0] ?? null })
      else notes.push('pnpm could not list the licences.')
    } else {
      // npm and yarn: read what is installed
      const seen = new Set()
      const walk = (dir, depth) => {
        let names = []
        try {
          names = readdirSync(dir)
        } catch {
          return
        }
        for (const n of names) {
          if (n.startsWith('.')) continue
          if (n.startsWith('@') && depth < 6) {
            walk(join(dir, n), depth + 1)
            continue
          }
          const p = join(dir, n)
          try {
            const pkg = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8'))
            const id = `${pkg.name}@${pkg.version}`
            if (!seen.has(id)) {
              seen.add(id)
              const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((x) => x.type ?? x).join(' OR ') : '')
              packages.push({ name: pkg.name, version: pkg.version, licence: lic || 'Unknown', author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name ?? '', homepage: pkg.homepage ?? '', path: p })
            }
          } catch {
            /* not a package */
          }
          if (depth < 6 && existsSync(join(p, 'node_modules'))) walk(join(p, 'node_modules'), depth + 1)
        }
      }
      walk(here('node_modules'), 0)
      if (!packages.length) notes.push('Nothing is installed yet (no node_modules), so there were no licences to read.')
    }
  }
  if (kinds().some((k) => k.kind !== 'node')) notes.push('Only JavaScript packages are read for licences so far.')
  for (const p of packages) p.class = classify(p.licence)
  const order = { strong: 0, unknown: 1, weak: 2, credit: 3, free: 4 }
  packages.sort((a, b) => order[a.class] - order[b.class] || a.name.localeCompare(b.name))
  const counts = {}
  for (const p of packages) counts[p.class] = (counts[p.class] ?? 0) + 1
  return remember('licences', { packages, counts, notes, all })
}

function credits() {
  try {
    const j = JSON.parse(readFileSync(here(CREDITS), 'utf8'))
    return Array.isArray(j.credits) ? j.credits : []
  } catch {
    return []
  }
}

function saveCredits(list) {
  mkdirSync(here('.prism'), { recursive: true })
  writeFileSync(here(CREDITS), JSON.stringify({ credits: list }, null, 2) + '\n')
}

function licenceText(dir) {
  if (!dir) return ''
  try {
    const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i.test(n))
    return f ? readFileSync(join(dir, f), 'utf8').trim() : ''
  } catch {
    return ''
  }
}

/** THIRD-PARTY-NOTICES.md: every credit owed, with the notices that must travel with the program. */
async function notices() {
  const l = cache().licences && !cache().licences.all ? cache().licences : await licences({ all: false })
  const owed = l.packages.filter((p) => p.class !== 'free')
  const out = ['# Third-party notices', '', `What ${api.root.split(/[\\/]/).pop()} is built with and the credit each one is owed. Made by Prism's Safety panel on ${new Date().toISOString().slice(0, 10)}.`, '']
  const extra = credits()
  if (extra.length) {
    out.push('## Data, pictures and other works', '')
    for (const c of extra) out.push(`- **${c.what}**: ${c.from}${c.licence ? `, under ${c.licence}` : ''}${c.url ? ` (${c.url})` : ''}${c.note ? `. ${c.note}` : ''}`)
    out.push('')
  }
  out.push('## Software', '')
  for (const p of owed) {
    out.push(`### ${p.name} ${p.version}`, '', `${p.licence}${p.author ? ` · ${p.author}` : ''}${p.homepage ? ` · ${p.homepage}` : ''}`, '')
    const text = licenceText(p.path)
    if (text) out.push('```', text.length > 6000 ? text.slice(0, 6000) + '\n…' : text, '```', '')
  }
  writeFileSync(here('THIRD-PARTY-NOTICES.md'), out.join('\n'))
  return { path: here('THIRD-PARTY-NOTICES.md'), packages: owed.length, credits: extra.length }
}

// ---------------------------------------------------------------- secrets

async function hooksDir() {
  const r = await run('git rev-parse --git-path hooks')
  if (r.code !== 0) return null
  return resolve(api.root, r.out.trim())
}

async function guardState() {
  const dir = await hooksDir()
  if (!dir) return { git: false, on: false, other: false }
  const hook = join(dir, 'pre-commit')
  const text = existsSync(hook) ? readFileSync(hook, 'utf8') : ''
  return { git: true, on: text.includes(HOOK_MARK), other: !!text && !text.includes(HOOK_MARK), dir }
}

async function guard(on) {
  const s = await guardState()
  if (!s.git) throw new Error('This project is not in git, so there are no commits to guard.')
  const hook = join(s.dir, 'pre-commit')
  if (on) {
    if (s.other) throw new Error('This project already has its own pre-commit hook, so Prism will not replace it. Add this line to it to check for secrets too:  node "$(dirname "$0")/prism-secrets.mjs" --hook || exit 1')
    mkdirSync(s.dir, { recursive: true })
    copyFileSync(join(HERE, 'secrets.mjs'), join(s.dir, 'prism-secrets.mjs'))
    writeFileSync(hook, `#!/bin/sh\n# ${HOOK_MARK}: it stops passwords and keys being committed by mistake.\n# To skip it once: git commit --no-verify. To remove it: delete this file.\nexec node "$(dirname "$0")/prism-secrets.mjs" --hook\n`)
    try {
      chmodSync(hook, 0o755)
    } catch {
      /* Windows has no execute bit; git for Windows runs it anyway */
    }
  } else if (s.on) {
    writeFileSync(hook, '')
    try {
      // an empty hook does nothing; removing it is tidier where allowed
      const { unlinkSync } = await import('node:fs')
      unlinkSync(hook)
      unlinkSync(join(s.dir, 'prism-secrets.mjs'))
    } catch {
      /* left empty */
    }
  }
  return guardState()
}

async function secrets({ staged = false } = {}) {
  const g = await guardState()
  if (!g.git) return remember('secrets', { list: [], guard: g, notes: ['This project is not in git.'] })
  let list = []
  const notes = []
  try {
    list = scanProject(api.root, { staged })
  } catch (e) {
    notes.push(`The check failed: ${e.message}`)
  }
  return remember('secrets', { list, guard: g, staged, notes })
}

function allowList() {
  try {
    return JSON.parse(readFileSync(here(ALLOW), 'utf8'))
  } catch {
    return { keys: [], files: [] }
  }
}

function allow({ key, file }) {
  const a = allowList()
  a.keys ??= []
  a.files ??= []
  if (key && !a.keys.includes(key)) a.keys.push(key)
  if (file && !a.files.includes(file)) a.files.push(file)
  mkdirSync(here('.prism'), { recursive: true })
  writeFileSync(here(ALLOW), JSON.stringify(a, null, 2) + '\n')
  return true
}

function ignore(file) {
  const gi = here('.gitignore')
  const text = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
  const line = file.replace(/\\/g, '/')
  if (!text.split(/\r?\n/).includes(line)) writeFileSync(gi, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`)
  return true
}

// ---------------------------------------------------------------- together

async function guarded(key, fn) {
  if (busy.has(key)) throw new Error('Already checking.')
  busy.add(key)
  api.emit('busy', [...busy])
  try {
    return await fn()
  } finally {
    busy.delete(key)
    api.emit('busy', [...busy])
  }
}

async function overview() {
  if (!api.root) return { project: null }
  return { project: api.root, kinds: kinds(), last: cache(), credits: credits(), guard: await guardState(), busy: [...busy] }
}

function summarise(key, v) {
  if (!v) return `${key}: not checked yet.`
  const when = new Date(v.at).toLocaleString()
  if (key === 'updates') {
    const safe = v.list.filter((u) => u.safe)
    const big = v.list.filter((u) => !u.safe)
    return `Updates (${when}): ${safe.length} safe to take${safe.length ? `: ${safe.map((u) => `${u.name} ${u.from} → ${u.to}${u.dev ? ' (build tool)' : ''}`).join(', ')}` : ''}. ${big.length} bigger ones that may need changes${big.length ? `: ${big.map((u) => `${u.name} ${u.from} → ${u.to}`).join(', ')}` : ''}.${v.notes.length ? ` Notes: ${v.notes.join(' ')}` : ''}`
  }
  if (key === 'holes') {
    if (!v.list.length) return `Known security holes (${when}): none found.${v.notes.length ? ` Notes: ${v.notes.join(' ')}` : ''}`
    return `Known security holes (${when}): ${v.list.length}.\n${v.list.map((h) => `- ${h.severity}: ${h.name} ${h.versions.join(', ')}: ${h.title}. Fixed in ${h.fixedIn}.${h.onlyWhileBuilding ? ' Only in build tools, not in what ships.' : ''}${h.via.length ? ` Through: ${h.via[0]}` : ''} ${h.url ?? ''}`).join('\n')}`
  }
  if (key === 'licences') {
    const c = v.counts
    const worry = v.packages.filter((p) => p.class === 'strong' || p.class === 'unknown' || p.class === 'weak')
    return `Licences (${when}, ${v.all ? 'everything installed' : 'what ships'}): ${v.packages.length} packages; ${c.credit ?? 0} need their notice kept, ${c.weak ?? 0} share-alike for their own files, ${c.strong ?? 0} strong share-alike, ${c.unknown ?? 0} unknown.${worry.length ? `\nWorth a look:\n${worry.map((p) => `- ${p.name} ${p.version}: ${p.licence} (${MEANING[p.class]})`).join('\n')}` : ''}`
  }
  if (key === 'secrets') {
    return `Secrets (${when}, ${v.staged ? 'what is staged' : 'everything not yet committed'}): ${v.list.length ? `${v.list.length} found:\n${v.list.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ''} ${f.what}${f.weak ? ' (maybe)' : ''}`).join('\n')}` : 'none found'}. Commit guard: ${v.guard?.on ? 'on' : 'off'}.`
  }
  return ''
}

export default {
  async start(a) {
    api = a
  },
  handlers: {
    overview,
    updates: () => guarded('updates', updates),
    holes: () => guarded('holes', holes),
    licences: (a) => guarded('licences', () => licences({ all: !!a.all })),
    secrets: (a) => guarded('secrets', () => secrets({ staged: !!a.staged })),
    guard: (a) => guard(!!a.on),
    allow: (a) => allow(a),
    ignore: (a) => ignore(String(a.file)),
    notices: () => notices(),
    addCredit: (a) => {
      const list = credits()
      list.push({ what: String(a.what ?? '').trim(), from: String(a.from ?? '').trim(), licence: String(a.licence ?? '').trim(), url: String(a.url ?? '').trim(), note: String(a.note ?? '').trim() })
      saveCredits(list.filter((c) => c.what && c.from))
      return credits()
    },
    removeCredit: (a) => {
      const list = credits()
      list.splice(Number(a.index), 1)
      saveCredits(list)
      return credits()
    },
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
      name: 'safety_check',
      description:
        "Check the project's dependencies and safety: updates (which are safe to take, which may break things), known security holes, licences (and which need credit), and secrets about to be committed. Each check asks the project's own tools; updates and holes ask the internet.",
      parameters: { type: 'object', properties: { what: { type: 'string', enum: ['all', 'updates', 'holes', 'licences', 'secrets'], description: 'Default all' } } },
      async execute(a) {
        const what = a.what ?? 'all'
        const parts = []
        if (what === 'all' || what === 'updates') parts.push(summarise('updates', await guarded('updates', updates)))
        if (what === 'all' || what === 'holes') parts.push(summarise('holes', await guarded('holes', holes)))
        if (what === 'all' || what === 'licences') parts.push(summarise('licences', await guarded('licences', () => licences({}))))
        if (what === 'all' || what === 'secrets') parts.push(summarise('secrets', await guarded('secrets', () => secrets({}))))
        return parts.join('\n\n')
      }
    },
    {
      name: 'safety_credit',
      description: 'Record a credit the project owes for something that is not a code package: map data (OpenStreetMap, ODbL), fonts, pictures, sounds, models. It goes into THIRD-PARTY-NOTICES.md.',
      parameters: { type: 'object', properties: { what: { type: 'string', description: 'What is used, like "Map data"' }, from: { type: 'string', description: 'Who it is from, like "OpenStreetMap contributors"' }, licence: { type: 'string' }, url: { type: 'string' }, note: { type: 'string', description: 'How the credit must be shown, if it says' } }, required: ['what', 'from'] },
      async execute(a) {
        const list = credits()
        list.push({ what: a.what, from: a.from, licence: a.licence ?? '', url: a.url ?? '', note: a.note ?? '' })
        saveCredits(list)
        api.emit('credits', list)
        return `Recorded: ${a.what} from ${a.from}. ${list.length} credit(s) in ${CREDITS}.`
      }
    },
    {
      name: 'safety_notices',
      description: 'Write THIRD-PARTY-NOTICES.md in the project: every package that needs its notice kept (with its licence text) and every recorded credit. Ship it with the program.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const r = await notices()
        return `Wrote ${r.path}: ${r.packages} package notice(s) and ${r.credits} other credit(s).`
      }
    }
  ]
}
