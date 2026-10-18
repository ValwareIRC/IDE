// PDFs and Jupyter notebooks: read_file turns them into text the model can work with,
// and edit_notebook changes a notebook one cell at a time without disturbing the rest of its JSON.
import type { ImagePart } from '../../providers/types'
import { err, str, type AgentTool } from './types'

/** "3", "1-5", "2,4,7-9" into 1-based page numbers within 1..total. */
export function parsePages(spec: string, total: number): number[] {
  const out = new Set<number>()
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(part)
    if (!m) continue
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    for (let p = Math.max(1, Math.min(a, b)); p <= Math.min(total, Math.max(a, b)); p++) out.add(p)
  }
  return [...out].sort((x, y) => x - y)
}

const PDF_PAGES_AT_ONCE = 20

export async function readPdf(buf: Buffer, pagesSpec: string): Promise<{ text: string; meta: Record<string, unknown> }> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { totalPages, text } = await extractText(pdf, { mergePages: false })
  const pages = pagesSpec.trim() ? parsePages(pagesSpec, totalPages) : Array.from({ length: Math.min(totalPages, PDF_PAGES_AT_ONCE) }, (_, i) => i + 1)
  if (!pages.length) throw new Error(`No such pages. The document has ${totalPages}.`)
  const shown = pages.slice(0, PDF_PAGES_AT_ONCE)
  const body = shown.map((p) => `--- page ${p} of ${totalPages} ---\n${(text[p - 1] ?? '').trim() || '(no text on this page: it may be a scan or a picture)'}`).join('\n\n')
  const more = shown.length < pages.length || (!pagesSpec.trim() && totalPages > PDF_PAGES_AT_ONCE)
  const last = shown[shown.length - 1] ?? 0
  return {
    text: `${body}${more ? `\n\n… ${totalPages} pages in all. Read more with pages "${last + 1}-${Math.min(totalPages, last + PDF_PAGES_AT_ONCE)}".` : ''}`,
    meta: { pdf: true, pages: totalPages, shown: shown.length }
  }
}

interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw'
  id?: string
  source: string | string[]
  metadata?: Record<string, unknown>
  outputs?: Array<Record<string, unknown>>
  execution_count?: number | null
}

interface Notebook {
  cells: NotebookCell[]
  metadata?: Record<string, unknown>
  nbformat?: number
  nbformat_minor?: number
}

const joinSource = (s: string | string[] | undefined): string => (Array.isArray(s) ? s.join('') : (s ?? ''))

/** Jupyter keeps source as a list of lines, each but the last ending in a newline. */
function splitSource(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  return lines.map((l, i) => (i < lines.length - 1 ? `${l}\n` : l)).filter((l, i, a) => !(i === a.length - 1 && l === ''))
}

function parseNotebook(content: string): Notebook {
  const nb = JSON.parse(content) as Notebook
  if (!nb || !Array.isArray(nb.cells)) throw new Error('This is not a Jupyter notebook (no cells).')
  return nb
}

function outputText(o: Record<string, unknown>): { text: string; image: ImagePart | null } {
  const type = String(o['output_type'] ?? '')
  if (type === 'stream') return { text: joinSource(o['text'] as string | string[]), image: null }
  if (type === 'error') return { text: `${String(o['ename'] ?? 'Error')}: ${String(o['evalue'] ?? '')}`, image: null }
  const data = (o['data'] ?? {}) as Record<string, unknown>
  const png = data['image/png']
  const jpeg = data['image/jpeg']
  const image = typeof png === 'string' ? { mime: 'image/png', base64: png.replace(/\s+/g, '') } : typeof jpeg === 'string' ? { mime: 'image/jpeg', base64: jpeg.replace(/\s+/g, '') } : null
  const text = data['text/plain'] !== undefined ? joinSource(data['text/plain'] as string | string[]) : image ? '' : `(${Object.keys(data).join(', ') || type} output)`
  return { text, image }
}

/** The notebook as numbered cells with their outputs; up to a few output pictures come along as images. */
export function renderNotebook(content: string): { text: string; images: ImagePart[]; meta: Record<string, unknown> } {
  const nb = parseNotebook(content)
  const lang = String((nb.metadata?.['kernelspec'] as Record<string, unknown> | undefined)?.['language'] ?? (nb.metadata?.['language_info'] as Record<string, unknown> | undefined)?.['name'] ?? 'python')
  const images: ImagePart[] = []
  const parts = nb.cells.map((c, i) => {
    const head = `### cell ${i}${c.id ? ` (id ${c.id})` : ''} · ${c.cell_type}${c.cell_type === 'code' && c.execution_count ? ` · ran as [${c.execution_count}]` : ''}`
    const src = joinSource(c.source)
    let s = `${head}\n${c.cell_type === 'code' ? `\`\`\`${lang}\n${src}\n\`\`\`` : src}`
    const outs = (c.outputs ?? []).map(outputText)
    if (outs.length) {
      const text = outs.map((o) => o.text).filter(Boolean).join('\n').trim()
      const pics = outs.filter((o) => o.image).length
      for (const o of outs) if (o.image && images.length < 4) images.push(o.image)
      s += `\n[output]\n${text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text || '(no text)'}${pics ? `\n[${pics} picture${pics === 1 ? '' : 's'} in the output]` : ''}`
    }
    return s
  })
  return { text: `Notebook (${lang}), ${nb.cells.length} cells. Change cells with edit_notebook.\n\n${parts.join('\n\n')}`, images, meta: { notebook: true, cells: nb.cells.length } }
}

function findCell(nb: Notebook, cell: string): number {
  const asNum = /^\d+$/.test(cell.trim()) ? Number(cell) : -1
  if (asNum >= 0 && asNum < nb.cells.length) return asNum
  const byId = nb.cells.findIndex((c) => c.id === cell.trim())
  if (byId >= 0) return byId
  throw new Error(`No cell "${cell}". Cells are numbered 0 to ${nb.cells.length - 1}, or use a cell's id.`)
}

const newId = (): string => Math.random().toString(16).slice(2, 10)

/** Apply one change to a notebook's JSON text, keeping Jupyter's own layout (one-space indent, final newline). */
export function editNotebook(content: string, op: { action: string; cell: string; source: string; cellType: string }): { content: string; summary: string } {
  const nb = parseNotebook(content)
  const type = (op.cellType === 'markdown' || op.cellType === 'raw' ? op.cellType : 'code') as NotebookCell['cell_type']
  const fresh = (): NotebookCell => {
    const c: NotebookCell = { cell_type: type, ...((nb.nbformat_minor ?? 0) >= 5 || nb.cells.some((x) => x.id) ? { id: newId() } : {}), metadata: {}, source: splitSource(op.source) }
    if (type === 'code') {
      c.outputs = []
      c.execution_count = null
    }
    return c
  }
  let summary: string
  if (op.action === 'insert_after' || op.action === 'insert_before' || op.action === 'append') {
    const at = op.action === 'append' || !nb.cells.length ? nb.cells.length : findCell(nb, op.cell) + (op.action === 'insert_after' ? 1 : 0)
    nb.cells.splice(at, 0, fresh())
    summary = `Added a ${type} cell at ${at}.`
  } else {
    const i = findCell(nb, op.cell)
    if (op.action === 'delete') {
      nb.cells.splice(i, 1)
      summary = `Deleted cell ${i}.`
    } else if (op.action === 'replace') {
      const c = nb.cells[i]!
      c.source = splitSource(op.source)
      if (op.cellType && op.cellType !== c.cell_type) {
        c.cell_type = type
        if (type === 'code') {
          c.outputs = []
          c.execution_count = null
        } else {
          delete c.outputs
          delete c.execution_count
        }
      } else if (c.cell_type === 'code') {
        // the old output no longer matches the code
        c.outputs = []
        c.execution_count = null
      }
      summary = `Replaced cell ${i}.`
    } else throw new Error('action must be replace, insert_after, insert_before, append or delete.')
  }
  return { content: `${JSON.stringify(nb, null, 1)}\n`, summary }
}

export const editNotebookTool: AgentTool = {
  spec: {
    name: 'edit_notebook',
    description:
      'Change one cell of a Jupyter notebook (.ipynb). Read it first with read_file, which numbers the cells. action: replace (new source for the cell; a code cell loses its old output), insert_after / insert_before (a new cell next to `cell`), append (a new cell at the end), delete. cell is the number read_file showed, or the cell id. cell_type: code (default), markdown or raw.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        action: { type: 'string', enum: ['replace', 'insert_after', 'insert_before', 'append', 'delete'] },
        cell: { type: 'string', description: 'Cell number or id (not needed for append)' },
        source: { type: 'string', description: 'The cell\'s full new text' },
        cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'] }
      },
      required: ['path', 'action']
    }
  },
  primaryArg: 'path',
  readOnly: false,
  risk: () => 'medium',
  summary: (a) => `${str(a, 'action')} cell ${str(a, 'cell')} in ${str(a, 'path')}`,
  async execute(args, ctx) {
    const path = str(args, 'path')
    if (!/\.ipynb$/i.test(path)) return err('edit_notebook is for .ipynb files. Use edit_file for anything else.')
    try {
      const f = await ctx.workspace.read(path)
      const cell = args['cell'] === undefined || args['cell'] === null ? '' : String(args['cell'])
      const r = editNotebook(f.content, { action: str(args, 'action'), cell, source: str(args, 'source'), cellType: str(args, 'cell_type') })
      await ctx.checkpoint([path])
      await ctx.workspace.write(path, r.content)
      ctx.emit({ type: 'file-touched', path, op: 'edit' })
      return { content: `${r.summary} ${path} saved.`, isError: false, meta: { path } }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}
