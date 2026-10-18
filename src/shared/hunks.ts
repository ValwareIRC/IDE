import * as Diff from 'diff'

/** One contiguous piece of a change, the unit a reviewer accepts or rejects. */
export interface Hunk {
  index: number
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Unified-diff lines: ' ' context, '+' added, '-' removed. */
  lines: string[]
  additions: number
  deletions: number
}

const CONTEXT = 3

export function hunksOf(before: string, after: string): Hunk[] {
  const p = Diff.structuredPatch('a', 'b', before, after, '', '', { context: CONTEXT })
  return p.hunks.map((h, index) => {
    const lines = h.lines.filter((l) => !l.startsWith('\\'))
    return {
      index,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines,
      additions: lines.filter((l) => l.startsWith('+')).length,
      deletions: lines.filter((l) => l.startsWith('-')).length
    }
  })
}

/** `before` with only the chosen pieces of the before→after change applied. */
export function applyHunks(before: string, after: string, keep: (index: number) => boolean): string {
  const p = Diff.structuredPatch('a', 'b', before, after, '', '', { context: CONTEXT })
  const hunks = p.hunks.filter((_, i) => keep(i))
  if (hunks.length === p.hunks.length) return after
  if (!hunks.length) return before
  const r = Diff.applyPatch(before, { ...p, hunks })
  if (r === false) throw new Error('Those pieces could not be separated cleanly. Accept or reject the whole file instead.')
  return r
}
