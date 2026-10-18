import type { FileDiff, ReviewFile } from '@shared/types'
import { countDiff, replaceIn } from './fs'
import { err, str, type AgentTool } from './types'

interface Change {
  path?: unknown
  content?: unknown
  edits?: unknown
  delete?: unknown
}

/** A whole change set shown to the user before any of it is written. */
export const proposeChangesTool: AgentTool = {
  spec: {
    name: 'propose_changes',
    description:
      'Show the user a set of file changes to review before anything is written. They accept or reject each file and each piece of it; only what they accept is written, all at once. ' +
      'Use it when the user wants to see changes first, and in ask mode for a change that spans several files (one review instead of many approvals). ' +
      'For each file give `content` (the whole new file), or `edits` (exact replacements, as in edit_file), or `delete: true`.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What this change does, in a few words' },
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Workspace-relative path' },
              content: { type: 'string', description: 'The complete new content (new files, or full rewrites)' },
              edits: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
                  required: ['old_string', 'new_string']
                }
              },
              delete: { type: 'boolean' }
            },
            required: ['path']
          }
        }
      },
      required: ['title', 'changes']
    }
  },
  primaryArg: null,
  readOnly: false,
  // the review is the approval
  risk: () => null,
  summary: (a) => `propose: ${str(a, 'title') || 'changes'} (${Array.isArray(a['changes']) ? a['changes'].length : 0} file${Array.isArray(a['changes']) && a['changes'].length === 1 ? '' : 's'})`,
  async execute(args, ctx) {
    const raw = args['changes']
    if (!Array.isArray(raw) || !raw.length) return err('changes must be a non-empty array.')
    const files: ReviewFile[] = []
    for (const c of raw as Change[]) {
      if (typeof c.path !== 'string' || !c.path.trim()) return err('Every change needs a path.')
      const path = await ctx.workspace.lenient(c.path)
      let before: string | null = null
      try {
        const f = await ctx.workspace.read(path)
        if (f.binary) return err(`${path} is binary.`)
        before = f.content
      } catch {
        before = null
      }
      let after: string | null
      if (c.delete === true) {
        if (before === null) return err(`${path} does not exist, so it cannot be deleted.`)
        after = null
      } else if (typeof c.content === 'string') {
        after = c.content
      } else if (Array.isArray(c.edits) && c.edits.length) {
        if (before === null) return err(`${path} does not exist. Give its whole content instead of edits.`)
        let text = before
        for (const e of c.edits as Array<{ old_string?: unknown; new_string?: unknown; replace_all?: unknown }>) {
          const r = replaceIn(text, String(e.old_string ?? ''), String(e.new_string ?? ''), e.replace_all === true)
          if (!r.ok) return err(`${path}: ${r.error}`)
          text = r.next
        }
        after = text
      } else {
        return err(`${path}: give content, edits, or delete: true.`)
      }
      if (after !== before) files.push({ path, before, after })
    }
    if (!files.length) return { content: 'Nothing to review: the proposed content is identical to what is on disk.', isError: false }

    const decision = await ctx.review({ title: str(args, 'title') || 'Proposed changes', files })
    if (ctx.signal.aborted) return { content: 'Stopped before the review was answered. Nothing was written.', isError: false }

    const accepted = decision.files.filter((f) => files.some((x) => x.path === f.path))
    const diffs: FileDiff[] = []
    if (accepted.length) {
      await ctx.checkpoint(accepted.map((f) => f.path))
      for (const f of accepted) {
        const before = files.find((x) => x.path === f.path)!.before
        if (f.content === null) await ctx.workspace.delete(f.path)
        else await ctx.workspace.write(f.path, f.content)
        ctx.emit({ type: 'file-touched', path: f.path, op: f.content === null ? 'delete' : before === null ? 'write' : 'edit' })
        diffs.push({ path: f.path, before, after: f.content, ...countDiff(before, f.content) })
      }
    }
    const partial = accepted.filter((f) => f.partial).map((f) => f.path)
    const rejected = files.map((f) => f.path).filter((p) => !accepted.some((a) => a.path === p))
    const lines = [
      accepted.length ? `Written: ${accepted.map((f) => f.path).join(', ')}.` : 'The user rejected the whole proposal. Nothing was written.',
      partial.length ? `Only part of your change was accepted in: ${partial.join(', ')}. Read those files again before editing them further.` : '',
      rejected.length && accepted.length ? `Rejected, not written: ${rejected.join(', ')}.` : '',
      decision.comment ? `The user says: ${decision.comment}` : '',
      !accepted.length || rejected.length || partial.length ? 'Do not write the rejected parts another way. Adjust to what the user said, or ask.' : ''
    ]
    return { content: lines.filter(Boolean).join('\n'), isError: false, ...(diffs[0] ? { diff: diffs[0] } : {}), meta: { diffs, rejected, partial } }
  }
}
