// Reading the file history back (rows written by recorder.ts): a session's
// timeline step by step, the project as it was at any step, which request and
// reasoning put a line where it is, and undoing one request's changes while
// keeping everything done since.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentLineRun, AssistantItem, FileVersion, HistoryStep, HistoryTimeline, LineOrigin, RefactorPlan, ToolItem, TranscriptItem, UserItem } from '@shared/types'
import type { Repo } from '../store/repo'
import type { Workspace } from '../fs/workspace'

const lines = (s: string | null): string[] => (s === null ? [] : s.split(/\r?\n/))

function counts(before: string | null, after: string | null): { added: number; removed: number } {
  const a = lines(before)
  const b = lines(after)
  const seen = new Map<string, number>()
  for (const l of a) seen.set(l, (seen.get(l) ?? 0) + 1)
  let same = 0
  for (const l of b) {
    const n = seen.get(l) ?? 0
    if (n > 0) {
      same++
      seen.set(l, n - 1)
    }
  }
  return { added: b.length - same, removed: a.length - same }
}

function short(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** The steps of a session: every tool call in order, with the files each one changed. */
export function timeline(repo: Repo, sessionId: string): HistoryTimeline {
  const items = repo.listItems(sessionId)
  const versions = repo.listFileVersions(sessionId)
  const byCall = new Map<string, FileVersion[]>()
  const loose: FileVersion[] = []
  for (const v of versions) {
    if (v.callId) byCall.set(v.callId, [...(byCall.get(v.callId) ?? []), v])
    else loose.push(v)
  }
  const steps: HistoryStep[] = []
  let turn: UserItem | null = null
  const used = new Set<number>()
  const change = (v: FileVersion): HistoryStep['changes'][number] => {
    used.add(v.id)
    return { versionId: v.id, path: v.path, op: v.before === null ? 'created' : v.after === null ? 'deleted' : 'changed', ...counts(v.before, v.after) }
  }
  for (const it of items) {
    if (it.kind === 'user') turn = it
    if (it.kind !== 'tool') continue
    const own = byCall.get(it.callId) ?? []
    steps.push({
      index: steps.length,
      callId: it.callId,
      tool: it.name,
      summary: summaryOf(it),
      ts: it.ts,
      turnItemId: turn?.id ?? null,
      output: it.name === 'shell' ? short(it.content, 600) : null,
      isError: it.isError,
      changes: own.map(change)
    })
  }
  // changes that came without a step of their own (some outside tools): placed by time
  for (const v of loose.concat(versions.filter((x) => x.callId && !used.has(x.id)))) {
    if (used.has(v.id)) continue
    steps.push({ index: 0, callId: v.callId, tool: 'change', summary: v.path, ts: v.ts, turnItemId: v.turnItemId, output: null, isError: false, changes: [change(v)] })
  }
  steps.sort((a, b) => a.ts - b.ts)
  steps.forEach((s, i) => (s.index = i))
  const turns = items.filter((i): i is UserItem => i.kind === 'user').map((u) => ({ id: u.id, text: short(u.text, 160), ts: u.ts, changed: versions.some((v) => v.turnItemId === u.id) }))
  return { steps, turns }
}

function summaryOf(it: ToolItem): string {
  const a = it.args ?? {}
  const pick = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '')
  if (it.name === 'shell') return short(pick('command'), 120)
  return short([it.name, pick('path') || pick('pattern') || pick('query') || pick('url')].filter(Boolean).join(' '), 120)
}

/** Every file the session changed, as it was right after step `index` (-1: before the session changed anything). */
export function stateAt(repo: Repo, sessionId: string, index: number, only?: string): Array<{ path: string; content: string | null }> {
  const tl = timeline(repo, sessionId)
  const versions = new Map(repo.listFileVersions(sessionId).map((v) => [v.id, v]))
  const out = new Map<string, string | null>()
  const first = new Map<string, string | null>()
  for (const s of tl.steps) {
    for (const c of s.changes) {
      if (only && c.path !== only) continue
      const v = versions.get(c.versionId)!
      if (!first.has(c.path)) first.set(c.path, v.before)
      if (s.index <= index) out.set(c.path, v.after)
    }
  }
  return [...first.keys()].map((p) => ({ path: p, content: out.has(p) ? out.get(p)! : first.get(p)! }))
}

/** Which request put this line in this file, and why. Matched by the line's text, so it survives lines moving. */
export function lineOrigin(repo: Repo, workspace: string, path: string, line: string): LineOrigin | null {
  const want = line.trim()
  // lines like "}" or "" say nothing about where they came from
  if (want.length < 4 || !/[A-Za-z0-9]/.test(want)) return null
  for (const v of repo.fileVersionsOf(workspace, path)) {
    const after = lines(v.after).filter((l) => l.trim() === want).length
    const before = lines(v.before).filter((l) => l.trim() === want).length
    if (after <= before) continue
    const session = repo.getSession(v.sessionId)
    const items = repo.listItems(v.sessionId)
    const request = v.turnItemId ? (items.find((i) => i.id === v.turnItemId) as UserItem | undefined) : undefined
    const reason = reasonFor(items, v.callId)
    return {
      sessionId: v.sessionId,
      sessionTitle: session?.title ?? 'A session',
      turnItemId: v.turnItemId,
      request: request ? short(request.text, 300) : null,
      reason,
      model: session?.model?.modelId ?? null,
      ts: v.ts,
      versionId: v.id
    }
  }
  return null
}

/**
 * Every line of the file as it is now that the agent wrote, grouped into runs, newest change first: a line is
 * the agent's when a change of its added that text (so lines the user rewrote since are not).
 */
export function agentLines(repo: Repo, workspace: string, path: string, content: string): AgentLineRun[] {
  const versions = repo.fileVersionsOf(workspace, path, 200)
  if (!versions.length) return []
  // the text each change added, newest change first
  const added = versions.map((v) => {
    const count = new Map<string, number>()
    for (const l of lines(v.after)) count.set(l.trim(), (count.get(l.trim()) ?? 0) + 1)
    for (const l of lines(v.before)) count.set(l.trim(), (count.get(l.trim()) ?? 0) - 1)
    return { v, added: new Set([...count].filter(([t, n]) => n > 0 && t.length >= 4 && /[A-Za-z0-9]/.test(t)).map(([t]) => t)) }
  })
  const titles = new Map<string, string>()
  const titleOf = (id: string): string => {
    if (!titles.has(id)) titles.set(id, repo.getSession(id)?.title ?? 'A session')
    return titles.get(id)!
  }
  const runs: AgentLineRun[] = []
  lines(content).forEach((l, i) => {
    const t = l.trim()
    const hit = t ? added.find((a) => a.added.has(t)) : undefined
    const last = runs[runs.length - 1]
    if (!hit) {
      // blank lines and lone brackets inside a run of the same change stay in it
      if (last && last.to === i && (!t || !/[A-Za-z0-9]/.test(t))) last.to = i + 1
      return
    }
    if (last && last.versionId === hit.v.id && last.to >= i) last.to = i + 1
    else runs.push({ from: i + 1, to: i + 1, versionId: hit.v.id, sessionId: hit.v.sessionId, sessionTitle: titleOf(hit.v.sessionId), turnItemId: hit.v.turnItemId, ts: hit.v.ts })
  })
  // a run never ends on blank lines it picked up
  const all = lines(content)
  for (const r of runs) while (r.to > r.from && !/[A-Za-z0-9]/.test(all[r.to - 1] ?? '')) r.to--
  return runs
}

/** What the agent said just before the call that made the change: usually its reason for making it. */
function reasonFor(items: TranscriptItem[], callId: string | null): string | null {
  if (!callId) return null
  const at = items.findIndex((i) => i.kind === 'assistant' && i.toolCalls.some((c) => c.id === callId))
  for (let i = at; i >= 0 && i > at - 6; i--) {
    const it = items[i]
    if (it?.kind === 'user') break
    if (it?.kind === 'assistant') {
      const a = it as AssistantItem
      const text = (a.text || a.reasoning || '').trim()
      if (text) return short(text, 500)
    }
  }
  return null
}

/** Three-way merge with git: the change from base to other, applied to ours. */
async function mergeFile(ours: string, base: string, other: string): Promise<{ text: string; conflicts: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'prism-merge-'))
  try {
    const [o, b, t] = ['ours', 'base', 'other'].map((n) => join(dir, n))
    await Promise.all([writeFile(o!, ours), writeFile(b!, base), writeFile(t!, other)])
    return await new Promise((resolve, reject) => {
      execFile('git', ['merge-file', '-p', '-L', 'now', '-L', 'after that request', '-L', 'without that request', o!, b!, t!], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 0
        if (err && (code < 0 || code > 127)) return reject(err)
        resolve({ text: stdout, conflicts: code })
      })
    })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The changes that take one request's work out again, keeping what was done since. Shown for review before anything is written. */
export async function undoRequestPlan(repo: Repo, ws: Workspace, sessionId: string, turnItemId: string): Promise<RefactorPlan> {
  const all = repo.listFileVersions(sessionId).filter((v) => v.turnItemId === turnItemId)
  const request = repo.getItem(sessionId, turnItemId) as UserItem | null
  const paths = [...new Set(all.map((v) => v.path))]
  const files: RefactorPlan['files'] = []
  const notes: string[] = []
  for (const path of paths) {
    const mine = all.filter((v) => v.path === path)
    const was = mine[0]!.before
    const made = mine[mine.length - 1]!.after
    let now: string | null = null
    try {
      now = (await ws.read(path)).content
    } catch {
      now = null
    }
    if (now === was) continue
    if (now === made) {
      files.push({ path, before: now, after: was })
      continue
    }
    if (now === null) {
      notes.push(`${path} has been deleted since; left as it is.`)
      continue
    }
    if (was === null || made === null) {
      notes.push(`${path} was ${was === null ? 'created' : 'deleted'} by that request and has changed since; check it by hand.`)
      continue
    }
    const m = await mergeFile(now, made, was).catch(() => null)
    if (!m) {
      notes.push(`${path} could not be worked out (is git installed?).`)
      continue
    }
    files.push({ path, before: now, after: m.text })
    if (m.conflicts) notes.push(`${path}: ${m.conflicts} place${m.conflicts === 1 ? '' : 's'} where later work touched the same lines, marked with <<<<<<< in the file.`)
  }
  return {
    title: `Undo: ${short(request?.text ?? 'that request', 60)}`,
    files,
    byMeaning: true,
    note: files.length ? (notes.length ? notes.join(' ') : 'Everything done since is kept.') : notes.join(' ') || 'Nothing to undo: those changes are already gone.'
  }
}
