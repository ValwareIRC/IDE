import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { prism } from '@/lib/ipc'
import { previewKindFor } from '@/lib/languages'
import { Markdown } from '@/components/Markdown'
import { useLayout } from '@/state/layout'
import { toastError } from '@/state/ui'
import { useEditor } from '@/state/editor'
import { onEditorView } from '@/lib/editorBus'
import { ImageStudio } from './ImageStudio'
import { AudioStudio } from './AudioStudio'

const Model3D = lazy(() => import('./Model3D').then((m) => ({ default: m.Model3D })))

export function PreviewPanel({ path, note }: { path: string; note?: string }): React.JSX.Element {
  const kind = previewKindFor(path)
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const openEditor = useLayout((s) => s.openEditor)
  // while the file is open in an editor, show what is being typed, not what is on disk
  const live = useEditor((s) => (kind === 'markdown' ? s.docs[path]?.content : undefined))
  const docRef = useRef<HTMLDivElement>(null)

  // follow the editor: bring the block for its top line to the top of the preview
  useEffect(() => {
    if (kind !== 'markdown') return
    return onEditorView((v) => {
      const doc = docRef.current
      const el = doc?.parentElement
      if (!doc || !el || v.path !== path) return
      const blocks = [...doc.querySelectorAll<HTMLElement>('[data-line]')]
      let at: HTMLElement | null = null
      let next: HTMLElement | null = null
      for (const b of blocks) {
        if (Number(b.dataset['line']) <= v.topLine) at = b
        else {
          next = b
          break
        }
      }
      if (!at) {
        el.scrollTop = 0
        return
      }
      const base = el.getBoundingClientRect().top - el.scrollTop
      const top = at.getBoundingClientRect().top - base
      const from = Number(at.dataset['line'])
      const to = next ? Number(next.dataset['line']) : from + 1
      const span = next ? next.getBoundingClientRect().top - at.getBoundingClientRect().top : at.offsetHeight
      el.scrollTop = top + (span * Math.min(1, (v.topLine - from) / Math.max(1, to - from))) - 12
    })
  }, [kind, path])

  useEffect(() => {
    let alive = true
    void prism.fs.assetUrl(path).then((u) => alive && setUrl(u)).catch(toastError)
    if (kind === 'markdown') void prism.fs.read(path).then((f) => alive && setText(f.content)).catch(toastError)
    return () => {
      alive = false
    }
  }, [path, kind, tick])

  useEffect(() => {
    return prism.fs.onChanged((changes) => {
      if (changes.some((c) => c.path === path)) setTick((n) => n + 1)
    })
  }, [path])

  return (
    <div className="preview">
      <div className="preview-bar">
        <span className="mono small truncate" title={path}>
          {path}
        </span>
        {note && <span className="chip accent truncate">{note}</span>}
        <span className="grow" />
        {(kind === 'markdown' || kind === 'html') && (
          <button className="btn sm ghost" onClick={() => openEditor(path)}>
            Edit source
          </button>
        )}
        <button className="icon-btn sm" title="Reload" onClick={() => setTick((n) => n + 1)}>
          <RefreshCw size={13} />
        </button>
        <button className="icon-btn sm" title="Reveal in file manager" onClick={() => void prism.app.reveal(path)}>
          <ExternalLink size={13} />
        </button>
      </div>
      <div className="preview-body">
        {!url && <div className="empty">Loading…</div>}
        {url && kind === 'image' && <ImageStudio url={url} path={path} />}
        {url && kind === 'model3d' && (
          <Suspense fallback={<div className="empty">Loading 3D viewer…</div>}>
            <Model3D url={url} path={path} />
          </Suspense>
        )}
        {url && kind === 'audio' && <AudioStudio url={url} path={path} />}
        {url && kind === 'video' && (
          <div className="preview-center">
            <video src={url} controls style={{ maxWidth: '100%', maxHeight: '100%' }} />
          </div>
        )}
        {url && kind === 'pdf' && <iframe title={path} src={url} className="preview-frame" />}
        {url && kind === 'html' && <iframe title={path} src={url} className="preview-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups" />}
        {kind === 'markdown' && (live ?? text) !== null && (
          <div
            className="preview-doc"
            ref={docRef}
            title="Double-click a paragraph to edit it"
            onDoubleClick={(e) => {
              const block = (e.target as HTMLElement).closest<HTMLElement>('[data-line]')
              if (block) openEditor(path, { line: Number(block.dataset['line']) })
            }}
          >
            <Markdown text={live ?? text ?? ''} onOpenFile={(p) => openEditor(p)} sourceLines />
          </div>
        )}
        {url && kind === null && (
          <div className="empty">
            <div className="title">No preview for this file type</div>
            <button className="btn" onClick={() => openEditor(path)}>
              Open as text
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
