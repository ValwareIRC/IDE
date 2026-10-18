import { useEffect, useRef } from 'react'
import { currentTheme, fontStack } from '@/theme/apply'
import { setupMonaco, monaco } from '@/lib/monaco'
import { languageFor } from '@/lib/languages'

export function DiffPanel({ path, before, after }: { path: string; before: string; after: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!hostRef.current) return
    const m = setupMonaco()
    const lang = languageFor(path)
    const original = m.editor.createModel(before, lang)
    const modified = m.editor.createModel(after, lang)
    const ed = m.editor.createDiffEditor(hostRef.current, {
      theme: 'prism',
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      fontFamily: fontStack(currentTheme().look.fontMono, true),
      fontSize: 12.5,
      lineHeight: 19,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      ignoreTrimWhitespace: false,
      diffWordWrap: 'off',
      useInlineViewWhenSpaceIsLimited: true,
      padding: { top: 8 }
    })
    ed.setModel({ original, modified })
    return () => {
      ed.dispose()
      original.dispose()
      modified.dispose()
    }
  }, [path, before, after])
  return (
    <div className="editor-host">
      <div ref={hostRef} className="editor-mount" />
    </div>
  )
}

void monaco
