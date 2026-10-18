// A session as one file, to carry on elsewhere: the conversation, what the user
// set for it (pinned files, instructions, skills), every change it made to the
// project's files, and the pictures it refers to. Claude Code's own copy of a
// Claude Agent conversation stays behind; the next turn there starts from a
// summary of the transcript, as when a session switches model.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FileVersion, ModelRef, PermissionMode, RefactorPlan, ReviewFile, TranscriptItem } from '@shared/types'
import type { Repo } from '../store/repo'
import type { Workspace } from '../fs/workspace'

export const SESSION_FILE_KIND = 'prism-session'

export interface SessionFile {
  kind: typeof SESSION_FILE_KIND
  version: 1
  exportedAt: number
  project: string
  session: { title: string; model: ModelRef | null; mode: PermissionMode }
  items: TranscriptItem[]
  extras: { pins: string[]; instructions: string; skills: string[] }
  changes: Array<Omit<FileVersion, 'id' | 'sessionId'>>
  /** Pictures the conversation shows, by their stored name. */
  pictures: Record<string, string>
}

/** Every stored picture an item refers to. */
function picturesOf(items: TranscriptItem[]): string[] {
  const out = new Set<string>()
  for (const it of items) {
    if (it.kind === 'user') for (const a of it.attachments) out.add(basename(a.path))
    const meta = (it as { meta?: Record<string, unknown> | null }).meta
    if (meta) {
      for (const k of ['images']) if (Array.isArray(meta[k])) for (const n of meta[k] as unknown[]) if (typeof n === 'string') out.add(n)
      for (const k of ['before', 'after']) if (typeof meta[k] === 'string' && /\.(png|jpe?g|webp|gif)$/i.test(meta[k] as string)) out.add(meta[k] as string)
    }
  }
  return [...out]
}

export async function exportSession(repo: Repo, attachDir: string, sessionId: string): Promise<SessionFile> {
  const s = repo.getSession(sessionId)
  if (!s) throw new Error('That session no longer exists.')
  const items = repo.listItems(sessionId)
  const extras = repo.getSessionExtras(sessionId)
  const pictures: Record<string, string> = {}
  for (const name of picturesOf(items)) {
    const p = join(attachDir, basename(name))
    if (existsSync(p)) pictures[name] = (await readFile(p)).toString('base64')
  }
  return {
    kind: SESSION_FILE_KIND,
    version: 1,
    exportedAt: Date.now(),
    project: basename(s.workspace),
    session: { title: s.title, model: s.model, mode: s.mode },
    items,
    extras: { pins: extras.pins, instructions: extras.instructions, skills: extras.skills ?? [] },
    changes: repo.listFileVersions(sessionId).map(({ id: _id, sessionId: _s, ...v }) => v),
    pictures
  }
}

/** Make the session here. Returns it, and the changes it made as a change set to bring them into this project. */
export async function importSession(repo: Repo, ws: Workspace, attachDir: string, file: SessionFile, modelOk: (m: ModelRef) => boolean): Promise<{ sessionId: string; plan: RefactorPlan | null }> {
  if (file?.kind !== SESSION_FILE_KIND || !Array.isArray(file.items)) throw new Error('That file is not a Prism session.')
  const model = file.session?.model && modelOk(file.session.model) ? file.session.model : null
  const s = repo.createSession(ws.root, `${file.session?.title ?? 'A session'} (brought in)`, model, file.session?.mode ?? 'ask')
  try {
    // pictures keep their names, so the transcript's references still work
    for (const [name, b64] of Object.entries(file.pictures ?? {})) {
      const p = join(attachDir, basename(name))
      if (!existsSync(p)) await writeFile(p, Buffer.from(b64, 'base64'))
    }
    // new ids, so a session can be brought into the same Prism it came from; links between items follow
    const ids = new Map(file.items.map((it) => [it.id, randomUUID()]))
    for (const it of file.items) {
      const item = it.kind === 'user' ? { ...it, attachments: it.attachments.map((a) => ({ ...a, path: join(attachDir, basename(a.path)) })) } : it
      const meta = (item as { meta?: Record<string, unknown> | null }).meta
      const relinked = meta && typeof meta['forItem'] === 'string' ? { meta: { ...meta, forItem: ids.get(meta['forItem'] as string) ?? meta['forItem'] } } : {}
      repo.appendItem(s.id, { ...item, ...relinked, id: ids.get(it.id) ?? randomUUID() } as TranscriptItem)
    }
    repo.setSessionExtras(s.id, { pins: file.extras?.pins ?? [], instructions: file.extras?.instructions ?? '', skills: file.extras?.skills ?? [] })
    for (const v of file.changes ?? []) {
      repo.addFileVersion({ sessionId: s.id, workspace: ws.root, turnItemId: v.turnItemId ? (ids.get(v.turnItemId) ?? null) : null, callId: v.callId, path: v.path, before: v.before === null ? null : Buffer.from(v.before, 'utf8'), after: v.after === null ? null : Buffer.from(v.after, 'utf8') })
    }
  } catch (e) {
    // a half-made session is no use to anyone
    repo.deleteSession(s.id)
    throw e
  }
  // where the session left each file, against how it is here
  const last = new Map<string, string | null>()
  for (const v of file.changes ?? []) last.set(v.path, v.after)
  const files: ReviewFile[] = []
  for (const [path, after] of last) {
    let now: string | null = null
    try {
      now = (await ws.read(path)).content
    } catch {
      now = null
    }
    if (now !== after) files.push({ path, before: now, after })
  }
  return {
    sessionId: s.id,
    plan: files.length ? { title: `Bring in what "${file.session?.title ?? 'the session'}" changed`, files, byMeaning: true, note: `The session left these files like this in ${file.project}. Apply what you want here; nothing is written until you do.` } : null
  }
}
