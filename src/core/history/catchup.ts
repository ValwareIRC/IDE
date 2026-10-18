// What happened while the user was away: sessions that finished, failed or are
// waiting for them, automation runs, and every file the agent changed, in the
// order it changed them (for a guided walk through the changes).
import type { AutomationRun, CatchUp, Session, SystemItem, AssistantItem } from '@shared/types'
import type { Repo } from '../store/repo'
import type { Workspace } from '../fs/workspace'

const short = (s: string, n: number): string => {
  // a one-line summary: Markdown marks would only show as clutter
  const t = s.replace(/[*_`#>|]+/g, '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export async function catchUp(repo: Repo, ws: Workspace, since: number, status: (id: string) => Session['status'], runs: AutomationRun[]): Promise<CatchUp> {
  const sessions: CatchUp['sessions'] = []
  for (const s of repo.listSessions(ws.root)) {
    if (s.updatedAt <= since) continue
    const items = repo.listItems(s.id).filter((i) => i.ts > since)
    if (!items.length && status(s.id) === 'idle') continue
    const answer = [...items].reverse().find((i): i is AssistantItem => i.kind === 'assistant' && !!i.text.trim())
    const error = [...items].reverse().find((i): i is SystemItem => i.kind === 'system' && i.subkind === 'error')
    sessions.push({ id: s.id, title: s.title, status: status(s.id), updatedAt: s.updatedAt, lastText: answer ? short(answer.text, 400) : null, error: error ? short(error.text, 300) : null, steps: items.filter((i) => i.kind === 'tool').length })
  }
  // every file changed since, first change first; "before" is how it was when the user left
  const seen = new Map<string, CatchUp['files'][number]>()
  for (const s of sessions) {
    for (const v of repo.listFileVersions(s.id)) {
      if (v.ts <= since) continue
      const had = seen.get(v.path)
      if (had) {
        if (!had.sessions.includes(s.title)) had.sessions.push(s.title)
        continue
      }
      seen.set(v.path, { path: v.path, before: v.before, ts: v.ts, sessionId: s.id, sessions: [s.title], request: null })
      const req = v.turnItemId ? repo.getItem(s.id, v.turnItemId) : null
      if (req?.kind === 'user') seen.get(v.path)!.request = short(req.text, 200)
    }
  }
  const files = [...seen.values()].sort((a, b) => a.ts - b.ts)
  return {
    since,
    sessions: sessions.sort((a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting') || b.updatedAt - a.updatedAt),
    runs: runs.filter((r) => r.startedAt > since).slice(0, 40),
    files
  }
}
