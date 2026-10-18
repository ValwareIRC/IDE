import { useEffect, useRef, useState } from 'react'
import { currentTheme, fontStack } from '@/theme/apply'
import { useRefactor, type Spot } from '@/state/refactor'
import { Sparkles } from 'lucide-react'
import { setupMonaco, monaco } from '@/lib/monaco'
import { attachAgentLines } from '@/lib/agentLines'
import { prism } from '@/lib/ipc'
import { useEditor, isDirty } from '@/state/editor'
import { useApp } from '@/state/app'
import { toastError, useUi } from '@/state/ui'
import { InlineEditWidget, type InlineContext } from './InlineEdit'
import { modelFor } from '@/lib/models'
import { emitView, registerEditor } from '@/lib/editorBus'
import { useOutline } from '@/state/outline'
import { Breadcrumbs } from './Breadcrumbs'
import { askAgentAbout, registerAgentCodeActions } from '@/lib/monacoActions'
import { useLooking } from '@/state/looking'
import type { Settings } from '@shared/types'

/** The editor options that follow Settings, Editor. */
function editorOptions(e: Settings['editor'] | undefined): monaco.editor.IEditorOptions & { tabSize: number; insertSpaces: boolean } {
  return {
    fontSize: e?.fontSize ?? 13,
    fontLigatures: e?.fontLigatures ?? true,
    lineHeight: e?.lineHeight ?? 20,
    lineNumbers: e?.lineNumbers ?? 'on',
    minimap: { enabled: e?.minimap ?? false },
    wordWrap: e?.wordWrap ? 'on' : 'off',
    tabSize: e?.tabSize ?? 2,
    insertSpaces: e?.insertSpaces ?? true,
    stickyScroll: { enabled: e?.stickyScroll ?? true },
    bracketPairColorization: { enabled: e?.bracketColours ?? true },
    guides: { bracketPairs: e?.bracketColours ?? true, indentation: true },
    renderWhitespace: e?.renderWhitespace ?? 'selection',
    cursorBlinking: e?.cursorBlinking ?? 'smooth',
    smoothScrolling: e?.smoothScrolling ?? true
  }
}

let completionProviderRegistered = false

function registerGhostText(): void {
  if (completionProviderRegistered) return
  completionProviderRegistered = true
  let timer: ReturnType<typeof setTimeout> | null = null
  monaco.languages.registerInlineCompletionsProvider('*', {
    provideInlineCompletions: async (model, position, _ctx, token) => {
      const settings = useApp.getState().settings
      if (!settings?.editor.ghostText || !settings.roles.completion) return { items: [] }
      if (timer) clearTimeout(timer)
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, settings.editor.ghostTextDelayMs)
      })
      if (token.isCancellationRequested) return { items: [] }
      const text = model.getValue()
      const offset = model.getOffsetAt(position)
      const path = model.uri.path.replace(/^\//, '')
      try {
        const insert = await prism.completions.inline({ path, language: model.getLanguageId(), prefix: text.slice(0, offset), suffix: text.slice(offset) })
        if (!insert || token.isCancellationRequested) return { items: [] }
        return { items: [{ insertText: insert, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] }
      } catch {
        return { items: [] }
      }
    },
    disposeInlineCompletions: () => {}
  })
}

export function EditorPanel({ path, reveal, onTitle }: { path: string; reveal: { line: number; column?: number } | null; onTitle?: (dirty: boolean) => void }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const doc = useEditor((s) => s.docs[path])
  const open = useEditor((s) => s.open)
  const setContent = useEditor((s) => s.setContent)
  const save = useEditor((s) => s.save)
  const settings = useApp((s) => s.settings)
  const [inlineEdit, setInlineEdit] = useState<{ top: number | null; context: InlineContext; range: monaco.Range } | null>(null)
  const dirty = isDirty(doc)
  const [blame, setBlame] = useState(false)

  // who changed each line: a note in front of the first line of every run of lines from the same commit
  useEffect(() => {
    const ed = edRef.current
    if (!blame || !ed) return
    let alive = true
    let decos: monaco.editor.IEditorDecorationsCollection | null = null
    void prism.git
      .blame(path)
      .then((lines) => {
        if (!alive) return
        if (!lines.length) {
          useUi.getState().toast('info', 'No history for this file yet', 'It has not been committed.')
          setBlame(false)
          return
        }
        const WIDTH = 38
        const max = ed.getModel()?.getLineCount() ?? 0
        const note = (l: (typeof lines)[number]): string => {
          const when = new Date(l.date)
          const text = /^0+$/.test(l.sha) ? 'not committed yet' : `${l.author.split(' ')[0]} · ${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' })} · ${l.summary}`
          return (text.length > WIDTH - 2 ? text.slice(0, WIDTH - 3) + '…' : text).padEnd(WIDTH, '\u00a0')
        }
        decos = ed.createDecorationsCollection(
          lines
            .filter((l) => l.line <= max)
            .map((l, i) => ({
              range: new monaco.Range(l.line, 1, l.line, ed.getModel()?.getLineMaxColumn(l.line) ?? 1),
              options: { showIfCollapsed: true, before: { content: i > 0 && lines[i - 1]!.sha === l.sha ? '\u00a0'.repeat(WIDTH) : note(l), inlineClassName: 'blame-note', inlineClassNameAffectsLetterSpacing: true }, hoverMessage: { value: `**${l.summary}**\n\n${l.author} · ${new Date(l.date).toLocaleString()} · \`${l.sha.slice(0, 8)}\`` } }
            }))
        )
      })
      .catch(toastError)
    return () => {
      alive = false
      decos?.clear()
    }
  }, [blame, path, doc?.savedContent]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!doc) void open(path, reveal)
  }, [path]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onTitle?.(dirty)
  }, [dirty, onTitle])

  // mount editor once the document is loaded
  useEffect(() => {
    if (!doc || doc.binary || !hostRef.current || edRef.current) return
    const m = setupMonaco()
    registerGhostText()
    registerAgentCodeActions()
    const model = modelFor(path, doc.content, doc.language)
    const ed = m.editor.create(hostRef.current, {
      model,
      theme: 'prism',
      automaticLayout: true,
      fontFamily: fontStack(currentTheme().look.fontMono, true),
      ...editorOptions(settings?.editor),
      renderLineHighlight: 'all',
      cursorSmoothCaretAnimation: 'on',
      scrollBeyondLastLine: false,
      padding: { top: 10, bottom: 10 },
      inlineSuggest: { enabled: true, showToolbar: 'onHover' },
      suggest: { preview: true },
      scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      readOnly: doc.truncated
    })
    edRef.current = ed
    const unregister = registerEditor(path, ed)
    if (doc.viewState) ed.restoreViewState(doc.viewState as monaco.editor.ICodeEditorViewState)
    // auto-save (Settings, Editor): a moment after typing stops, or when the editor loses focus
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    const autoSave = (): void => {
      const st = useEditor.getState()
      if (isDirty(st.docs[path]) && !st.docs[path]?.truncated) void st.save(path, true).catch(() => {})
    }
    ed.onDidChangeModelContent(() => {
      setContent(path, ed.getValue())
      useOutline.getState().refresh(path)
      const e = useApp.getState().settings?.editor
      if (e?.autoSave === 'delay') {
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(autoSave, Math.max(200, e.autoSaveDelayMs ?? 1000))
      }
    })
    ed.onDidBlurEditorText(() => {
      if (useApp.getState().settings?.editor.autoSave === 'focus') autoSave()
    })
    ed.onDidDispose(() => saveTimer && clearTimeout(saveTimer))
    const tellView = (): void => emitView({ path, cursorLine: ed.getPosition()?.lineNumber ?? 1, topLine: ed.getVisibleRanges()[0]?.startLineNumber ?? 1 })
    ed.onDidChangeCursorPosition(tellView)
    ed.onDidScrollChange((e) => e.scrollTopChanged && tellView())
    useOutline.getState().refresh(path)
    tellView()
    ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
      const run = async (): Promise<void> => {
        if (useApp.getState().settings?.editor.formatOnSave) {
          try {
            await ed.getAction('editor.action.formatDocument')?.run()
          } catch {
            /* no formatter for this language */
          }
        }
        await save(path)
      }
      void run()
    })
    ed.addAction({
      id: 'prism.inlineEdit',
      label: 'Edit selection with Prism',
      keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyK, m.KeyMod.CtrlCmd | m.KeyCode.KeyI],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2,
      run: () => {
        const model = ed.getModel()
        let sel: monaco.Range | null = ed.getSelection()
        if (!sel || !model) return
        // no selection: the current line if it has text, else write new code at the cursor
        if (sel.isEmpty()) {
          const ln = sel.startLineNumber
          if (model.getLineContent(ln).trim()) sel = new monaco.Range(ln, 1, ln, model.getLineMaxColumn(ln))
        }
        const last = model.getLineCount()
        const context: InlineContext = {
          path,
          language: model.getLanguageId(),
          selection: model.getValueInRange(sel),
          before: model.getValueInRange(new monaco.Range(1, 1, sel.startLineNumber, sel.startColumn)),
          after: model.getValueInRange(new monaco.Range(sel.endLineNumber, sel.endColumn, last, model.getLineMaxColumn(last)))
        }
        // below the selection when there is room, so the code being changed stays visible
        const below = ed.getTopForLineNumber(sel.endLineNumber + 1) - ed.getScrollTop()
        const height = ed.getLayoutInfo().height
        // no room below: sit on the bottom edge and grow upwards (top = null)
        setInlineEdit({ top: below < height - 220 ? Math.max(8, below + 4) : null, context, range: sel })
      }
    })
    const spot = (): Spot | null => {
      const model = ed.getModel()
      const pos = ed.getPosition()
      if (!model || !pos) return null
      const w = model.getWordAtPosition(pos)
      return { path, line: pos.lineNumber, column: w ? w.startColumn : pos.column, word: w?.word ?? '' }
    }
    ed.addAction({
      id: 'prism.renameEverywhere',
      label: 'Rename everywhere',
      keybindings: [m.KeyCode.F2],
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1,
      run: () => {
        const s = spot()
        if (s) useRefactor.getState().askRename(s)
      }
    })
    ed.addAction({
      id: 'prism.findUses',
      label: 'Find everywhere this is used',
      keybindings: [m.KeyMod.Shift | m.KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 3,
      run: () => {
        const s = spot()
        if (s) void useRefactor.getState().references(s)
      }
    })
    ed.addAction({
      id: 'prism.askAgent',
      label: 'Ask Prism about this selection',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: () => {
        const sel = ed.getModel()?.getValueInRange(ed.getSelection()!) ?? ''
        const line = ed.getSelection()?.startLineNumber ?? 1
        askAgentAbout(path, line, sel, '')
      }
    })
    ed.addAction({
      id: 'prism.conversationsForFile',
      label: 'Conversations that changed this file',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 4,
      run: () => {
        void Promise.all([import('@/state/find'), import('@/state/layout')]).then(([f, l]) => {
          f.useFind.getState().presetSearch({ file: path })
          l.useLayout.getState().openSearchChats()
        })
      }
    })
    ed.addAction({
      id: 'prism.explainSelection',
      label: 'Explain this with Prism',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: () => {
        const sel = ed.getModel()?.getValueInRange(ed.getSelection()!) ?? ''
        const line = ed.getSelection()?.startLineNumber ?? 1
        askAgentAbout(path, line, sel, 'Explain what this code does and point out anything wrong with it.')
      }
    })
    if (!doc.reveal?.quiet) ed.focus()
    if (doc.reveal) revealIn(ed, doc.reveal)
    const detachLines = attachAgentLines(monaco, ed, path)
    // what the message box offers as "what you are looking at"
    const seeNow = (): void => {
      const sel = ed.getSelection()
      const model = ed.getModel()
      if (!sel || !model) return
      useLooking.getState().see({ path, line: sel.startLineNumber, endLine: sel.endLineNumber, text: sel.isEmpty() ? '' : model.getValueInRange(sel).slice(0, 60_000), at: Date.now() })
    }
    seeNow()
    const watchSel = ed.onDidChangeCursorSelection(seeNow)
    const watchFocus = ed.onDidFocusEditorText(seeNow)
    return () => {
      watchSel.dispose()
      watchFocus.dispose()
      detachLines()
      useEditor.getState().setViewState(path, ed.saveViewState())
      unregister()
      ed.dispose()
      edRef.current = null
    }
  }, [doc?.path, doc?.binary]) // eslint-disable-line react-hooks/exhaustive-deps

  // external content changes (reload / agent edits) → sync model without losing cursor
  useEffect(() => {
    const ed = edRef.current
    if (!ed || !doc) return
    const model = ed.getModel()
    if (model && model.getValue() !== doc.content) {
      const vs = ed.saveViewState()
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: doc.content }], () => null)
      if (vs) ed.restoreViewState(vs)
    }
  }, [doc?.content]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ed = edRef.current
    if (ed && doc?.reveal) revealIn(ed, doc.reveal)
  }, [doc?.reveal])

  useEffect(() => {
    const o = editorOptions(settings?.editor)
    edRef.current?.updateOptions(o)
    edRef.current?.getModel()?.updateOptions({ tabSize: o.tabSize, insertSpaces: o.insertSpaces })
  }, [settings?.editor])

  if (doc?.binary) {
    return (
      <div className="empty">
        <div className="title">Binary file</div>
        <div>{path} cannot be edited as text.</div>
      </div>
    )
  }

  return (
    <div className="editor-host">
      <Breadcrumbs path={path} blame={blame} onBlame={() => setBlame((v) => !v)} />
      <div className="editor-area">
      <div ref={hostRef} className="editor-mount" />
      {inlineEdit && edRef.current && (
        <InlineEditWidget
          top={inlineEdit.top}
          context={inlineEdit.context}
          onClose={() => {
            setInlineEdit(null)
            edRef.current?.focus()
          }}
          onAccept={(replacement) => {
            edRef.current?.executeEdits('prism-inline-edit', [{ range: inlineEdit.range, text: replacement }])
            useUi.getState().toast('success', 'Change applied', 'Ctrl+Z undoes it')
          }}
        />
      )}
      {doc?.truncated && (
        <div className="editor-banner">
          <Sparkles size={12} /> Large file: showing the first 2 MB read-only.
        </div>
      )}
      </div>
    </div>
  )
}

function revealIn(ed: monaco.editor.IStandaloneCodeEditor, r: { line: number; column?: number; quiet?: boolean }): void {
  const pos = { lineNumber: r.line, column: r.column ?? 1 }
  if (r.quiet) {
    ed.revealLineInCenterIfOutsideViewport(r.line, monaco.editor.ScrollType.Smooth)
    return
  }
  ed.setPosition(pos)
  ed.revealPositionInCenter(pos, monaco.editor.ScrollType.Smooth)
  ed.focus()
}
