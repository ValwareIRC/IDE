import { extname } from 'node:path'
import type { FileDiff } from '@shared/types'
import { isIgnoredDir } from '../../fs/paths'
import { globFiles, searchWorkspace } from '../../fs/search'
import { bool, clipOutput, err, num, str, type AgentTool, type ToolResult } from './types'
import { readPdf, renderNotebook } from './documents'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

export function countDiff(before: string | null, after: string | null): { additions: number; deletions: number } {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  // Cheap LCS-free estimate: lines present in one side but not the other.
  const setA = new Map<string, number>()
  for (const l of a) setA.set(l, (setA.get(l) ?? 0) + 1)
  let deletions = 0
  let additions = 0
  const setB = new Map<string, number>()
  for (const l of b) setB.set(l, (setB.get(l) ?? 0) + 1)
  for (const [l, n] of setA) deletions += Math.max(0, n - (setB.get(l) ?? 0))
  for (const [l, n] of setB) additions += Math.max(0, n - (setA.get(l) ?? 0))
  return { additions, deletions }
}

/** One exact replacement, tolerant of CRLF/LF and trailing-whitespace drift. */
export function replaceIn(content: string, oldS: string, newS: string, all: boolean): { ok: true; next: string; count: number } | { ok: false; error: string } {
  if (!oldS) return { ok: false, error: 'old_string must not be empty.' }
  if (oldS === newS) return { ok: false, error: 'old_string and new_string are identical.' }
  let count = content.split(oldS).length - 1
  if (count === 0) {
    const normalize = (s: string): string => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '')
    const nc = normalize(content)
    const no = normalize(oldS)
    count = nc.split(no).length - 1
    if (count === 0) return { ok: false, error: 'old_string not found. Re-read the file and copy the exact text.' }
    if (count > 1 && !all) return { ok: false, error: `old_string occurs ${count} times. Include more surrounding context to make it unique, or set replace_all.` }
    const nn = normalize(newS)
    return { ok: true, next: all ? nc.split(no).join(nn) : nc.replace(no, () => nn), count }
  }
  if (count > 1 && !all) return { ok: false, error: `old_string occurs ${count} times. Include more surrounding context to make it unique, or set replace_all.` }
  return { ok: true, next: all ? content.split(oldS).join(newS) : content.replace(oldS, () => newS), count }
}

function makeDiff(path: string, before: string | null, after: string | null): FileDiff {
  return { path, before, after, ...countDiff(before, after) }
}

function numbered(content: string, startLine: number): string {
  const lines = content.split('\n')
  const width = String(startLine + lines.length).length
  return lines.map((l, i) => `${String(startLine + i).padStart(width, ' ')}\t${l}`).join('\n')
}

export const readFileTool: AgentTool = {
  spec: {
    name: 'read_file',
    description:
      'Read a file from the workspace. Returns numbered lines. For large files pass offset (1-based line) and limit. Images are returned visually when the model supports vision. PDFs come back as their text, page by page (pass pages, e.g. "1-5", for long ones). Jupyter notebooks (.ipynb) come back as numbered cells with their outputs; change them with edit_notebook.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path' },
        offset: { type: 'number', description: 'First line to read (1-based)' },
        limit: { type: 'number', description: 'Maximum lines to return (default 2000)' },
        pages: { type: 'string', description: 'PDF only: which pages, e.g. "3" or "1-5" (default the first 20)' }
      },
      required: ['path']
    }
  },
  primaryArg: 'path',
  readOnly: true,
  risk: () => null,
  summary: (a) => `read ${str(a, 'path')}`,
  async execute(args, ctx) {
    const path = await ctx.workspace.lenient(str(args, 'path'))
    try {
      ctx.workspace.abs(path)
      const what = await ctx.workspace.kind(path)
      if (what === null) return err(`${path} does not exist.`)
      if (what === 'dir') return err(`${path} is a directory. Use list_dir.`)
      const mime = IMAGE_MIME[extname(path).toLowerCase()]
      if (mime) {
        const buf = await ctx.workspace.readRaw(path)
        if (buf.length > 6 * 1024 * 1024) return err('Image is larger than 6MB.')
        ctx.emit({ type: 'file-touched', path, op: 'read' })
        return { content: `Image ${path} (${buf.length} bytes) attached.`, isError: false, images: [{ mime, base64: buf.toString('base64') }], meta: { image: true } }
      }
      if (/\.pdf$/i.test(path)) {
        const buf = await ctx.workspace.readRaw(path)
        const r = await readPdf(buf, str(args, 'pages'))
        ctx.emit({ type: 'file-touched', path, op: 'read' })
        return { content: clipOutput(r.text, 120_000), isError: false, meta: r.meta }
      }
      if (/\.ipynb$/i.test(path)) {
        const r = renderNotebook((await ctx.workspace.read(path)).content)
        ctx.emit({ type: 'file-touched', path, op: 'read' })
        return { content: clipOutput(r.text, 120_000), isError: false, ...(r.images.length ? { images: r.images } : {}), meta: r.meta }
      }
      const f = await ctx.workspace.read(path)
      if (f.binary) return err(`${path} is a binary file (${f.size} bytes).`)
      const offset = Math.max(1, Math.floor(num(args, 'offset', 1)))
      const limit = Math.max(1, Math.floor(num(args, 'limit', 2000)))
      const lines = f.content.split('\n')
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      let out = numbered(slice.join('\n'), offset)
      if (offset - 1 + limit < lines.length) out += `\n\n… ${lines.length - (offset - 1 + limit)} more lines. Read with offset ${offset + limit} to continue.`
      if (f.truncated) out += `\n\n[file truncated at 2MB]`
      ctx.emit({ type: 'file-touched', path, op: 'read' })
      return { content: clipOutput(out, 120_000), isError: false, meta: { lines: lines.length, size: f.size, from: offset, to: offset - 1 + slice.length } }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}

export const writeFileTool: AgentTool = {
  spec: {
    name: 'write_file',
    description: 'Create or completely overwrite a file with the given content. Prefer edit_file for changes to existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path' },
        content: { type: 'string', description: 'Full file content' }
      },
      required: ['path', 'content']
    }
  },
  primaryArg: 'path',
  readOnly: false,
  risk: () => 'medium',
  summary: (a) => `write ${str(a, 'path')}`,
  async execute(args, ctx) {
    const path = str(args, 'path')
    const content = str(args, 'content')
    try {
      ctx.workspace.abs(path)
      let before: string | null = null
      try {
        const f = await ctx.workspace.read(path)
        before = f.binary ? null : f.content
      } catch {
        before = null
      }
      await ctx.checkpoint([path])
      await ctx.workspace.write(path, content)
      ctx.emit({ type: 'file-touched', path, op: 'write' })
      const diff = makeDiff(path, before, content)
      return {
        content: `${before === null ? 'Created' : 'Overwrote'} ${path} (${content.split('\n').length} lines, +${diff.additions} −${diff.deletions}).`,
        isError: false,
        diff
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}

/** The text with CRLF as LF and spaces before line ends removed, and for each of its characters, where it is in the original. */
function looseView(text: string): { text: string; at: number[] } {
  let out = ''
  const at: number[] = []
  let i = 0
  while (i < text.length) {
    // spaces and tabs running into a line end (or the end) are left out
    if (text[i] === ' ' || text[i] === '\t') {
      let j = i
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++
      if (j >= text.length || text[j] === '\n' || text[j] === '\r') {
        i = j
        continue
      }
    }
    if (text[i] === '\r' && text[i + 1] === '\n') {
      i++
      continue
    }
    out += text[i]
    at.push(i)
    i++
  }
  return { text: out, at }
}

export const editFileTool: AgentTool = {
  spec: {
    name: 'edit_file',
    description:
      'Make a precise edit: replace old_string with new_string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true. Read the file first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  primaryArg: 'path',
  readOnly: false,
  risk: () => 'medium',
  summary: (a) => `edit ${str(a, 'path')}`,
  async execute(args, ctx) {
    const path = await ctx.workspace.lenient(str(args, 'path'))
    const oldS = str(args, 'old_string')
    const newS = str(args, 'new_string')
    const all = bool(args, 'replace_all')
    if (!oldS) return err('old_string must not be empty. Use write_file to create files.')
    if (oldS === newS) return err('old_string and new_string are identical.')
    try {
      const f = await ctx.workspace.read(path)
      if (f.binary) return err(`${path} is binary.`)
      let content = f.content
      let count = content.split(oldS).length - 1
      if (count === 0) {
        // Tolerate CRLF vs LF and trailing-whitespace drift: match on a cleaned-up view, but change only the matched
        // span of the real file, so the rest keeps its line endings and spacing
        const view = looseView(content)
        const no = oldS.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '')
        const spans: Array<[number, number]> = []
        for (let i = view.text.indexOf(no); i >= 0 && no; i = view.text.indexOf(no, i + no.length)) {
          // a match that starts at a line end starts at its carriage return
          const s = view.at[i]!
          spans.push([s > 0 && content[s] === '\n' && content[s - 1] === '\r' ? s - 1 : s, view.at[i + no.length - 1]! + 1])
        }
        count = spans.length
        if (count === 0) return err(`old_string not found in ${path}. Re-read the file and copy the exact text.`)
        if (count > 1 && !all) return err(`old_string occurs ${count} times in ${path}. Include more surrounding context to make it unique, or set replace_all.`)
        const eol = content.includes('\r\n') ? '\r\n' : '\n'
        const nn = newS.replace(/\r\n/g, '\n').split('\n').join(eol)
        let next = content
        for (const [s, e] of (all ? spans : spans.slice(0, 1)).reverse()) next = next.slice(0, s) + nn + next.slice(e)
        return finishEdit(ctx, path, f.content, next, count)
      }
      if (count > 1 && !all) return err(`old_string occurs ${count} times in ${path}. Include more surrounding context to make it unique, or set replace_all.`)
      const next = all ? content.split(oldS).join(newS) : content.replace(oldS, () => newS)
      return finishEdit(ctx, path, f.content, next, count)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}

async function finishEdit(ctx: Parameters<AgentTool['execute']>[1], path: string, before: string, after: string, count: number): Promise<ToolResult> {
  await ctx.checkpoint([path])
  await ctx.workspace.write(path, after)
  ctx.emit({ type: 'file-touched', path, op: 'edit' })
  const diff = makeDiff(path, before, after)
  const firstLine = before.slice(0, before.indexOf(after.length ? after.slice(0, 1) : '')).split('\n').length
  void firstLine
  return { content: `Edited ${path}: ${count} replacement${count === 1 ? '' : 's'} (+${diff.additions} −${diff.deletions}).`, isError: false, diff }
}

export const listDirTool: AgentTool = {
  spec: {
    name: 'list_dir',
    description: 'List a directory as a tree (default depth 2). Ignores node_modules, build output and VCS folders.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory (default ".")' },
        depth: { type: 'number', description: 'Tree depth (1-4, default 2)' }
      }
    }
  },
  primaryArg: 'path',
  readOnly: true,
  risk: () => null,
  summary: (a) => `list ${str(a, 'path', '.')}`,
  async execute(args, ctx) {
    const path = await ctx.workspace.lenient(str(args, 'path', '.'))
    const depth = Math.max(1, Math.min(4, Math.floor(num(args, 'depth', 2))))
    const lines: string[] = []
    let count = 0
    const walk = async (dir: string, prefix: string, d: number): Promise<void> => {
      if (count > 800) return
      let entries: Awaited<ReturnType<typeof ctx.workspace.list>>
      try {
        entries = await ctx.workspace.list(dir)
      } catch (e) {
        lines.push(`${prefix}(unreadable: ${e instanceof Error ? e.message : e})`)
        return
      }
      for (const e of entries) {
        if (count > 800) {
          lines.push(`${prefix}…`)
          return
        }
        count++
        if (e.kind === 'dir') {
          const ignored = isIgnoredDir(e.name)
          lines.push(`${prefix}${e.name}/${ignored ? ' (ignored)' : ''}`)
          if (!ignored && d < depth) await walk(e.path, prefix + '  ', d + 1)
        } else {
          const size = e.size !== null && e.size >= 1024 ? ` (${(e.size / 1024).toFixed(e.size >= 10240 ? 0 : 1)} KB)` : ''
          lines.push(`${prefix}${e.name}${size}`)
        }
      }
    }
    try {
      ctx.workspace.abs(path)
      lines.push(`${path === '.' ? '.' : path}/   (workspace root = "." — paths are relative to it)`)
      await walk(path, '  ', 1)
      return { content: lines.join('\n'), isError: false, meta: { entries: count } }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}

export const globTool: AgentTool = {
  spec: {
    name: 'glob',
    description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py". Respects .gitignore.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern' },
        path: { type: 'string', description: 'Directory to search in (default ".")' }
      },
      required: ['pattern']
    }
  },
  primaryArg: 'pattern',
  readOnly: true,
  risk: () => null,
  summary: (a) => `glob ${str(a, 'pattern')}`,
  async execute(args, ctx) {
    const pattern = str(args, 'pattern')
    const path = str(args, 'path', '.')
    try {
      const root = ctx.workspace.abs(path)
      const files = await globFiles(root, pattern, 1000)
      const prefix = path === '.' ? '' : path.replace(/\/$/, '') + '/'
      const out = files.map((f) => prefix + f)
      return { content: out.length ? out.join('\n') : 'No files matched.', isError: false, meta: { count: out.length } }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}

export const grepTool: AgentTool = {
  spec: {
    name: 'grep',
    description: 'Search file contents with a regular expression (ripgrep). Returns path:line: text. Use include to filter by glob, e.g. "*.tsx".',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        path: { type: 'string', description: 'Directory or file to search (default ".")' },
        include: { type: 'string', description: 'Glob filter for files, e.g. "*.ts" or "src/**"' },
        case_insensitive: { type: 'boolean' },
        max_results: { type: 'number', description: 'Default 200' }
      },
      required: ['pattern']
    }
  },
  primaryArg: 'pattern',
  readOnly: true,
  risk: () => null,
  summary: (a) => `grep ${str(a, 'pattern')}`,
  async execute(args, ctx) {
    const pattern = str(args, 'pattern')
    let path = str(args, 'path', '.')
    try {
      // ripgrep runs inside the folder searched: for one file, search its folder for that file alone
      let include = str(args, 'include')
      if ((await ctx.workspace.kind(path)) === 'file') {
        const cut = path.replace(/\\/g, '/').lastIndexOf('/')
        include = `/${cut < 0 ? path : path.slice(cut + 1)}`
        path = cut < 0 ? '.' : path.slice(0, cut)
      }
      const root = ctx.workspace.abs(path)
      const r = await searchWorkspace(root, {
        query: pattern,
        regex: true,
        caseSensitive: !bool(args, 'case_insensitive'),
        wholeWord: false,
        ...(include ? { include } : {}),
        maxResults: Math.max(1, Math.min(2000, Math.floor(num(args, 'max_results', 200))))
      })
      const prefix = path === '.' ? '' : path.replace(/\/$/, '') + '/'
      const seen = new Set<string>()
      const lines: string[] = []
      for (const m of r.matches) {
        const key = `${m.path}:${m.line}`
        if (seen.has(key)) continue
        seen.add(key)
        lines.push(`${prefix}${m.path}:${m.line}: ${m.text.trim().slice(0, 300)}`)
      }
      let out = lines.length ? lines.join('\n') : 'No matches.'
      if (r.truncated) out += `\n… results truncated`
      return { content: clipOutput(out, 80_000), isError: false, meta: { matches: lines.length, files: r.files } }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}

export const deletePathTool: AgentTool = {
  spec: {
    name: 'delete_path',
    description: 'Delete a file or directory in the workspace. Irreversible outside of Prism checkpoints.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  primaryArg: 'path',
  readOnly: false,
  risk: () => 'high',
  summary: (a) => `delete ${str(a, 'path')}`,
  async execute(args, ctx) {
    const path = str(args, 'path')
    try {
      const what = await ctx.workspace.kind(path)
      if (what === null) return err(`${path} does not exist.`)
      if (what === 'file') await ctx.checkpoint([path])
      await ctx.workspace.delete(path)
      ctx.emit({ type: 'file-touched', path, op: 'delete' })
      return { content: `Deleted ${path}.`, isError: false }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}

export const movePathTool: AgentTool = {
  spec: {
    name: 'move_path',
    description: 'Move or rename a file or directory inside the workspace. For JavaScript and TypeScript files (or folders of them), the imports in other files that pointed at the old location are rewritten for you, and the result lists which files were updated.',
    parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }
  },
  primaryArg: 'from',
  readOnly: false,
  risk: () => 'medium',
  summary: (a) => `move ${str(a, 'from')} → ${str(a, 'to')}`,
  async execute(args, ctx) {
    const from = str(args, 'from')
    const to = str(args, 'to')
    try {
      if (await ctx.workspace.exists(to)) return err(`${to} already exists.`)
      // imports are worked out against the old location, so they are rewritten before the move
      const fixed = await (await import('./refactor')).moveWithImports(ctx, from, to)
      await ctx.workspace.rename(from, to)
      ctx.emit({ type: 'file-touched', path: to, op: 'write' })
      ctx.emit({ type: 'file-touched', path: from, op: 'delete' })
      if (!fixed) return { content: `Moved ${from} → ${to}.`, isError: false }
      return { content: `Moved ${from} → ${to}. Updated the imports in: ${fixed.updated.join(', ')}.`, isError: false, diff: fixed.diffs[0], meta: { diffs: fixed.diffs } }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}

export const showTool: AgentTool = {
  spec: {
    name: 'show',
    description:
      'Open a file in the user\'s view: images, 3D models (glb/gltf/obj/stl/fbx), HTML pages, markdown, PDFs or code. Use it after producing something worth looking at.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, note: { type: 'string', description: 'Optional caption' } }, required: ['path'] }
  },
  primaryArg: 'path',
  readOnly: true,
  risk: () => null,
  summary: (a) => `show ${str(a, 'path')}`,
  async execute(args, ctx) {
    const path = str(args, 'path')
    try {
      if (!(await ctx.workspace.exists(path))) return err(`${path} does not exist.`)
      return { content: `Showing ${path} to the user.`, isError: false, meta: { show: path, note: str(args, 'note') } }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}
