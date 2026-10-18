// A living spec: a plain-English SPEC.md (or .prism/spec.md) kept in step with
// the code. Prism remembers the version of the spec the code last matched.
// When the user edits the spec, the difference becomes a request to change the
// code; when the agent changes code, a quick model call checks the changes
// against the spec's sections and flags where they no longer agree.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewFile, SpecSection, SpecState } from '@shared/types'
import type { Workspace } from '../fs/workspace'
import { ask, firstJson } from '../agent/ask'
import type { ResolvedModel } from '../agent/engine'

export const SPEC_FILES = ['SPEC.md', 'spec.md', '.prism/spec.md']

interface Stored {
  /** The spec as the code last matched it. */
  synced: string | null
  results: Record<string, { status: 'ok' | 'drift'; note: string; ts: number; sessionId: string | null }>
}

/** Split Markdown into sections at its headings; text before the first heading is "Overview". */
export function sections(text: string): Array<{ title: string; body: string }> {
  const out: Array<{ title: string; body: string }> = []
  let cur = { title: 'Overview', body: '' }
  for (const line of text.split(/\r?\n/)) {
    const h = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) {
      if (cur.body.trim() || cur.title !== 'Overview') out.push(cur)
      cur = { title: h[1]!, body: '' }
    } else cur.body += `${line}\n`
  }
  if (cur.body.trim() || cur.title !== 'Overview') out.push(cur)
  return out
}

export class SpecKeeper {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private file(root: string): string {
    return join(this.dir, `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`)
  }

  private load(root: string): Stored {
    try {
      const v = JSON.parse(readFileSync(this.file(root), 'utf8')) as Stored
      return { synced: typeof v.synced === 'string' ? v.synced : null, results: v.results && typeof v.results === 'object' ? v.results : {} }
    } catch {
      return { synced: null, results: {} }
    }
  }

  private save(root: string, s: Stored): void {
    writeFileSync(this.file(root), JSON.stringify(s, null, 2), 'utf8')
  }

  async find(ws: Workspace): Promise<{ path: string; text: string } | null> {
    for (const p of SPEC_FILES) {
      try {
        const f = await ws.read(p)
        if (!f.binary) return { path: p, text: f.content }
      } catch {
        /* not this one */
      }
    }
    return null
  }

  /** The spec, its sections with what is known about each, and what changed since the code last matched it. */
  async state(ws: Workspace): Promise<SpecState | null> {
    const spec = await this.find(ws)
    if (!spec) return null
    const st = this.load(ws.root)
    // the first time a spec is seen, the code is taken to match it
    if (st.synced === null) {
      st.synced = spec.text
      this.save(ws.root, st)
    }
    const now = sections(spec.text)
    const was = sections(st.synced)
    const list: SpecSection[] = now.map((s) => {
      const old = was.find((w) => w.title === s.title)
      const r = st.results[s.title]
      return { title: s.title, body: s.body.trim(), edited: !old ? 'added' : old.body.trim() !== s.body.trim() ? 'changed' : null, status: r?.status ?? null, note: r?.note ?? null, checkedAt: r?.ts ?? null }
    })
    const removed = was.filter((w) => !now.some((s) => s.title === w.title)).map((w) => w.title)
    return { path: spec.path, sections: list, removed, pendingEdits: list.some((s) => s.edited) || removed.length > 0 }
  }

  /** The code now matches the spec as it is. */
  async markSynced(ws: Workspace): Promise<void> {
    const spec = await this.find(ws)
    if (!spec) return
    const st = this.load(ws.root)
    st.synced = spec.text
    this.save(ws.root, st)
  }

  /** What the user changed in the spec since the code last matched it, as a request to the agent. */
  async editRequest(ws: Workspace): Promise<string | null> {
    const s = await this.state(ws)
    if (!s?.pendingEdits) return null
    const parts = s.sections
      .filter((x) => x.edited)
      .map((x) => `## ${x.title} (${x.edited === 'added' ? 'new section' : 'changed'})\n${x.body}`)
    if (s.removed.length) parts.push(`Removed from the spec: ${s.removed.join(', ')}`)
    return `I changed the project's spec (${s.path}). Make the code match it. Here is what changed since the code last matched:\n\n${parts.join('\n\n')}\n\nRead ${s.path} in full for context. Change only what these edits call for, run the tests, and say what you did for each section.`
  }

  /** After the agent changed code: do the changes still agree with the spec? Results are kept per section. */
  async check(ws: Workspace, model: ResolvedModel, changes: ReviewFile[], sessionId: string | null): Promise<Array<{ title: string; note: string }>> {
    const spec = await this.find(ws)
    if (!spec || !changes.length) return []
    const secs = sections(spec.text)
    const diff = changes
      .slice(0, 12)
      .map((c) => `### ${c.path}\nBEFORE:\n${(c.before ?? '(new file)').slice(0, 6000)}\nAFTER:\n${(c.after ?? '(deleted)').slice(0, 6000)}`)
      .join('\n\n')
    const { text } = await ask(
      model,
      'You compare code changes with a project specification. For each spec section the changes touch, say whether the code after the change still does what the section says. Only judge sections the changes are relevant to. Reply with JSON only: {"sections":[{"title":"<exact section title>","status":"ok"|"drift","note":"<one sentence; for drift, what differs>"}]}',
      `SPECIFICATION (${spec.path}):\n${secs.map((s) => `## ${s.title}\n${s.body.trim()}`).join('\n\n')}\n\nCHANGES:\n${diff}`,
      1200
    )
    const r = firstJson<{ sections?: Array<{ title?: string; status?: string; note?: string }> }>(text)
    const st = this.load(ws.root)
    const drift: Array<{ title: string; note: string }> = []
    for (const s of r?.sections ?? []) {
      if (!s.title || !secs.some((x) => x.title === s.title)) continue
      const status = s.status === 'drift' ? 'drift' : 'ok'
      st.results[s.title] = { status, note: String(s.note ?? '').slice(0, 400), ts: Date.now(), sessionId }
      if (status === 'drift') drift.push({ title: s.title, note: String(s.note ?? '') })
    }
    this.save(ws.root, st)
    return drift
  }

  /** The user dealt with a section's drift (updated the spec or the code). */
  clear(root: string, title: string): void {
    const st = this.load(root)
    delete st.results[title]
    this.save(root, st)
  }

  exists(root: string): boolean {
    return existsSync(this.file(root))
  }
}
