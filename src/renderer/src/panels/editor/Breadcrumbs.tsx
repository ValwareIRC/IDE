import { useMemo } from 'react'
import { BookOpen, ChevronRight, Columns2, UserRound } from 'lucide-react'
import { useLayout } from '@/state/layout'
import { useUi } from '@/state/ui'
import { useOutline, symbolsAt } from '@/state/outline'
import { FileIcon } from '@/components/FileIcon'
import { previewKindFor } from '@/lib/languages'

/** Where you are: folder › file › class › function. Click a symbol to jump to it. */
export function Breadcrumbs({ path, blame, onBlame }: { path: string; blame: boolean; onBlame: () => void }): React.JSX.Element {
  const symbols = useOutline((s) => s.symbols[path])
  const cursor = useOutline((s) => s.cursor[path])
  const openEditor = useLayout((s) => s.openEditor)
  const chain = useMemo(() => (symbols && cursor ? symbolsAt(symbols, cursor) : []), [symbols, cursor])
  const parts = path.split('/')
  const file = parts.pop() ?? path
  const kind = previewKindFor(path)

  return (
    <div className="crumbs">
      <div className="crumbs-path">
        {parts.map((p, i) => (
          <span key={i} className="crumb dim">
            {p}
            <ChevronRight size={11} className="faint" />
          </span>
        ))}
        <button className="crumb file" title="Jump to a function in this file" onClick={() => useUi.getState().setPalette('symbols')}>
          <FileIcon name={file} size={12} />
          {file}
        </button>
        {chain.map((s) => (
          <button key={`${s.line}:${s.name}`} className="crumb sym" title={`${s.kind} · line ${s.line}`} onClick={() => openEditor(path, { line: s.line })}>
            <ChevronRight size={11} className="faint" />
            {s.name}
          </button>
        ))}
      </div>
      <span className="grow" />
      {(kind === 'markdown' || kind === 'html') && (
        <button className="icon-btn sm" title="Show the rendered page beside this" onClick={() => useLayout.getState().openPreviewBeside(path)}>
          <BookOpen size={13} />
        </button>
      )}
      <button className={blame ? 'icon-btn sm on' : 'icon-btn sm'} title="Who last changed each line, and when" onClick={onBlame}>
        <UserRound size={13} />
      </button>
      <button className="icon-btn sm" title="Split: a second view of this file" onClick={() => useLayout.getState().openEditorBeside(path)}>
        <Columns2 size={13} />
      </button>
    </div>
  )
}
