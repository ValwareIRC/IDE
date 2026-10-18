// Reviewing pull requests: GitHub's open pull requests for the project (through its API, with the user's token
// when they gave one), or the current branch against the main one, locally. Findings the user calls "not a
// problem" are kept as rules in .prism/review-rules.md and given to every later review.
import type { Workspace } from '../fs/workspace'
import { git } from '../git/git'

export interface PullRequest {
  number: number
  title: string
  author: string
  branch: string
  base: string
  url: string
  updatedAt: number
  draft: boolean
  headSha: string
}

export interface RepoRef {
  owner: string
  repo: string
}

const API = 'https://api.github.com'
export const RULES = '.prism/review-rules.md'

/** owner/repo from the project's origin when it is on GitHub. */
export async function githubRepo(root: string): Promise<RepoRef | null> {
  const r = await git(root, ['remote', 'get-url', 'origin'])
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(r.stdout.trim())
  return m ? { owner: m[1]!, repo: m[2]! } : null
}

function headers(token: string | null, accept = 'application/vnd.github+json'): Record<string, string> {
  return { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Prism', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

async function gh(path: string, token: string | null, init: RequestInit & { accept?: string } = {}): Promise<Response> {
  const r = await fetch(API + path, { ...init, headers: { ...headers(token, init.accept), ...(init.body ? { 'Content-Type': 'application/json' } : {}) } })
  if (!r.ok) {
    const text = await r.text()
    const why = r.status === 401 ? 'GitHub did not accept the token.' : r.status === 403 && /rate limit/i.test(text) ? 'GitHub\'s limit for requests without a token was reached; add a token.' : r.status === 404 ? 'GitHub says it is not there (a private repository needs a token).' : `GitHub said ${r.status}.`
    throw new Error(`${why} ${text.slice(0, 200)}`.trim())
  }
  return r
}

export async function whoAmI(token: string): Promise<string> {
  const r = await gh('/user', token)
  return ((await r.json()) as { login: string }).login
}

export async function listPulls(ref: RepoRef, token: string | null): Promise<PullRequest[]> {
  const r = await gh(`/repos/${ref.owner}/${ref.repo}/pulls?state=open&per_page=40&sort=updated&direction=desc`, token)
  const list = (await r.json()) as Array<{ number: number; title: string; user: { login: string }; head: { ref: string; sha: string }; base: { ref: string }; html_url: string; updated_at: string; draft: boolean }>
  return list.map((p) => ({ number: p.number, title: p.title, author: p.user.login, branch: p.head.ref, base: p.base.ref, url: p.html_url, updatedAt: Date.parse(p.updated_at), draft: p.draft, headSha: p.head.sha }))
}

export async function pullDiff(ref: RepoRef, n: number, token: string | null): Promise<string> {
  const r = await gh(`/repos/${ref.owner}/${ref.repo}/pulls/${n}`, token, { accept: 'application/vnd.github.diff' })
  return r.text()
}

/** The current branch's change against the main branch (what a pull request from it would hold). */
export async function branchDiff(root: string): Promise<{ diff: string; branch: string; base: string }> {
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  const candidates = ['origin/main', 'origin/master', 'main', 'master']
  let base = ''
  for (const c of candidates) {
    if (c === branch) continue
    if ((await git(root, ['rev-parse', '--verify', '--quiet', c])).ok) {
      base = c
      break
    }
  }
  if (!base) throw new Error('There is no main branch to compare this branch with.')
  const mb = (await git(root, ['merge-base', 'HEAD', base])).stdout.trim()
  const d = await git(root, ['diff', '--no-color', '--no-ext-diff', '-U3', mb || base])
  if (!d.ok) throw new Error(d.stderr.trim())
  return { diff: d.stdout, branch, base }
}

/** A finding as a comment on its line of the pull request (or on the pull request itself when the line is not part of it). */
export async function postFinding(ref: RepoRef, n: number, token: string, f: { file: string; line: number | null; body: string }, commitId: string): Promise<string> {
  if (f.file && f.line) {
    try {
      const r = await gh(`/repos/${ref.owner}/${ref.repo}/pulls/${n}/comments`, token, { method: 'POST', body: JSON.stringify({ body: f.body, commit_id: commitId, path: f.file, line: f.line, side: 'RIGHT' }) })
      return ((await r.json()) as { html_url: string }).html_url
    } catch {
      /* the line is not in the change: comment on the pull request instead */
    }
  }
  const r = await gh(`/repos/${ref.owner}/${ref.repo}/issues/${n}/comments`, token, { method: 'POST', body: JSON.stringify({ body: f.file ? `**${f.file}${f.line ? `:${f.line}` : ''}**\n\n${f.body}` : f.body }) })
  return ((await r.json()) as { html_url: string }).html_url
}

/** Comments on issues and pull requests since a time, newest last. */
export async function recentComments(ref: RepoRef, token: string, since: number): Promise<Array<{ id: number; body: string; author: string; url: string; at: number }>> {
  const r = await gh(`/repos/${ref.owner}/${ref.repo}/issues/comments?since=${new Date(since).toISOString()}&per_page=50&sort=created&direction=asc`, token)
  const list = (await r.json()) as Array<{ id: number; body: string; user: { login: string }; html_url: string; created_at: string }>
  return list.map((c) => ({ id: c.id, body: c.body ?? '', author: c.user.login, url: c.html_url, at: Date.parse(c.created_at) }))
}

/** The latest finished workflow runs that failed. */
export async function failedRuns(ref: RepoRef, token: string): Promise<Array<{ id: number; name: string; branch: string; url: string; title: string }>> {
  const r = await gh(`/repos/${ref.owner}/${ref.repo}/actions/runs?status=failure&per_page=10`, token)
  const j = (await r.json()) as { workflow_runs: Array<{ id: number; name: string; head_branch: string; html_url: string; display_title: string }> }
  return j.workflow_runs.map((x) => ({ id: x.id, name: x.name, branch: x.head_branch, url: x.html_url, title: x.display_title }))
}

export async function reviewRules(ws: Workspace): Promise<string> {
  return (await ws.exists(RULES)) ? (await ws.read(RULES)).content : ''
}

export async function addReviewRule(ws: Workspace, finding: string, reason: string): Promise<void> {
  const cur = await reviewRules(ws)
  const head = cur.trim() ? '' : '# Review rules\n\nFindings the team decided are not problems. Prism\'s reviews read this.\n\n'
  await ws.write(RULES, `${cur}${head}- Not a problem: ${finding.replace(/\s+/g, ' ').slice(0, 300)}${reason.trim() ? `\n  Because: ${reason.trim().replace(/\s+/g, ' ')}` : ''}\n`)
}
