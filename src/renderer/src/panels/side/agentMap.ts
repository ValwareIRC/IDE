// Where the agent has been in a session, for the explorer's map: how often it
// read and changed each file (folders add up what is inside them), and which
// file it is on right now. Built from the session's transcript and its tools
// still running, so it works for any session, past or live.
import type { ToolCall, TranscriptItem } from '@shared/types'

export interface Heat {
  reads: number
  writes: number
}

const READS = new Set(['read_file', 'list_dir', 'grep', 'glob', 'find_references', 'show'])
const WRITES = new Set(['write_file', 'edit_file', 'delete_path', 'move_path', 'rename_symbol'])

const norm = (p: string): string => p.split('\\').join('/').replace(/^\.\//, '').replace(/\/$/, '')

/** The workspace paths a call is about. */
export function pathsOf(call: Pick<ToolCall, 'name' | 'args'>): string[] {
  const a = call.args ?? {}
  const out: string[] = []
  for (const k of ['path', 'from', 'to', 'file', 'script']) if (typeof a[k] === 'string' && a[k]) out.push(norm(a[k] as string))
  if (Array.isArray(a['files'])) for (const f of a['files'] as Array<{ path?: unknown }>) if (typeof f?.path === 'string') out.push(norm(f.path))
  return out.filter((p) => p && p !== '.' && !/^[a-zA-Z]:|^\//.test(p))
}

export function agentMap(items: TranscriptItem[]): Map<string, Heat> {
  const heat = new Map<string, Heat>()
  const add = (p: string, kind: keyof Heat): void => {
    // the file, and every folder it is in
    const parts = p.split('/')
    for (let i = parts.length; i >= 1; i--) {
      const key = parts.slice(0, i).join('/')
      const h = heat.get(key) ?? { reads: 0, writes: 0 }
      h[kind]++
      heat.set(key, h)
    }
  }
  for (const it of items) {
    if (it.kind !== 'tool') continue
    const write = WRITES.has(it.name) || !!it.diff
    const read = READS.has(it.name)
    if (!write && !read) {
      const changed = it.meta?.['changed']
      if (Array.isArray(changed)) for (const p of changed) if (typeof p === 'string') add(norm(p), 'writes')
      continue
    }
    const paths = it.diff?.path ? [norm(it.diff.path)] : pathsOf(it)
    for (const p of paths) add(p, write ? 'writes' : 'reads')
  }
  return heat
}
