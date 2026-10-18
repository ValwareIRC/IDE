import { monaco } from './monaco'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'

let registered = false

/** Hand a snippet to the agent: fills the composer and opens the panel. */
export function askAgentAbout(path: string, line: number, code: string, intro: string): void {
  const draft = `${intro}\n\n@${path} (line ${line})\n\`\`\`\n${code}\n\`\`\`\n`
  useLayout.getState().openAgent()
  const st = useSessions.getState()
  if (st.active) st.setDraft(st.active, draft)
  else void st.create().then((s) => s && useSessions.getState().setDraft(s.id, draft))
}

/** "Fix with Prism" on any diagnostic, in the lightbulb menu and the context menu. */
export function registerAgentCodeActions(): void {
  if (registered) return
  registered = true

  monaco.editor.registerCommand('prism.fixDiagnostic', (_accessor, path: string, line: number, message: string, code: string) => {
    askAgentAbout(path, line, code, `Fix this problem: ${message}`)
  })

  monaco.languages.registerCodeActionProvider('*', {
    provideCodeActions(model, range, context) {
      const path = model.uri.path.replace(/^\//, '')
      const actions: monaco.languages.CodeAction[] = []
      for (const m of context.markers) {
        if (m.severity < monaco.MarkerSeverity.Warning) continue
        const from = Math.max(1, m.startLineNumber - 3)
        const to = Math.min(model.getLineCount(), m.endLineNumber + 3)
        const code = model.getValueInRange(new monaco.Range(from, 1, to, model.getLineMaxColumn(to)))
        actions.push({
          title: `✦ Fix with Prism: ${m.message.slice(0, 60)}`,
          kind: 'quickfix',
          diagnostics: [m],
          isPreferred: true,
          command: { id: 'prism.fixDiagnostic', title: 'Fix with Prism', arguments: [path, m.startLineNumber, m.message, code] }
        })
      }
      void range
      return { actions, dispose: () => {} }
    }
  })
}
