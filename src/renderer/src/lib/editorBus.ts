import * as Diff from 'diff'
import { monaco } from './monaco'

/** Mounted editors by workspace path, so agent edits can light up the lines they changed. */

export interface FlashRange {
  start: number
  end: number
}

// one file can be open in several panels (split views); the last one focused or mounted is "the" editor for it
const editors = new Map<string, monaco.editor.IStandaloneCodeEditor[]>()
const pending = new Map<string, FlashRange[]>()

export function registerEditor(path: string, ed: monaco.editor.IStandaloneCodeEditor): () => void {
  editors.set(path, [...(editors.get(path) ?? []), ed])
  const focus = ed.onDidFocusEditorText(() => {
    const list = editors.get(path) ?? []
    editors.set(path, [...list.filter((x) => x !== ed), ed])
  })
  const p = pending.get(path)
  if (p) {
    pending.delete(path)
    setTimeout(() => flashLines(path, p), 60)
  }
  return () => {
    focus.dispose()
    const rest = (editors.get(path) ?? []).filter((x) => x !== ed)
    if (rest.length) editors.set(path, rest)
    else editors.delete(path)
  }
}

export function editorFor(path: string): monaco.editor.IStandaloneCodeEditor | undefined {
  const list = editors.get(path)
  return list?.[list.length - 1]
}

/** Where an editor is looking: the outline, breadcrumbs and the markdown preview follow it. */
export interface EditorView {
  path: string
  cursorLine: number
  topLine: number
}

const viewListeners = new Set<(v: EditorView) => void>()

export function emitView(v: EditorView): void {
  for (const cb of viewListeners) cb(v)
}

export function onEditorView(cb: (v: EditorView) => void): () => void {
  viewListeners.add(cb)
  return () => viewListeners.delete(cb)
}

export function flashLines(path: string, ranges: FlashRange[]): void {
  if (!ranges.length) return
  const list = editors.get(path)
  if (!list?.length) {
    pending.set(path, ranges)
    return
  }
  for (const ed of list) {
    const model = ed.getModel()
    if (!model) continue
    const max = model.getLineCount()
    const decos = ed.createDecorationsCollection(
      ranges
        .filter((r) => r.start <= max)
        .map((r) => ({
          range: new monaco.Range(r.start, 1, Math.min(r.end, max), 1),
          options: { isWholeLine: true, className: 'agent-flash', linesDecorationsClassName: 'agent-flash-gutter' }
        }))
    )
    ed.revealLineInCenterIfOutsideViewport(ranges[0]!.start, monaco.editor.ScrollType.Smooth)
    setTimeout(() => decos.clear(), 2800)
  }
}

/** Line ranges in `after` that were added or changed relative to `before`. */
export function changedRanges(before: string | null, after: string | null): FlashRange[] {
  if (after === null) return []
  if (before === null) return [{ start: 1, end: Math.max(1, after.split('\n').length) }]
  const out: FlashRange[] = []
  let line = 1
  for (const part of Diff.diffLines(before, after)) {
    const n = part.count ?? part.value.split('\n').length - 1
    if (part.added) {
      out.push({ start: line, end: line + Math.max(1, n) - 1 })
      line += n
    } else if (!part.removed) {
      line += n
    }
  }
  // merge adjacent
  const merged: FlashRange[] = []
  for (const r of out) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}
