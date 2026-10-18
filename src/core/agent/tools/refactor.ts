import type { FileDiff } from '@shared/types'
import { findReferences, isScript, moveFile, renameSymbol } from '../../refactor/refactor'
import { modeAllows } from '../permissions'
import { countDiff } from './fs'
import { err, num, str, type AgentTool, type ToolContext } from './types'

/** Models know the line and the name, not the column: find the name on that line (or the nearest line that has it). */
async function locate(ctx: ToolContext, path: string, line: number, symbol: string): Promise<{ line: number; column: number }> {
  const lines = (await ctx.workspace.read(path)).content.split(/\r?\n/)
  const re = new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`)
  for (const d of [0, -1, 1, -2, 2, -3, 3]) {
    const i = line - 1 + d
    const m = lines[i] !== undefined ? re.exec(lines[i]!) : null
    if (m) return { line: i + 1, column: m.index + 1 }
  }
  const any = lines.findIndex((l) => re.test(l))
  if (any >= 0) return { line: any + 1, column: re.exec(lines[any]!)!.index + 1 }
  throw new Error(`${symbol} does not appear in ${path}.`)
}

const WHERE = {
  path: { type: 'string', description: 'A file where the name appears' },
  line: { type: 'number', description: 'The line it is on there (1-based); the nearest line with the name is used' },
  symbol: { type: 'string', description: 'The name: a function, variable, class, type or property' }
}

export const findReferencesTool: AgentTool = {
  spec: {
    name: 'find_references',
    description:
      'List every place a function, variable, class, type or property is used across the project. For JavaScript and TypeScript this goes by meaning (other things with the same name are left out, renamed imports are followed); for other languages it is a whole-word text search. Prefer it to grep when you need to know who uses something.',
    parameters: { type: 'object', properties: WHERE, required: ['path', 'symbol'] }
  },
  primaryArg: 'symbol',
  readOnly: true,
  risk: () => null,
  summary: (a) => `uses of ${str(a, 'symbol')}`,
  async execute(args, ctx) {
    try {
      const path = await ctx.workspace.lenient(str(args, 'path'))
      const symbol = str(args, 'symbol')
      const at = await locate(ctx, path, num(args, 'line', 1), symbol)
      const r = await findReferences(ctx.workspace.root, path, at.line, at.column, symbol)
      if (!r.hits.length) return { content: `Nothing uses ${symbol}.`, isError: false }
      const shown = r.hits.slice(0, 200)
      return {
        content:
          `${r.hits.length} place${r.hits.length === 1 ? '' : 's'} (${r.byMeaning ? 'by meaning' : 'whole-word text matches; some may be a different thing with the same name'}):\n` +
          shown.map((h) => `${h.path}:${h.line}: ${h.text}${h.kind === 'definition' ? '   [defined here]' : ''}`).join('\n') +
          (r.hits.length > shown.length ? `\n… and ${r.hits.length - shown.length} more` : ''),
        isError: false
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}

export const renameSymbolTool: AgentTool = {
  spec: {
    name: 'rename_symbol',
    description:
      'Rename a function, variable, class, type or property everywhere it is used, in every file, in one step. Use this instead of editing each file by hand: for JavaScript and TypeScript it goes by meaning, so imports and uses stay consistent and unrelated things with the same name are untouched. In ask mode the user sees the whole change set and chooses what is written.',
    parameters: { type: 'object', properties: { ...WHERE, new_name: { type: 'string' } }, required: ['path', 'symbol', 'new_name'] }
  },
  primaryArg: 'symbol',
  readOnly: false,
  // in ask mode the change set review is the approval; in the freer modes edits need none
  risk: () => null,
  summary: (a) => `rename ${str(a, 'symbol')} → ${str(a, 'new_name')}`,
  async execute(args, ctx) {
    try {
      const path = await ctx.workspace.lenient(str(args, 'path'))
      const symbol = str(args, 'symbol')
      const at = await locate(ctx, path, num(args, 'line', 1), symbol)
      const plan = await renameSymbol(ctx.workspace.root, path, at.line, at.column, symbol, str(args, 'new_name'))
      if (!plan.files.length) return { content: `No use of ${symbol} was found, so nothing was renamed.`, isError: false }
      let accepted = plan.files.map((f) => ({ path: f.path, content: f.after, partial: false }))
      let comment = ''
      if (!modeAllows(ctx.mode?.() ?? 'ask', 'edit_file')) {
        const d = await ctx.review({ title: plan.title, files: plan.files })
        if (ctx.signal.aborted) return { content: 'Stopped before the review was answered. Nothing was written.', isError: false }
        accepted = d.files.filter((f) => plan.files.some((x) => x.path === f.path))
        comment = d.comment ?? ''
      }
      if (!accepted.length) return { content: `The user rejected the rename. Nothing was written.${comment ? ` They say: ${comment}` : ''}`, isError: false }
      await ctx.checkpoint(accepted.map((f) => f.path))
      const diffs: FileDiff[] = []
      for (const f of accepted) {
        if (f.content === null) continue
        const before = plan.files.find((x) => x.path === f.path)!.before
        await ctx.workspace.write(f.path, f.content)
        ctx.emit({ type: 'file-touched', path: f.path, op: 'edit' })
        diffs.push({ path: f.path, before, after: f.content, ...countDiff(before, f.content) })
      }
      const left = plan.files.filter((f) => !accepted.some((a) => a.path === f.path)).map((f) => f.path)
      const partial = accepted.filter((f) => f.partial).map((f) => f.path)
      return {
        content: [
          `${plan.title}: ${diffs.length} file${diffs.length === 1 ? '' : 's'} changed (${diffs.map((d) => d.path).join(', ')}).`,
          plan.byMeaning ? '' : 'This was a whole-word text replacement, not by meaning: check that nothing unrelated with the same name was changed.',
          plan.note && plan.byMeaning ? plan.note : '',
          left.length ? `The user left these unchanged: ${left.join(', ')}.` : '',
          partial.length ? `Only part was accepted in: ${partial.join(', ')}. Read those again before editing them.` : '',
          comment ? `The user says: ${comment}` : ''
        ]
          .filter(Boolean)
          .join('\n'),
        isError: false,
        ...(diffs[0] ? { diff: diffs[0] } : {}),
        meta: { diffs }
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}

/** Used by move_path: move a script (or a folder with scripts) and fix the imports that pointed at it. Null when there was nothing to fix. */
export async function moveWithImports(ctx: ToolContext, from: string, to: string): Promise<{ updated: string[]; diffs: FileDiff[] } | null> {
  let plan
  try {
    plan = await moveFile(ctx.workspace.root, from, to)
  } catch {
    return null
  }
  if (!plan.files.length) return null
  await ctx.checkpoint(plan.files.map((f) => f.path))
  const diffs: FileDiff[] = []
  for (const f of plan.files) {
    if (f.after === null) continue
    await ctx.workspace.write(f.path, f.after)
    ctx.emit({ type: 'file-touched', path: f.path, op: 'edit' })
    diffs.push({ path: f.path, before: f.before, after: f.after, ...countDiff(f.before, f.after) })
  }
  return { updated: diffs.map((d) => d.path), diffs }
}

export { isScript }
