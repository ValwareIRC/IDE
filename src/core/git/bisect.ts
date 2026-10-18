// Finding the commit that broke something. A reproduction script (exit 0: it
// works, anything else: it is broken) is run against older versions of the
// project in a temporary checkout of its own, so the user's files never move.
// If no good commit is given, Prism looks back 1, 2, 4, 8… commits for one
// where it works. Then git bisect narrows it down (merges and all).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { placeOf } from '@shared/place'
import { git } from './git'

export interface BisectResult {
  commit: string
  subject: string
  author: string
  date: string
  stat: string
  diff: string
  good: string
  steps: number
}

const STEP_TIMEOUT = 120_000

function run(cmd: string, cwd: string, signal: AbortSignal): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: '1', NO_COLOR: '1' } })
    let out = ''
    const take = (d: Buffer): void => {
      if (out.length < 8000) out += d.toString('utf8')
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const kill = (): void => {
      try {
        child.kill()
      } catch {
        /* gone */
      }
    }
    const timer = setTimeout(kill, STEP_TIMEOUT)
    signal.addEventListener('abort', kill, { once: true })
    child.on('error', (e) => resolve({ code: 127, out: e.message }))
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', kill)
      resolve({ code: code ?? 1, out })
    })
  })
}

export async function findBreakingCommit(o: {
  root: string
  /** The reproduction script, workspace-relative; it is copied into each version tried. */
  script: string
  /** How to run it; {script} is replaced by its path. */
  command: string
  good?: string
  bad?: string
  signal: AbortSignal
  progress(line: string): void
}): Promise<BisectResult> {
  if (placeOf(o.root).kind !== 'local') throw new Error('Finding the breaking commit works for folders on this computer only, for now.')
  const scriptText = await readFile(join(o.root, o.script))
  const bad = o.bad?.trim() || 'HEAD'
  const badSha = (await git(o.root, ['rev-parse', `${bad}^{commit}`])).stdout.trim()
  if (!badSha) throw new Error(`${bad} is not a commit in this repository.`)

  const dir = await mkdtemp(join(tmpdir(), 'prism-bisect-'))
  const wt = join(dir, 'tree')
  let steps = 0
  try {
    const add = await git(o.root, ['worktree', 'add', '--detach', wt, badSha], 120_000)
    if (!add.ok) throw new Error(`Could not make a checkout to test in: ${add.stderr.trim()}`)
    // the project's installed packages, shared rather than installed again for every version
    for (const deps of ['node_modules', '.venv', 'venv']) {
      if (existsSync(join(o.root, deps)) && !existsSync(join(wt, deps))) await symlink(join(o.root, deps), join(wt, deps), 'junction').catch(() => {})
    }

    /** Check out a commit in the test checkout and run the reproduction there: true when it works. Null: it could not be tested. */
    const test = async (sha: string): Promise<boolean | null> => {
      if (o.signal.aborted) throw new Error('Stopped.')
      const co = await git(wt, ['checkout', '--detach', '--force', '-q', sha], 60_000)
      if (!co.ok) return null
      await mkdir(dirname(join(wt, o.script)), { recursive: true })
      await writeFile(join(wt, o.script), scriptText)
      steps++
      const r = await run(o.command.split('{script}').join(o.script), wt, o.signal)
      const subject = (await git(o.root, ['log', '-1', '--format=%s', sha])).stdout.trim()
      o.progress(`${sha.slice(0, 8)} ${subject.slice(0, 60)}: ${r.code === 0 ? 'works' : r.code === 125 ? 'cannot tell' : 'broken'}\n`)
      return r.code === 125 ? null : r.code === 0
    }

    if ((await test(badSha)) !== false) throw new Error(`The reproduction does not fail at ${bad}: it should exit with an error while the problem is there. Check the script.`)

    let goodSha = o.good?.trim() ? (await git(o.root, ['rev-parse', `${o.good.trim()}^{commit}`])).stdout.trim() : ''
    if (o.good?.trim() && !goodSha) throw new Error(`${o.good} is not a commit in this repository.`)
    if (goodSha) {
      if ((await test(goodSha)) !== true) throw new Error(`The reproduction does not pass at ${o.good}, so that is not a version where it worked.`)
    } else {
      // look back until it works
      for (let back = 1; back <= 256 && !goodSha; back *= 2) {
        const sha = (await git(o.root, ['rev-parse', '-q', '--verify', `${badSha}~${back}^{commit}`])).stdout.trim()
        if (!sha) break
        if ((await test(sha)) === true) goodSha = sha
      }
      if (!goodSha) throw new Error('Could not find an older version where it works (looked back up to 256 commits). Give a version where it worked.')
    }

    // git bisect in the test checkout, marking each version from the reproduction's answer
    await git(wt, ['bisect', 'start', badSha, goodSha])
    let first = ''
    for (let i = 0; i < 64 && !first; i++) {
      const cur = (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim()
      const ok = await test(cur)
      const mark = await git(wt, ['bisect', ok === null ? 'skip' : ok ? 'good' : 'bad'], 60_000)
      // newer git quotes the term: is the first 'bad' commit
      const m = /^([0-9a-f]{40}) is the first '?bad'? commit/m.exec(mark.stdout)
      if (m) first = m[1]!
      else if (/only skipped commits left/i.test(mark.stdout)) throw new Error(`It is one of several commits that could not be tested:\n${mark.stdout.trim().slice(0, 2000)}`)
    }
    await git(wt, ['bisect', 'reset'])
    if (!first) throw new Error('git bisect did not settle on a commit.')

    const meta = (await git(o.root, ['log', '-1', '--format=%s%x1f%an%x1f%ad', '--date=short', first])).stdout.trim().split('\x1f')
    const stat = (await git(o.root, ['show', '--stat', '--format=', first])).stdout.trim()
    const diff = (await git(o.root, ['show', '--format=', first], 60_000)).stdout
    return { commit: first, subject: meta[0] ?? '', author: meta[1] ?? '', date: meta[2] ?? '', stat, diff: diff.length > 30_000 ? `${diff.slice(0, 30_000)}\n… (cut)` : diff, good: goodSha, steps }
  } finally {
    await git(o.root, ['worktree', 'remove', '--force', wt], 60_000).catch(() => null)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await git(o.root, ['worktree', 'prune']).catch(() => null)
  }
}
