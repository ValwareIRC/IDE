import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import { currentTheme, editorTheme, fontStack, onTheme } from '@/theme/apply'
import type { LineOrigin } from '@shared/types'
import { prism } from './ipc'
import { TOOL_TYPES } from '@shared/extend'
import { fontReady } from './fonts'

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment
  }
}

let ready = false

export function setupMonaco(): typeof monaco {
  if (ready) return monaco
  ready = true
  self.MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
      if (label === 'json') return new jsonWorker()
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
      if (label === 'typescript' || label === 'javascript') return new tsWorker()
      return new editorWorker()
    }
  }

  // the editor follows the app's theme, now and whenever it changes
  monaco.editor.defineTheme('prism', editorTheme(currentTheme()))
  onTheme((theme) => {
    monaco.editor.defineTheme('prism', editorTheme(theme))
    monaco.editor.setTheme('prism')
    for (const ed of monaco.editor.getEditors()) ed.updateOptions({ fontFamily: fontStack(theme.look.fontMono, true) })
    // letter widths are measured once: measure again when a font that was still loading arrives
    void fontReady(theme.look.fontMono).then(() => monaco.editor.remeasureFonts())
  })
  void fontReady(currentTheme().look.fontMono).then(() => monaco.editor.remeasureFonts())

  monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
  explainLines(monaco)

  // what a file in .prism/tools can use (defineTool and the prism object), for completions and hovers
  monaco.typescript.typescriptDefaults.addExtraLib(TOOL_TYPES, 'file:///prism-tools-api.d.ts')
  monaco.typescript.typescriptDefaults.setCompilerOptions({
    jsx: monaco.typescript.JsxEmit.Preserve,
    target: monaco.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    allowJs: true
  })
  return monaco
}

export { monaco }

/** Hovering a line the agent wrote says which request put it there and why, with a way to undo that request. */
function explainLines(m: typeof monaco): void {
  const cache = new Map<string, { at: number; origin: LineOrigin | null }>()
  // loaded when used: these stores import the editor in turn
  m.editor.registerCommand('prism.undoRequest', (_a, sessionId: string, turnItemId: string) => void import('@/state/refactor').then((r) => r.undoRequest(sessionId, turnItemId)))
  m.editor.registerCommand('prism.openSession', (_a, sessionId: string) => {
    void Promise.all([import('@/state/layout'), import('@/state/sessions')]).then(([l, s]) => {
      l.useLayout.getState().openAgent()
      void s.useSessions.getState().select(sessionId)
    })
  })
  m.editor.registerCommand('prism.timeMachine', (_a, sessionId: string) => void import('@/state/layout').then((l) => l.useLayout.getState().openTimeline(sessionId)))
  m.languages.registerHoverProvider('*', {
    async provideHover(model, position) {
      if (model.uri.scheme !== 'file') return null
      const path = model.uri.path.replace(/^\//, '')
      const line = model.getLineContent(position.lineNumber)
      const key = `${path}\n${line.trim()}`
      let hit = cache.get(key)
      if (!hit || Date.now() - hit.at > 20_000) {
        hit = { at: Date.now(), origin: await prism.history.why(path, line).catch(() => null) }
        cache.set(key, hit)
      }
      const o = hit.origin
      if (!o) return null
      const arg = (...a: string[]): string => encodeURIComponent(JSON.stringify(a))
      const when = new Date(o.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      const md = [
        `**Written by the agent**${o.model ? ` (${o.model})` : ''} · ${when} · *${o.sessionTitle}*`,
        o.request ? `**You asked:** ${o.request}` : '',
        o.reason ? `**Its reason:** ${o.reason}` : '',
        [`[Open the conversation](command:prism.openSession?${arg(o.sessionId)})`, `[Time machine](command:prism.timeMachine?${arg(o.sessionId)})`, ...(o.turnItemId ? [`[Undo that request](command:prism.undoRequest?${arg(o.sessionId, o.turnItemId)})`] : [])].join(' · ')
      ].filter(Boolean)
      return { range: new m.Range(position.lineNumber, 1, position.lineNumber, model.getLineMaxColumn(position.lineNumber)), contents: md.map((value) => ({ value, isTrusted: true, supportThemeIcons: false })) }
    }
  })
}
