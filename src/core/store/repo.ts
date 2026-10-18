import { randomUUID } from 'node:crypto'
import type {
  AdapterId,
  AuthConfig,
  Checkpoint,
  Endpoint,
  ModelInfo,
  ModelMeta,
  ModelRef,
  PermissionMode,
  Session,
  Effort,
  SessionExtras,
  TranscriptItem,
  Usage,
  UsageSummary, SpendDay, FileVersion } from '@shared/types'
import type { Db } from './db'
import { knownMeta } from '../models/known'

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const now = (): number => Date.now()

function parse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------- endpoints

interface EndpointRow {
  id: string
  name: string
  adapter: string
  base_url: string
  auth: string
  extra_headers: string
  enabled: number
  created_at: number
  probed_at: number | null
  probe_latency_ms: number | null
  probe_error: string | null
}

export class Repo {
  constructor(
    private db: Db,
    private hasKey: (id: string) => boolean
  ) {}

  private rowToEndpoint(r: EndpointRow): Endpoint {
    return {
      id: r.id,
      name: r.name,
      adapter: r.adapter as AdapterId,
      baseUrl: r.base_url,
      auth: parse<AuthConfig>(r.auth, { kind: 'bearer' }),
      extraHeaders: parse<Record<string, string>>(r.extra_headers, {}),
      enabled: r.enabled === 1,
      createdAt: r.created_at,
      probedAt: r.probed_at,
      probeLatencyMs: r.probe_latency_ms,
      probeError: r.probe_error,
      hasKey: this.hasKey(r.id)
    }
  }

  listEndpoints(): Endpoint[] {
    const rows = this.db.prepare('SELECT * FROM endpoints ORDER BY created_at ASC').all() as unknown as EndpointRow[]
    return rows.map((r) => this.rowToEndpoint(r))
  }

  getEndpoint(id: string): Endpoint | null {
    const r = this.db.prepare('SELECT * FROM endpoints WHERE id = ?').get(id) as unknown as EndpointRow | undefined
    return r ? this.rowToEndpoint(r) : null
  }

  upsertEndpoint(e: {
    id: string
    name: string
    adapter: AdapterId
    baseUrl: string
    auth: AuthConfig
    extraHeaders: Record<string, string>
  }): void {
    this.db
      .prepare(
        `INSERT INTO endpoints (id, name, adapter, base_url, auth, extra_headers, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, adapter = excluded.adapter, base_url = excluded.base_url,
           auth = excluded.auth, extra_headers = excluded.extra_headers`
      )
      .run(e.id, e.name, e.adapter, e.baseUrl, JSON.stringify(e.auth), JSON.stringify(e.extraHeaders), now())
  }

  deleteEndpoint(id: string): void {
    this.db.prepare('DELETE FROM models WHERE endpoint_id = ?').run(id)
    this.db.prepare('DELETE FROM endpoints WHERE id = ?').run(id)
  }

  recordProbe(id: string, latencyMs: number, error: string | null): void {
    this.db.prepare('UPDATE endpoints SET probed_at = ?, probe_latency_ms = ?, probe_error = ? WHERE id = ?').run(now(), latencyMs, error, id)
  }

  // ---------------------------------------------------------------- models

  replaceModels(endpointId: string, modelIds: string[]): void {
    const keep = new Set(modelIds.map((m) => `${endpointId}::${m}`))
    const existing = this.db.prepare('SELECT key FROM models WHERE endpoint_id = ?').all(endpointId) as unknown as Array<{ key: string }>
    const del = this.db.prepare('DELETE FROM models WHERE key = ?')
    const ins = this.db.prepare(
      `INSERT INTO models (key, endpoint_id, model_id, favorite, meta, seen_at) VALUES (?, ?, ?, 0, '{}', ?)
       ON CONFLICT(key) DO UPDATE SET seen_at = excluded.seen_at`
    )
    this.db.exec('BEGIN')
    try {
      for (const r of existing) if (!keep.has(r.key)) del.run(r.key)
      for (const m of modelIds) ins.run(`${endpointId}::${m}`, endpointId, m, now())
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  listModels(): ModelInfo[] {
    const rows = this.db
      .prepare(
        `SELECT m.key, m.endpoint_id, m.model_id, m.favorite, m.meta, e.name AS endpoint_name, e.adapter
         FROM models m JOIN endpoints e ON e.id = m.endpoint_id
         ORDER BY m.favorite DESC, e.name COLLATE NOCASE, m.model_id COLLATE NOCASE`
      )
      .all() as unknown as Array<{
      key: string
      endpoint_id: string
      model_id: string
      favorite: number
      meta: string
      endpoint_name: string
      adapter: string
    }>
    return rows.map((r) => ({
      key: r.key,
      endpointId: r.endpoint_id,
      endpointName: r.endpoint_name,
      adapter: r.adapter as AdapterId,
      modelId: r.model_id,
      favorite: r.favorite === 1,
      ...knownMeta(r.model_id),
      ...parse<Partial<ModelMeta>>(r.meta, {})
    }))
  }

  getModel(ref: ModelRef): ModelInfo | null {
    return this.listModels().find((m) => m.endpointId === ref.endpointId && m.modelId === ref.modelId) ?? null
  }

  setFavorite(key: string, on: boolean): void {
    this.db.prepare('UPDATE models SET favorite = ? WHERE key = ?').run(on ? 1 : 0, key)
  }

  setModelMeta(key: string, meta: Partial<ModelMeta>): void {
    const row = this.db.prepare('SELECT meta FROM models WHERE key = ?').get(key) as unknown as { meta: string } | undefined
    const cur = parse<Partial<ModelMeta>>(row?.meta, {})
    this.db.prepare('UPDATE models SET meta = ? WHERE key = ?').run(JSON.stringify({ ...cur, ...meta }), key)
  }

  // ---------------------------------------------------------------- sessions

  private rowToSession(r: {
    id: string
    workspace: string
    title: string
    created_at: number
    updated_at: number
    model: string | null
    mode: string
    input_tokens: number
    output_tokens: number
    cost: number
    parent_id: string | null
    item_count?: number
  }): Session {
    return {
      id: r.id,
      workspace: r.workspace,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      model: parse<ModelRef | null>(r.model, null),
      mode: r.mode as PermissionMode,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cost: r.cost,
      parentId: r.parent_id,
      status: 'idle',
      itemCount: r.item_count ?? 0
    }
  }

  listSessions(workspace: string): Session[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.session_id = s.id) AS item_count
         FROM sessions s WHERE s.workspace = ? AND s.parent_id IS NULL ORDER BY s.updated_at DESC`
      )
      .all(workspace) as unknown as Parameters<Repo['rowToSession']>[0][]
    return rows.map((r) => this.rowToSession(r))
  }

  getSession(id: string): Session | null {
    const r = this.db
      .prepare(`SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.session_id = s.id) AS item_count FROM sessions s WHERE s.id = ?`)
      .get(id) as unknown as Parameters<Repo['rowToSession']>[0] | undefined
    return r ? this.rowToSession(r) : null
  }

  createSession(workspace: string, title: string, model: ModelRef | null, mode: PermissionMode, parentId: string | null = null): Session {
    const id = randomUUID()
    const t = now()
    this.db
      .prepare(
        `INSERT INTO sessions (id, workspace, title, created_at, updated_at, model, mode, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, workspace, title, t, t, model ? JSON.stringify(model) : null, mode, parentId)
    return this.getSession(id)!
  }

  updateSession(id: string, patch: { title?: string; model?: ModelRef | null; mode?: PermissionMode }): void {
    if (patch.title !== undefined) this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(patch.title, id)
    if (patch.model !== undefined) this.db.prepare('UPDATE sessions SET model = ? WHERE id = ?').run(patch.model ? JSON.stringify(patch.model) : null, id)
    if (patch.mode !== undefined) this.db.prepare('UPDATE sessions SET mode = ? WHERE id = ?').run(patch.mode, id)
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), id)
  }

  getSessionExtras(id: string): SessionExtras {
    const row = this.db.prepare('SELECT extras FROM sessions WHERE id = ?').get(id) as unknown as { extras?: string } | undefined
    const v = parse<Partial<SessionExtras>>(row?.extras, {})
    const wt = v.worktree && typeof v.worktree === 'object' && typeof v.worktree.path === 'string' && typeof v.worktree.branch === 'string' ? v.worktree : null
    const cl = v.claude && typeof v.claude === 'object' && typeof v.claude.sessionId === 'string' ? { ...v.claude, turns: Array.isArray(v.claude.turns) ? v.claude.turns : [] } : null
    const wakeups = Array.isArray(v.wakeups) ? v.wakeups.filter((w) => w && typeof w.id === 'string' && typeof w.dueAt === 'number' && typeof w.note === 'string') : []
    const helpers = Array.isArray(v.helpers) ? v.helpers.filter((h) => h && typeof h.name === 'string' && typeof h.sessionId === 'string' && h.model && typeof h.model.modelId === 'string') : []
    const budget = v.budget && typeof v.budget === 'object' ? { cost: typeof v.budget.cost === 'number' ? v.budget.cost : null, minutes: typeof v.budget.minutes === 'number' ? v.budget.minutes : null } : null
    const w = v.working
    const working = w && typeof w === 'object' && typeof w.since === 'number' ? { since: w.since, turn: w.turn === true, jobs: Array.isArray(w.jobs) ? w.jobs.filter((j) => typeof j === 'string') : [], resumes: typeof w.resumes === 'number' ? w.resumes : 0 } : null
    return { pins: Array.isArray(v.pins) ? v.pins.filter((p) => typeof p === 'string') : [], instructions: typeof v.instructions === 'string' ? v.instructions : '', worktree: wt, claude: cl, skills: Array.isArray(v.skills) ? v.skills.filter((x) => typeof x === 'string') : [], toolSources: Array.isArray(v.toolSources) ? v.toolSources.filter((x) => typeof x === 'string') : [], wakeups, helpers, budget, sideOf: typeof v.sideOf === 'string' ? v.sideOf : null, effort: EFFORTS.includes(v.effort as Effort) ? (v.effort as Effort) : null, working }
  }

  /** A session's children, oldest first. */
  listChildren(parentId: string): string[] {
    const rows = this.db.prepare('SELECT id FROM sessions WHERE parent_id = ? ORDER BY created_at ASC').all(parentId) as unknown as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /** Sessions with timers set, in any project. */
  sessionsWithWakeups(): string[] {
    const rows = this.db.prepare(`SELECT id FROM sessions WHERE extras LIKE '%"wakeups":[{%'`).all() as unknown as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /** Sessions Prism went down under while they were in the middle of something (SessionExtras.working). */
  sessionsCutOff(): string[] {
    const rows = this.db.prepare(`SELECT id FROM sessions WHERE extras LIKE '%"working":{%'`).all() as unknown as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  setSessionExtras(id: string, patch: Partial<SessionExtras>): SessionExtras {
    const next = { ...this.getSessionExtras(id), ...patch }
    next.pins = [...new Set(next.pins)].slice(0, 40)
    this.db.prepare('UPDATE sessions SET extras = ? WHERE id = ?').run(JSON.stringify(next), id)
    return next
  }

  addSessionUsage(id: string, usage: Usage): void {
    this.db
      .prepare('UPDATE sessions SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost = cost + ?, updated_at = ? WHERE id = ?')
      .run(usage.inputTokens, usage.outputTokens, usage.cost ?? 0, now(), id)
  }

  deleteSession(id: string): void {
    const children = this.db.prepare('SELECT id FROM sessions WHERE parent_id = ?').all(id) as unknown as Array<{ id: string }>
    for (const c of children) this.deleteSession(c.id)
    this.db.prepare('DELETE FROM items WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM checkpoint_files WHERE checkpoint_id IN (SELECT id FROM checkpoints WHERE session_id = ?)').run(id)
    this.db.prepare('DELETE FROM checkpoints WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM file_versions WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  // ---------------------------------------------------------------- transcript items

  listItems(sessionId: string): TranscriptItem[] {
    const rows = this.db.prepare('SELECT data FROM items WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as unknown as Array<{ data: string }>
    return rows.map((r) => JSON.parse(r.data) as TranscriptItem)
  }

  /** The last few items of a conversation, oldest first. The phone asks for these rather than years of transcript. */
  listItemsTail(sessionId: string, limit: number): TranscriptItem[] {
    const rows = this.db.prepare('SELECT data FROM items WHERE session_id = ? ORDER BY seq DESC LIMIT ?').all(sessionId, limit) as unknown as Array<{ data: string }>
    return rows.reverse().map((r) => JSON.parse(r.data) as TranscriptItem)
  }

  /** Items in the project's conversations whose stored form holds every word: a rough first pass, the caller checks the text itself. */
  searchItemRows(workspace: string, words: string[], since: number | null, sessionIds: string[] | null, limit = 4000): Array<{ session_id: string; title: string; model: string | null; data: string }> {
    const where = ['s.workspace = ?', 's.parent_id IS NULL']
    const args: Array<string | number> = [workspace]
    for (const w of words) {
      where.push(`lower(i.data) LIKE ? ESCAPE '\\'`)
      args.push(`%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    }
    if (since) {
      where.push('i.ts >= ?')
      args.push(since)
    }
    if (sessionIds) {
      if (!sessionIds.length) return []
      where.push(`i.session_id IN (${sessionIds.map(() => '?').join(',')})`)
      args.push(...sessionIds)
    }
    args.push(limit)
    return this.db
      .prepare(`SELECT i.session_id, s.title, s.model, i.data FROM items i JOIN sessions s ON s.id = i.session_id WHERE ${where.join(' AND ')} ORDER BY i.ts DESC LIMIT ?`)
      .all(...args) as unknown as Array<{ session_id: string; title: string; model: string | null; data: string }>
  }

  /** Conversations in the project that changed a file whose path contains `part`. */
  sessionsChanging(workspace: string, part: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT session_id FROM file_versions WHERE workspace = ? AND lower(path) LIKE ? ESCAPE '\\'`)
      .all(workspace, `%${part.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as unknown as Array<{ session_id: string }>
    return rows.map((r) => r.session_id)
  }

  /** The proof results ("done when" checks) recorded in the project's conversations, oldest first. */
  verdictRows(workspace: string): Array<{ session_id: string; data: string }> {
    return this.db
      .prepare(`SELECT i.session_id, i.data FROM items i JOIN sessions s ON s.id = i.session_id WHERE s.workspace = ? AND i.kind = 'system' AND i.data LIKE '%"verdict"%' ORDER BY i.ts ASC`)
      .all(workspace) as unknown as Array<{ session_id: string; data: string }>
  }

  appendItem(sessionId: string, item: TranscriptItem): void {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM items WHERE session_id = ?').get(sessionId) as unknown as { m: number }
    this.db
      .prepare('INSERT INTO items (id, session_id, seq, kind, ts, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(item.id, sessionId, row.m + 1, item.kind, item.ts, JSON.stringify(item))
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId)
  }

  /** Many items at once, in order (bringing in a long conversation). */
  appendItems(sessionId: string, items: TranscriptItem[]): void {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM items WHERE session_id = ?').get(sessionId) as unknown as { m: number }
    const ins = this.db.prepare('INSERT INTO items (id, session_id, seq, kind, ts, data) VALUES (?, ?, ?, ?, ?, ?)')
    this.db.exec('BEGIN')
    try {
      items.forEach((item, i) => ins.run(item.id, sessionId, row.m + 1 + i, item.kind, item.ts, JSON.stringify(item)))
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId)
  }

  /** Overwrite one stored item (used to drop a bulky tool result from the model's context). */
  replaceItem(sessionId: string, item: TranscriptItem): void {
    this.db.prepare('UPDATE items SET data = ? WHERE id = ? AND session_id = ?').run(JSON.stringify(item), item.id, sessionId)
  }

  /** Replace every item up to and including `throughItemId` with one compaction item. */
  compactItems(sessionId: string, throughItemId: string, summary: TranscriptItem): void {
    const seqRow = this.db.prepare('SELECT seq FROM items WHERE id = ? AND session_id = ?').get(throughItemId, sessionId) as unknown as
      | { seq: number }
      | undefined
    if (!seqRow) return
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM items WHERE session_id = ? AND seq <= ?').run(sessionId, seqRow.seq)
      this.db
        .prepare('INSERT INTO items (id, session_id, seq, kind, ts, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(summary.id, sessionId, seqRow.seq, summary.kind, summary.ts, JSON.stringify(summary))
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // ---------------------------------------------------------------- checkpoints

  createCheckpoint(sessionId: string, label: string, files: Array<{ path: string; content: Buffer | null }>, turnItemId: string | null = null): Checkpoint {
    const id = randomUUID()
    const ts = now()
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare('INSERT INTO checkpoints (id, session_id, ts, label, files, turn_item_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, sessionId, ts, label, JSON.stringify(files.map((f) => f.path)), turnItemId)
      const ins = this.db.prepare('INSERT INTO checkpoint_files (checkpoint_id, path, content, existed) VALUES (?, ?, ?, ?)')
      for (const f of files) ins.run(id, f.path, f.content, f.content === null ? 0 : 1)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return { id, sessionId, ts, label, files: files.map((f) => f.path), turnItemId }
  }

  /** Add files to an existing checkpoint (only paths not already captured). */
  addCheckpointFiles(id: string, files: Array<{ path: string; content: Buffer | null }>): string[] {
    const existing = new Set(
      (this.db.prepare('SELECT path FROM checkpoint_files WHERE checkpoint_id = ?').all(id) as unknown as Array<{ path: string }>).map((r) => r.path)
    )
    const added: string[] = []
    const ins = this.db.prepare('INSERT INTO checkpoint_files (checkpoint_id, path, content, existed) VALUES (?, ?, ?, ?)')
    for (const f of files) {
      if (existing.has(f.path)) continue
      ins.run(id, f.path, f.content, f.content === null ? 0 : 1)
      added.push(f.path)
    }
    if (added.length) {
      const all = [...existing, ...added]
      this.db.prepare('UPDATE checkpoints SET files = ? WHERE id = ?').run(JSON.stringify(all), id)
    }
    return added
  }

  listCheckpoints(sessionId: string): Checkpoint[] {
    const rows = this.db.prepare('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY ts DESC').all(sessionId) as unknown as Array<{
      id: string
      session_id: string
      ts: number
      label: string
      files: string
      turn_item_id: string | null
    }>
    return rows.map((r) => ({ id: r.id, sessionId: r.session_id, ts: r.ts, label: r.label, files: parse<string[]>(r.files, []), turnItemId: r.turn_item_id }))
  }

  /** Delete every item from `itemId` (inclusive) to the end of the session. */
  truncateItemsFrom(sessionId: string, itemId: string): number {
    const row = this.db.prepare('SELECT seq FROM items WHERE id = ? AND session_id = ?').get(itemId, sessionId) as unknown as { seq: number } | undefined
    if (!row) return 0
    const r = this.db.prepare('DELETE FROM items WHERE session_id = ? AND seq >= ?').run(sessionId, row.seq)
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId)
    return Number(r.changes)
  }

  getItem(sessionId: string, itemId: string): TranscriptItem | null {
    const row = this.db.prepare('SELECT data FROM items WHERE id = ? AND session_id = ?').get(itemId, sessionId) as unknown as { data: string } | undefined
    return row ? (JSON.parse(row.data) as TranscriptItem) : null
  }

  getCheckpointFiles(id: string): Array<{ path: string; content: Buffer | null }> {
    const rows = this.db.prepare('SELECT path, content, existed FROM checkpoint_files WHERE checkpoint_id = ?').all(id) as unknown as Array<{
      path: string
      content: Uint8Array | null
      existed: number
    }>
    return rows.map((r) => ({ path: r.path, content: r.existed ? Buffer.from(r.content ?? new Uint8Array()) : null }))
  }

  getCheckpoint(id: string): Checkpoint | null {
    const r = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as unknown as
      | { id: string; session_id: string; ts: number; label: string; files: string; turn_item_id: string | null }
      | undefined
    return r ? { id: r.id, sessionId: r.session_id, ts: r.ts, label: r.label, files: parse<string[]>(r.files, []), turnItemId: r.turn_item_id } : null
  }

  // ---------------------------------------------------------------- file history

  addFileVersion(v: { sessionId: string; workspace: string; turnItemId: string | null; callId: string | null; path: string; before: Buffer | null; after: Buffer | null }): number {
    const r = this.db
      .prepare('INSERT INTO file_versions (session_id, workspace, turn_item_id, call_id, path, ts, before, before_exists, after, after_exists) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(v.sessionId, v.workspace, v.turnItemId, v.callId, v.path, now(), v.before, v.before ? 1 : 0, v.after, v.after ? 1 : 0)
    return Number(r.lastInsertRowid)
  }

  private versionRow(r: { id: number; session_id: string; turn_item_id: string | null; call_id: string | null; path: string; ts: number; before: Uint8Array | null; before_exists: number; after: Uint8Array | null; after_exists: number }): FileVersion {
    const text = (b: Uint8Array | null, exists: number): string | null => (exists ? Buffer.from(b ?? new Uint8Array()).toString('utf8') : null)
    return { id: r.id, sessionId: r.session_id, turnItemId: r.turn_item_id, callId: r.call_id, path: r.path, ts: r.ts, before: text(r.before, r.before_exists), after: text(r.after, r.after_exists) }
  }

  getFileVersion(id: number): FileVersion | null {
    const r = this.db.prepare('SELECT * FROM file_versions WHERE id = ?').get(id) as unknown as Parameters<Repo['versionRow']>[0] | undefined
    return r ? this.versionRow(r) : null
  }

  /** A session's changes, oldest first. */
  listFileVersions(sessionId: string): FileVersion[] {
    const rows = this.db.prepare('SELECT * FROM file_versions WHERE session_id = ? ORDER BY id ASC').all(sessionId) as unknown as Parameters<Repo['versionRow']>[0][]
    return rows.map((r) => this.versionRow(r))
  }

  /** Every recorded change to one file of a project, newest first. */
  fileVersionsOf(workspace: string, path: string, limit = 200): FileVersion[] {
    const rows = this.db.prepare('SELECT * FROM file_versions WHERE workspace = ? AND path = ? ORDER BY id DESC LIMIT ?').all(workspace, path, limit) as unknown as Parameters<Repo['versionRow']>[0][]
    return rows.map((r) => this.versionRow(r))
  }

  /** The newest change in this turn to this file, if any. */
  lastVersionInTurn(sessionId: string, turnItemId: string | null, path: string): FileVersion | null {
    const r = this.db
      .prepare('SELECT * FROM file_versions WHERE session_id = ? AND turn_item_id IS ? AND path = ? ORDER BY id DESC LIMIT 1')
      .get(sessionId, turnItemId, path) as unknown as Parameters<Repo['versionRow']>[0] | undefined
    return r ? this.versionRow(r) : null
  }

  // ---------------------------------------------------------------- usage

  recordUsage(e: {
    endpointId: string
    modelId: string
    sessionId: string | null
    ok: boolean
    usage?: Usage
    error?: string | null
  }): void {
    this.db
      .prepare(
        `INSERT INTO usage_events (endpoint_id, model_id, session_id, ok, input_tokens, output_tokens, cache_read, cache_write, latency_ms, cost, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.endpointId,
        e.modelId,
        e.sessionId,
        e.ok ? 1 : 0,
        e.usage?.inputTokens ?? null,
        e.usage?.outputTokens ?? null,
        e.usage?.cacheReadTokens ?? null,
        e.usage?.cacheWriteTokens ?? null,
        e.usage?.latencyMs ?? null,
        e.usage?.cost ?? null,
        e.error ?? null,
        now()
      )
  }

  /** What the sessions of one workspace used, per day. */
  spendByDay(workspace: string, days: number): SpendDay[] {
    const rows = this.db
      .prepare(
        `SELECT CAST(u.created_at / 86400000 AS INTEGER) AS day, COALESCE(SUM(u.input_tokens),0) i, COALESCE(SUM(u.output_tokens),0) o, COALESCE(SUM(u.cost),0) c, COUNT(*) n
         FROM usage_events u JOIN sessions s ON s.id = u.session_id
         WHERE s.workspace = ? AND u.created_at >= ?
         GROUP BY day ORDER BY day`
      )
      .all(workspace, now() - days * 86_400_000) as unknown as Array<{ day: number; i: number; o: number; c: number; n: number }>
    return rows.map((r) => ({ day: r.day, inputTokens: r.i, outputTokens: r.o, cost: r.c, requests: r.n }))
  }

  usageSummary(): UsageSummary {
    const names = new Map(this.listEndpoints().map((e) => [e.id, e.name]))
    const tot = this.db
      .prepare('SELECT COUNT(*) n, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cost),0) c FROM usage_events')
      .get() as unknown as { n: number; i: number; o: number; c: number }
    const by = this.db
      .prepare(
        `SELECT endpoint_id, model_id, COUNT(*) n, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cost),0) c
         FROM usage_events GROUP BY endpoint_id, model_id ORDER BY (i + o) DESC LIMIT 12`
      )
      .all() as unknown as Array<{ endpoint_id: string; model_id: string; n: number; i: number; o: number; c: number }>
    const day = this.db
      .prepare('SELECT COUNT(*) n, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cost),0) c FROM usage_events WHERE created_at > ?')
      .get(now() - 86_400_000) as unknown as { n: number; i: number; o: number; c: number }
    return {
      totals: { requests: tot.n, inputTokens: tot.i, outputTokens: tot.o, cost: tot.c },
      byModel: by.map((r) => ({
        label: `${r.model_id} · ${names.get(r.endpoint_id) ?? r.endpoint_id}`,
        requests: r.n,
        inputTokens: r.i,
        outputTokens: r.o,
        cost: r.c
      })),
      last24h: { requests: day.n, inputTokens: day.i, outputTokens: day.o, cost: day.c }
    }
  }
}
