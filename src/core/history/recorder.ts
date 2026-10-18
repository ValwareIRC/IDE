// Records every change the agent makes to a file, one row per file per tool
// call: what it was before, what it is after, which request and which step.
// Both engines report changes as 'file-touched' events (with the call's id);
// the host passes them here. The "before" of a file's first change in a turn
// is the turn's checkpoint copy; after that, the previous row's "after".
import type { Repo } from '../store/repo'
import type { Workspace } from '../fs/workspace'

/** Files bigger than this are not kept (the checkpoint still has them for rewinding). */
const MAX_BYTES = 4 * 1024 * 1024

export class HistoryRecorder {
  /** The user message each session's current turn belongs to. */
  private turns = new Map<string, string>()
  /** Writes one session's rows in order, even though reading the files is asynchronous. */
  private queues = new Map<string, Promise<void>>()

  constructor(private repo: Repo, private workspaceOf: (sessionId: string) => Workspace) {}

  turnStarted(sessionId: string, userItemId: string): void {
    this.turns.set(sessionId, userItemId)
  }

  changed(sessionId: string, path: string, callId: string | null): void {
    const prev = this.queues.get(sessionId) ?? Promise.resolve()
    const next = prev.then(() => this.record(sessionId, path, callId)).catch(() => {})
    this.queues.set(sessionId, next)
  }

  /** Resolves once everything reported so far is written. */
  settled(sessionId: string): Promise<void> {
    return this.queues.get(sessionId) ?? Promise.resolve()
  }

  private async record(sessionId: string, path: string, callId: string | null): Promise<void> {
    const ws = this.workspaceOf(sessionId)
    const turn = this.turns.get(sessionId) ?? null
    const after = await ws.readRaw(path).catch(() => null)
    if (after && after.length > MAX_BYTES) return
    let before: Buffer | null
    const last = this.repo.lastVersionInTurn(sessionId, turn, path)
    if (last) before = last.after === null ? null : Buffer.from(last.after, 'utf8')
    else before = this.fromCheckpoint(sessionId, turn, path)
    if (before && before.length > MAX_BYTES) return
    if (before && after && before.equals(after)) return
    if (!before && !after) return
    this.repo.addFileVersion({ sessionId, workspace: ws.root, turnItemId: turn, callId, path, before, after })
  }

  /** The file as it was when this turn first touched it. */
  private fromCheckpoint(sessionId: string, turn: string | null, path: string): Buffer | null {
    const cps = this.repo.listCheckpoints(sessionId).filter((c) => c.turnItemId === turn && c.files.includes(path))
    const cp = cps[cps.length - 1]
    if (!cp) return null
    return this.repo.getCheckpointFiles(cp.id).find((f) => f.path === path)?.content ?? null
  }
}
