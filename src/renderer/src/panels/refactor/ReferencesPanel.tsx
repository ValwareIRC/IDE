import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, LocateFixed, Pencil } from 'lucide-react'
import type { RefHit } from '@shared/types'
import { useRefactor } from '@/state/refactor'
import { useLayout } from '@/state/layout'
import { FileIcon } from '@/components/FileIcon'
import { cx } from '@/lib/format'

/** Every place a name is used, grouped by file. */
export function ReferencesPanel(): React.JSX.Element {
  const refs = useRefactor((s) => s.refs)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const groups = useMemo(() => {
    const m = new Map<string, RefHit[]>()
    for (const h of refs?.hits ?? []) m.set(h.path, [...(m.get(h.path) ?? []), h])
    return [...m.entries()]
  }, [refs])

  if (!refs) {
    return (
      <div className="empty">
        <LocateFixed size={24} className="faint" />
        <div>Put the cursor on a name in the editor and press Shift+F12 to see everywhere it is used.</div>
      </div>
    )
  }

  const openEditor = useLayout.getState().openEditor
  return (
    <div className="problems">
      <div className="problems-bar">
        <LocateFixed size={14} className="accent" />
        <span className="mono">{refs.word}</span>
        <span className="faint small">
          {refs.hits.length} place{refs.hits.length === 1 ? '' : 's'} in {groups.length} file{groups.length === 1 ? '' : 's'}
        </span>
        <span className={cx('chip xs', refs.byMeaning ? 'mint' : 'amber')} title={refs.byMeaning ? 'Found by what the code means, so other things with the same name are left out' : 'Found as a whole word: other things with the same name are included'}>
          {refs.byMeaning ? 'by meaning' : 'by text'}
        </span>
        <span className="grow" />
        <button className="btn sm" onClick={() => useRefactor.getState().askRename(refs)} title="Rename it everywhere">
          <Pencil size={12} /> Rename
        </button>
      </div>
      <div className="problems-body">
        {!refs.hits.length && <div className="empty small faint">Nothing else uses {refs.word}.</div>}
        {groups.map(([file, list]) => {
          const open = !closed.has(file)
          return (
            <div key={file} className="problem-group">
              <div
                className="problem-file"
                onClick={() =>
                  setClosed((s) => {
                    const n = new Set(s)
                    if (n.has(file)) n.delete(file)
                    else n.add(file)
                    return n
                  })
                }
              >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <FileIcon name={file} size={13} />
                <span className="truncate">{file.split('/').pop()}</span>
                <span className="faint xs truncate">{file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''}</span>
                <span className="problem-n">{list.length}</span>
              </div>
              {open &&
                list.map((h, i) => (
                  <div key={i} className="problem-row" onClick={() => openEditor(h.path, { line: h.line, column: h.column })}>
                    <span className="faint xs mono ref-line">{h.line}</span>
                    <span className="mono small truncate">{h.text}</span>
                    <span className="grow" />
                    {h.kind !== 'read' && <span className={cx('chip xs', h.kind === 'definition' ? 'accent' : 'violet')}>{h.kind === 'definition' ? 'defined here' : 'set here'}</span>}
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
