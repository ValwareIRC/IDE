// What the project dashboard shows about a folder: its package, its git
// history, how big it is and in which languages, and the notes people left in
// the code. Everything here is read-only and quick; the one slow question
// (are there newer versions of the dependencies?) is asked separately.
import { exec } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { OutdatedReport, ProjectOverview } from '@shared/types'
import { globFiles, searchWorkspace } from '../fs/search'
import { git, status } from '../git/git'

const LANGUAGES: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++', '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP',
  '.css': 'CSS', '.scss': 'CSS', '.less': 'CSS', '.html': 'HTML', '.htm': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte',
  '.md': 'Markdown', '.sh': 'Shell', '.ps1': 'PowerShell', '.sql': 'SQL', '.lua': 'Lua', '.dart': 'Dart',
  '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML'
}
// counted, but they are not what someone means by "how much code is this"
const DATA = new Set(['JSON', 'YAML', 'TOML', 'Markdown'])
const LOCKS = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock)$/

function manager(root: string): string | null {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun'
  if (existsSync(join(root, 'package.json'))) return 'npm'
  return null
}

async function size(root: string, files: string[]): Promise<ProjectOverview['files']> {
  const by = new Map<string, { lines: number; files: number }>()
  let lines = 0
  const todo = files.filter((f) => LANGUAGES[extname(f).toLowerCase()] && !LOCKS.test(f)).slice(0, 4000)
  let next = 0
  const work = async (): Promise<void> => {
    for (;;) {
      const f = todo[next++]
      if (!f) return
      try {
        const abs = join(root, f)
        if ((await stat(abs)).size > 600_000) continue
        const text = await readFile(abs, 'utf8')
        let n = text ? 1 : 0
        for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n += 1
        const name = LANGUAGES[extname(f).toLowerCase()]!
        const cur = by.get(name) ?? { lines: 0, files: 0 }
        cur.lines += n
        cur.files += 1
        by.set(name, cur)
        if (!DATA.has(name)) lines += n
      } catch {
        /* a file that went away, or cannot be read */
      }
    }
  }
  await Promise.all(Array.from({ length: 12 }, work))
  const languages = [...by.entries()]
    .map(([name, v]) => ({ name, ...v, data: DATA.has(name) }))
    .sort((a, b) => Number(a.data) - Number(b.data) || b.lines - a.lines)
  return { tracked: files.length, lines, languages }
}

export async function projectOverview(root: string): Promise<ProjectOverview> {
  let pkg: ProjectOverview['package'] = null
  try {
    const p = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string; description?: string; dependencies?: object; devDependencies?: object }
    pkg = { name: p.name ?? null, version: p.version ?? null, description: p.description ?? null, deps: Object.keys(p.dependencies ?? {}).length, devDeps: Object.keys(p.devDependencies ?? {}).length, manager: manager(root) }
  } catch {
    pkg = null
  }

  const st = await status(root).catch(() => null)
  let repo: ProjectOverview['git'] = null
  let files: string[] = []
  if (st?.isRepo) {
    const [count, people, first, recent, tracked] = await Promise.all([
      git(root, ['rev-list', '--count', 'HEAD']),
      git(root, ['shortlog', '-sn', 'HEAD']),
      git(root, ['log', '--max-parents=0', '--format=%at', 'HEAD']),
      git(root, ['log', '-6', '--format=%h%x1f%s%x1f%an%x1f%at']),
      git(root, ['ls-files'])
    ])
    files = tracked.ok ? tracked.stdout.split('\n').filter(Boolean) : []
    const firstAt = first.ok ? Math.min(...first.stdout.split('\n').filter(Boolean).map(Number)) : NaN
    repo = {
      branch: st.branch,
      ahead: st.ahead,
      behind: st.behind,
      commits: count.ok ? Number(count.stdout.trim()) || 0 : 0,
      contributors: people.ok ? people.stdout.split('\n').filter((l) => l.trim()).length : 0,
      firstCommit: Number.isFinite(firstAt) ? firstAt * 1000 : null,
      recent: recent.ok
        ? recent.stdout
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              const [hash, subject, author, at] = l.split('\x1f')
              return { hash: hash ?? '', subject: subject ?? '', author: author ?? '', date: Number(at) * 1000 }
            })
        : [],
      changed: st.files.map((f) => ({ path: f.path, status: f.status }))
    }
  }
  if (!files.length) files = await globFiles(root, '**/*', 6000).catch(() => [])

  // a note is one of these words at the start of a comment; the word in prose, or in code that handles such notes, is not
  const found = await searchWorkspace(root, { query: '(//|#|/\\*|^\\s*\\*|--|<!--)\\s*(TODO|FIXME|HACK|XXX)\\b', regex: true, caseSensitive: true, wholeWord: false, maxResults: 400 }).catch(() => null)
  const todos: ProjectOverview['todos'] = []
  for (const m of found?.matches ?? []) {
    if (LOCKS.test(m.path) || /\.(min\.js|map|svg|md|markdown|txt)$/i.test(m.path)) continue
    const tag = /\b(TODO|FIXME|HACK|XXX)\b/.exec(m.text)?.[1] as ProjectOverview['todos'][number]['tag'] | undefined
    if (!tag) continue
    // what follows the word is the note; the comment marks before it are noise
    const text = m.text.slice(m.text.indexOf(tag) + tag.length).replace(/^[\s:()\-–]+/, '').replace(/\s*(\*\/|-->)\s*$/, '').trim()
    todos.push({ tag, path: m.path, line: m.line, text: text.slice(0, 160) })
  }

  return { name: pkg?.name || basename(root), root, package: pkg, git: repo, files: await size(root, files), todos }
}

function run(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: 90_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? ((err as { code?: number }).code ?? 1) : 0 }))
  })
}

/** Which dependencies have newer versions. Asks the package registry, so it takes a few seconds and needs the network. */
export async function outdated(root: string): Promise<OutdatedReport> {
  const pm = manager(root)
  if (!pm) return { manager: null, packages: [], note: 'This project has no package.json, so there is nothing to look up.' }
  if (pm === 'yarn' || pm === 'bun') return { manager: pm, packages: [], note: `Looking up newer versions is not set up for ${pm} projects yet.` }
  // both exit with 1 when something is outdated; the list is on stdout either way
  const missing = (x: { stdout: string; stderr: string; code: number }): boolean => !x.stdout.trim() && /not recognized|not found|ENOENT/i.test(x.stderr)
  let r = await run(pm === 'pnpm' ? 'pnpm outdated --format json' : 'npm outdated --json', root)
  // pnpm is often installed through corepack only, without a command of its own
  if (pm === 'pnpm' && missing(r)) r = await run('corepack pnpm outdated --format json', root)
  if (missing(r)) return { manager: pm, packages: [], note: `${pm} is not installed as a command on this computer, so newer versions cannot be looked up from here.` }
  let data: Record<string, { current?: string; wanted?: string; latest?: string; dependencyType?: string; type?: string }> = {}
  try {
    data = r.stdout.trim() ? JSON.parse(r.stdout) : {}
  } catch {
    return { manager: pm, packages: [], note: `${pm} did not answer in a form Prism understands. ${r.stderr.trim().split('\n').pop() ?? ''}`.trim() }
  }
  if (!Object.keys(data).length && r.code !== 0 && r.stderr.trim()) return { manager: pm, packages: [], note: r.stderr.trim().split('\n').slice(-2).join(' ') }
  const packages = Object.entries(data)
    .map(([name, v]) => ({ name, current: v.current ?? '?', wanted: v.wanted ?? v.latest ?? '?', latest: v.latest ?? '?', dev: /dev/i.test(v.dependencyType ?? v.type ?? '') }))
    .filter((p) => p.current !== p.latest)
    .sort((a, b) => a.name.localeCompare(b.name))
  return { manager: pm, packages, note: null }
}

/** Where to read what changed in each package: its repository's releases, from the registry. */
export async function releaseNotes(names: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  await Promise.all(
    names.slice(0, 30).map(async (name) => {
      try {
        // the newest version's own entry: small, and unlike the short listing it has the repository
        const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`, { signal: AbortSignal.timeout(10_000) })
        const meta = (await res.json()) as { repository?: { url?: string } | string; homepage?: string }
        const repo = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url
        const gh = repo ? /github\.com[/:]([^/]+)\/([^/#.]+)/.exec(repo) : null
        out[name] = gh ? `https://github.com/${gh[1]}/${gh[2]}/releases` : (meta.homepage ?? null)
      } catch {
        out[name] = null
      }
    })
  )
  return out
}
