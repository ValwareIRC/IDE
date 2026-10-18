import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { SearchMatch, SearchOptions, SearchResult } from '@shared/types'
import { placeOf } from '@shared/place'
import { collect, command } from '../remote/command'
import { hiddenDirs } from './paths'

/** ripgrep arguments that leave out the hidden folders wherever they are. */
function hiddenGlobs(): string[] {
  return hiddenDirs().flatMap((d) => ['-g', `!**/${d}/**`])
}

let rgPathCache: string | null | undefined

/** Locate the ripgrep binary shipped by @vscode/ripgrep's platform package. */
export function rgPath(): string | null {
  if (rgPathCache !== undefined) return rgPathCache
  const bin = process.platform === 'win32' ? 'rg.exe' : 'rg'
  // the installed app carries the binary in its resources folder (scripts/package.mjs)
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resources && existsSync(join(resources, 'bin', bin))) {
    rgPathCache = join(resources, 'bin', bin)
    return rgPathCache
  }
  try {
    // the package's own export knows where its platform binary is, whatever the node_modules layout
    const found = (createRequire(import.meta.url)('@vscode/ripgrep') as { rgPath?: string }).rgPath
    if (found && existsSync(found)) {
      rgPathCache = found
      return found
    }
  } catch {
    /* fall through */
  }
  rgPathCache = null
  return null
}

/** A glob as a regular expression, for filtering a plain file list. */
function globRe(glob: string): RegExp {
  const body = glob
    .replace(/[.+^$()|[\]{}\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*')
  return new RegExp(`^(?:.*/)?${body}$`)
}

/** ripgrep on a computer reached over SSH; null when it is not installed there. */
async function remoteRg(cwd: string, args: string[], timeoutMs: number): Promise<string | null> {
  const r = await collect(command(cwd, ['rg', ...args]), timeoutMs)
  if (r.code === 127 || /rg: (command )?not found|No such file or directory/i.test(r.stderr)) return null
  if (r.code === 255) throw new Error(`Could not search there: ${r.stderr.trim().split('\n').pop() ?? 'the connection failed'}`)
  return r.stdout.toString('utf8')
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, windowsHide: true })
    let out = ''
    let total = 0
    const cap = 12 * 1024 * 1024
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      if (total < cap) {
        out += d.toString('utf8')
        total += d.length
      }
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ out, code: null })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ out, code })
    })
  })
}

/** Content search across the workspace via ripgrep JSON output. */
export async function searchWorkspace(root: string, opts: SearchOptions): Promise<SearchResult> {
  const t0 = Date.now()
  const bin = rgPath()
  const max = opts.maxResults ?? 2000
  if (!opts.query) return { matches: [], files: 0, truncated: false, durationMs: 0 }
  const args = ['--json', '--line-number', '--column', '--no-heading', '--max-count', '200', '--max-filesize', '2M', '--hidden', ...hiddenGlobs()]
  if (!opts.regex) args.push('--fixed-strings')
  if (!opts.caseSensitive) args.push('--ignore-case')
  if (opts.wholeWord) args.push('--word-regexp')
  if (opts.include) for (const g of opts.include.split(',').map((s) => s.trim()).filter(Boolean)) args.push('-g', g)
  if (opts.exclude) for (const g of opts.exclude.split(',').map((s) => s.trim()).filter(Boolean)) args.push('-g', `!${g}`)
  args.push('--', opts.query, '.')
  const matches: SearchMatch[] = []
  const files = new Set<string>()
  let truncated = false
  let out: string
  if (placeOf(root).kind === 'ssh') {
    const far = await remoteRg(root, args, 30_000)
    if (far === null) {
      // no ripgrep over there: plain grep finds the same lines, a little slower and without the column
      const flags = ['-rnI', opts.regex ? '-E' : '-F', ...(opts.caseSensitive ? [] : ['-i']), ...(opts.wholeWord ? ['-w'] : []), '--exclude-dir=.git', '--exclude-dir=node_modules']
      if (opts.include) for (const g of opts.include.split(',').map((x) => x.trim()).filter(Boolean)) flags.push(`--include=${g.split('/').pop()}`)
      const r = await collect(command(root, ['grep', ...flags, '--', opts.query, '.']), 30_000)
      for (const line of r.stdout.toString('utf8').split('\n')) {
        const m = /^\.\/(.+?):(\d+):(.*)$/.exec(line)
        if (!m) continue
        if (matches.length >= max) {
          truncated = true
          break
        }
        const text = m[3]!
        const at = opts.caseSensitive ? text.indexOf(opts.query) : text.toLowerCase().indexOf(opts.query.toLowerCase())
        files.add(m[1]!)
        matches.push({ path: m[1]!, line: Number(m[2]), column: Math.max(0, at) + 1, text, matchStart: Math.max(0, at), matchEnd: Math.max(0, at) + (at >= 0 ? opts.query.length : 0) })
      }
      return { matches, files: files.size, truncated, durationMs: Date.now() - t0 }
    }
    out = far
  } else {
    if (!bin) throw new Error('Search is unavailable: the ripgrep program that Prism ships with was not found.')
    out = (await run(bin, args, root, 20_000)).out
  }
  for (const line of out.split('\n')) {
    if (!line) continue
    let j: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: Array<{ start: number; end: number }> } }
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (j.type !== 'match' || !j.data) continue
    const path = (j.data.path?.text ?? '').replace(/^\.[\\/]/, '').split('\\').join('/')
    const text = (j.data.lines?.text ?? '').replace(/\r?\n$/, '')
    files.add(path)
    for (const sm of j.data.submatches ?? []) {
      if (matches.length >= max) {
        truncated = true
        break
      }
      matches.push({ path, line: j.data.line_number ?? 0, column: sm.start + 1, text, matchStart: sm.start, matchEnd: sm.end })
    }
    if (truncated) break
  }
  return { matches, files: files.size, truncated, durationMs: Date.now() - t0 }
}

/** Files matching a glob, via ripgrep's file lister (respects .gitignore). */
export async function globFiles(root: string, pattern: string, limit = 500): Promise<string[]> {
  const args = ['--files', '--hidden', ...hiddenGlobs(), '-g', pattern, '.']
  let out: string
  if (placeOf(root).kind === 'ssh') {
    const far = await remoteRg(root, args, 30_000)
    if (far === null) {
      const r = await collect(command(root, ['find', '.', '-type', 'f', '-not', '-path', '*/.git/*', '-not', '-path', '*/node_modules/*']), 30_000)
      const re = globRe(pattern)
      return r.stdout
        .toString('utf8')
        .split('\n')
        .map((p) => p.replace(/^\.\//, ''))
        .filter((p) => p && re.test(p))
        .slice(0, limit)
    }
    out = far
  } else {
    const bin = rgPath()
    if (!bin) throw new Error('File matching is unavailable: the ripgrep program that Prism ships with was not found.')
    out = (await run(bin, args, root, 15_000)).out
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^\.[\\/]/, '').split('\\').join('/'))
    .slice(0, limit)
}

// ---------------------------------------------------------------- quick open (fuzzy)

export function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  if (!q) return 1
  let qi = 0
  let score = 0
  let streak = 0
  let lastIdx = -2
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) {
      const boundary = i === 0 || '/\\-_. '.includes(c[i - 1]!)
      streak = lastIdx === i - 1 ? streak + 1 : 0
      score += 10 + streak * 6 + (boundary ? 12 : 0)
      lastIdx = i
      qi++
    }
  }
  if (qi < q.length) return 0
  const base = candidate.split('/').pop() ?? candidate
  if (base.toLowerCase().includes(q)) score += 40
  if (base.toLowerCase().startsWith(q)) score += 30
  return score - candidate.length * 0.05
}

export function quickOpenRank(files: string[], query: string, limit = 50): string[] {
  if (!query.trim()) return files.slice(0, limit)
  const scored: Array<[number, string]> = []
  for (const f of files) {
    const s = fuzzyScore(query, f)
    if (s > 0) scored.push([s, f])
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length)
  return scored.slice(0, limit).map((x) => x[1])
}
