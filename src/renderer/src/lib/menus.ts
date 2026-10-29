import { prism } from './ipc'
import { openLink } from './open'
import { placeLabel } from '@shared/place'
import { monaco } from './monaco'
import { editorFor } from './editorBus'
import { basename } from './format'
import { useApp } from '@/state/app'
import { useEditor } from '@/state/editor'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { useTerminals } from '@/state/terminals'
import { toastError, useUi } from '@/state/ui'
import { useRefactor } from '@/state/refactor'
import { copyText } from '@/lib/copy'
import { CONV_DEFAULT, LAYOUTS } from '@/panels/agent/Turns'

const conv = (): typeof CONV_DEFAULT => ({ ...CONV_DEFAULT, ...useApp.getState().settings?.conversation })

/** Declarative menu model for the menu bar and the command palette. */

export type MenuItem =
  | { sep: true }
  | {
      sep?: false
      id: string
      label: string
      hint?: string
      checked?: boolean
      disabled?: boolean
      danger?: boolean
      submenu?: MenuItem[]
      run?: () => void
    }

export interface MenuGroup {
  id: string
  label: string
  items: () => MenuItem[]
}

function activeEditor(): monaco.editor.IStandaloneCodeEditor | undefined {
  const a = useEditor.getState().active
  return a ? editorFor(a) : undefined
}

function editorAction(id: string): void {
  const ed = activeEditor()
  if (!ed) return
  ed.focus()
  void ed.getAction(id)?.run()
}

function editorCommand(cmd: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): void {
  const ed = activeEditor()
  if (ed && ed.hasTextFocus()) {
    if (cmd === 'undo' || cmd === 'redo') ed.trigger('menu', cmd, null)
    else if (cmd === 'selectAll') ed.setSelection(ed.getModel()!.getFullModelRange())
    else document.execCommand(cmd)
    return
  }
  document.execCommand(cmd === 'selectAll' ? 'selectAll' : cmd)
}

export const MENUS: MenuGroup[] = [
  {
    id: 'file',
    label: 'File',
    items: () => {
      const app = useApp.getState()
      const ed = useEditor.getState()
      const recent = (app.settings?.recentWorkspaces ?? []).filter((p) => p !== app.workspace).slice(0, 8)
      return [
        { id: 'file.new', label: 'New file…', hint: 'Ctrl+N', disabled: !app.workspace, run: () => useUi.getState().setModal('new-file') },
        { id: 'file.newWindow', label: 'New window', hint: 'Ctrl+Shift+N', run: () => void prism.win.open() },
        { id: 'file.open', label: 'Open folder…', hint: 'Ctrl+O', run: () => void app.openWorkspace() },
        { id: 'file.openRemote', label: 'Open a remote folder (WSL or SSH)…', run: () => useUi.getState().setModal('remote') },
        {
          id: 'file.recent',
          label: 'Open recent',
          disabled: recent.length === 0,
          submenu: recent.map((p) => ({ id: `file.recent.${p}`, label: `${basename(p)}${placeLabel(p) ? `  (${placeLabel(p)})` : ''}`, hint: p.length > 48 ? '…' + p.slice(-46) : p, run: () => void app.setWorkspace(p).catch(toastError) }))
        },
        { sep: true },
        { id: 'file.save', label: 'Save', hint: 'Ctrl+S', disabled: !ed.active, run: () => ed.active && void ed.save(ed.active) },
        { id: 'file.saveAll', label: 'Save all', hint: 'Ctrl+K S', run: () => void ed.saveAll() },
        { sep: true },
        { id: 'file.closeEditor', label: 'Close editor', hint: 'Ctrl+W', disabled: !ed.active, run: () => ed.active && useLayout.getState().closePanel(`editor:${ed.active}`) },
        { id: 'file.reveal', label: 'Reveal active file in file manager', disabled: !ed.active, run: () => ed.active && void prism.app.reveal(ed.active) },
        { sep: true },
        { id: 'file.quit', label: 'Quit Prism', hint: 'Alt+F4', run: () => prism.win.close() }
      ]
    }
  },
  {
    id: 'edit',
    label: 'Edit',
    items: () => [
      { id: 'edit.undo', label: 'Undo', hint: 'Ctrl+Z', run: () => editorCommand('undo') },
      { id: 'edit.redo', label: 'Redo', hint: 'Ctrl+Y', run: () => editorCommand('redo') },
      { sep: true },
      { id: 'edit.cut', label: 'Cut', hint: 'Ctrl+X', run: () => editorCommand('cut') },
      { id: 'edit.copy', label: 'Copy', hint: 'Ctrl+C', run: () => editorCommand('copy') },
      { id: 'edit.paste', label: 'Paste', hint: 'Ctrl+V', run: () => editorCommand('paste') },
      { id: 'edit.selectAll', label: 'Select all', hint: 'Ctrl+A', run: () => editorCommand('selectAll') },
      { sep: true },
      { id: 'edit.find', label: 'Find', hint: 'Ctrl+F', run: () => editorAction('actions.find') },
      { id: 'edit.replace', label: 'Replace', hint: 'Ctrl+H', run: () => editorAction('editor.action.startFindReplaceAction') },
      { id: 'edit.findInFiles', label: 'Find in files', hint: 'Ctrl+Shift+F', run: () => useUi.getState().setSide('search') },
      { sep: true },
      { id: 'edit.comment', label: 'Toggle line comment', hint: 'Ctrl+/', run: () => editorAction('editor.action.commentLine') },
      { id: 'edit.format', label: 'Format document', hint: 'Shift+Alt+F', run: () => editorAction('editor.action.formatDocument') },
      { id: 'edit.gotoLine', label: 'Go to line…', disabled: !useEditor.getState().active, run: () => useUi.getState().setPalette('line') },
      { id: 'edit.gotoSymbol', label: 'Go to symbol…', disabled: !useEditor.getState().active, run: () => useUi.getState().setPalette('symbols') },
      { sep: true },
      { id: 'edit.inlineEdit', label: 'Inline chat on the selection', hint: 'Ctrl+I', run: () => editorAction('prism.inlineEdit') },
      { id: 'edit.askPrism', label: 'Ask Prism about selection', run: () => editorAction('prism.askAgent') }
    ]
  },
  {
    id: 'view',
    label: 'View',
    items: () => {
      const ui = useUi.getState()
      const app = useApp.getState()
      const layout = useLayout.getState()
      const accent = app.settings?.appearance.accent
      return [
        { id: 'view.palette', label: 'Command palette…', hint: 'Ctrl+Shift+P', run: () => ui.setPalette('commands') },
        { id: 'view.quickOpen', label: 'Go to file…', hint: 'Ctrl+P', run: () => ui.setPalette('files') },
        { sep: true },
        { id: 'view.explorer', label: 'Explorer', hint: 'Ctrl+Shift+E', checked: ui.side === 'explorer', run: () => ui.setSide('explorer') },
        { id: 'view.search', label: 'Search', hint: 'Ctrl+Shift+F', checked: ui.side === 'search', run: () => ui.setSide('search') },
        { id: 'view.outline', label: 'Outline', checked: ui.side === 'outline', run: () => ui.setSide('outline') },
        { id: 'view.git', label: 'Source control', hint: 'Ctrl+Shift+G', checked: ui.side === 'git', run: () => ui.setSide('git') },
        { id: 'view.sessions', label: 'Sessions', hint: 'Ctrl+Shift+S', checked: ui.side === 'sessions', run: () => ui.setSide('sessions') },
        { id: 'view.gadgets', label: 'Gadgets', hint: 'Ctrl+Shift+D', checked: ui.side === 'gadgets', run: () => ui.setSide('gadgets') },
        { id: 'view.sidebar', label: 'Toggle sidebar', hint: 'Ctrl+B', run: () => ui.setSide(ui.side ? null : 'explorer') },
        { sep: true },
        { id: 'view.agent', label: 'Agent', hint: 'Ctrl+L', run: layout.openAgent },
        { id: 'view.terminal', label: 'Terminal', hint: 'Ctrl+`', run: layout.openTerminal },
        { id: 'view.dashboard', label: 'Project dashboard', run: layout.openDashboard },
        { id: 'view.browser', label: 'Browser (see your page)', run: () => layout.openBrowser() },
        { id: 'view.scratch', label: 'Scratchpad (try code)', run: layout.openScratch },
        { id: 'view.problems', label: 'Problems', run: layout.openProblems },
        { id: 'view.history', label: 'History (commit graph)', run: () => layout.openHistory() },
        { sep: true },
        { id: 'view.spec', label: 'Project spec (SPEC.md)', disabled: !app.workspace, run: () => layout.openSpec() },
        { id: 'view.tours', label: 'Tours (guided walks through the code)', disabled: !app.workspace, run: () => layout.openTours() },
        { id: 'view.catchup', label: 'While you were away (the last hour)', disabled: !app.workspace, run: () => void openCatchUp(Date.now() - 3_600_000) },
        { id: 'view.mission', label: 'Mission control (every session at a glance)', disabled: !app.workspace, run: () => layout.openMission() },
        { id: 'view.tasks', label: 'Task board (jobs it does by itself)', disabled: !app.workspace, run: () => layout.openTasks() },
        { sep: true },
        { id: 'view.welcome', label: 'Welcome', run: layout.openWelcome },
        { id: 'view.usage', label: 'Usage & cost', run: layout.openUsage },
        { id: 'view.settings', label: 'Settings', hint: 'Ctrl+,', run: () => layout.openSettings() },
        { sep: true },
        {
          id: 'view.appearance',
          label: 'Appearance',
          submenu: [
            { id: 'view.themes', label: 'Themes…', run: () => layout.openSettings('appearance') },
            { sep: true as const },
            { id: 'view.glow', label: 'Glow', checked: !!app.settings?.appearance.glow, run: () => void app.updateSettings({ appearance: { glow: !app.settings?.appearance.glow } }) },
            { id: 'view.motion', label: 'Motion', checked: !!app.settings?.appearance.motion, run: () => void app.updateSettings({ appearance: { motion: !app.settings?.appearance.motion } }) },
            {
              id: 'view.density',
              label: 'Compact density',
              checked: app.settings?.appearance.density === 'compact',
              run: () => void app.updateSettings({ appearance: { density: app.settings?.appearance.density === 'compact' ? 'comfortable' : 'compact' } })
            }
          ]
        },
        {
          id: 'view.conversation',
          label: 'Conversation',
          submenu: [
            ...LAYOUTS.map((l) => ({ id: `view.conversation.${l.id}`, label: l.label, checked: conv().layout === l.id, run: () => void app.updateSettings({ conversation: { layout: l.id } }) })),
            { sep: true as const },
            ...(['compact', 'comfortable', 'roomy'] as const).map((sp) => ({ id: `view.conversation.${sp}`, label: `${sp[0]!.toUpperCase()}${sp.slice(1)} spacing`, checked: conv().spacing === sp, run: () => void app.updateSettings({ conversation: { spacing: sp } }) })),
            { sep: true as const },
            { id: 'view.conversation.linked', label: 'Linked words', checked: conv().linkedWords, run: () => void app.updateSettings({ conversation: { linkedWords: !conv().linkedWords } }) },
            { id: 'view.conversation.needs', label: 'What needs you goes under the answer', checked: conv().needsUnder, run: () => void app.updateSettings({ conversation: { needsUnder: !conv().needsUnder } }) },
            { id: 'view.conversation.work', label: 'Work pane', run: () => layout.openWork() },
            { id: 'view.conversation.more', label: 'More conversation settings…', run: () => layout.openSettings('conversation') }
          ]
        },
        { id: 'view.zoomIn', label: 'Zoom in', hint: 'Ctrl+=', run: () => void prism.win.zoom(1) },
        { id: 'view.zoomOut', label: 'Zoom out', hint: 'Ctrl+-', run: () => void prism.win.zoom(-1) },
        { id: 'view.zoomReset', label: 'Reset zoom', hint: 'Ctrl+0', run: () => void prism.win.zoom(0) },
        { sep: true },
        { id: 'view.agentLines', label: 'Show which lines the agent wrote', checked: app.settings?.editor.agentLines !== false, run: () => void app.updateSettings({ editor: { agentLines: app.settings?.editor.agentLines === false } }) },
        { id: 'view.zen', label: 'Zen mode', checked: ui.zen, run: () => ui.setZen(!ui.zen) },
        { id: 'view.splitEditor', label: 'Split editor to the side', disabled: !useEditor.getState().active, run: () => { const a = useEditor.getState().active; if (a) layout.openEditorBeside(a) } },
        { id: 'view.resetLayout', label: 'Reset window layout', run: layout.resetLayout }
      ]
    }
  },
  {
    id: 'agent',
    label: 'Agent',
    items: () => {
      const s = useSessions.getState()
      const ui = useUi.getState()
      const live = s.active ? s.live[s.active] : undefined
      const session = s.sessions.find((x) => x.id === s.active)
      const lastUser = s.active ? [...(s.items[s.active] ?? [])].reverse().find((i) => i.kind === 'user') : undefined
      return [
        { id: 'agent.new', label: 'New session', hint: 'Ctrl+Shift+L', run: () => { useLayout.getState().openAgent(); void s.create() } },
        { id: 'agent.quickAsk', label: 'Quick question…', hint: 'Ctrl+Shift+A', disabled: !useApp.getState().workspace, run: () => void import('@/shell/QuickAsk').then((m) => m.useQuickAsk.getState().toggle(true)) },
        { id: 'agent.searchChats', label: 'Search conversations…', hint: 'Ctrl+Alt+F', disabled: !useApp.getState().workspace, run: () => useLayout.getState().openSearchChats() },
        { id: 'agent.side', label: 'Side chat (a passing question)…', hint: '/side', disabled: !s.active, run: () => { useLayout.getState().openAgent(); if (s.active) useSessions.getState().hand(s.active, '/side ', []) } },
        { id: 'agent.debug', label: 'Debug a problem…', hint: '/debug', disabled: !useApp.getState().workspace, run: () => { useLayout.getState().openAgent(); const id = useSessions.getState().active; if (id) useSessions.getState().hand(id, '/debug ', []); else void useSessions.getState().create().then((x) => x && useSessions.getState().hand(x.id, '/debug ', [])) } },
        { id: 'agent.voice', label: 'Speak instead of typing (start or stop)', hint: 'Ctrl+Alt+V', run: () => { useLayout.getState().openAgent(); setTimeout(() => (document.querySelector('.agent .mic-btn') as HTMLButtonElement | null)?.click(), 60) } },
        { id: 'agent.findInChat', label: 'Find in this conversation', hint: 'Ctrl+F in the agent panel', disabled: !s.active, run: () => { useLayout.getState().openAgent(); setTimeout(() => document.querySelector('.agent .transcript')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })), 50) } },
        { id: 'agent.multiverse', label: 'Tried several ways (results)', run: () => useLayout.getState().openMultiverse() },
        { id: 'agent.newCopy', label: 'New session in its own copy', run: () => { useLayout.getState().openAgent(); void s.createInCopy() } },
        { id: 'agent.sharePage', label: 'Share this conversation as a page anyone can read…', disabled: !s.active, run: () => void sharePage() },
        { id: 'agent.exportSession', label: 'Save this session as a file…', disabled: !s.active, run: () => void exportActive() },
        { id: 'agent.importSession', label: 'Open a session file…', disabled: !useApp.getState().workspace, run: () => void importSessionFile() },
        { id: 'agent.claudeImport', label: 'Carry on a Claude Code conversation…', disabled: !useApp.getState().workspace, run: () => useUi.getState().setModal('claude-import') },
        { id: 'agent.open', label: 'Agent panel', hint: 'Ctrl+L', run: useLayout.getState().openAgent },
        { id: 'agent.newGadget', label: 'New gadget…', run: () => ui.setModal('new-gadget') },
        { sep: true },
        { id: 'agent.switchSession', label: 'Switch session…', run: () => ui.setPalette('sessions') },
        { id: 'agent.switchModel', label: 'Switch model…', run: () => ui.setPalette('models') },
        { id: 'agent.switchMode', label: 'Switch permission mode…', run: () => ui.setPalette('modes') },
        { id: 'agent.pin', label: 'Open this session in its own panel', disabled: !session, run: () => session && useLayout.getState().openAgentSession(session.id, session.title) },
        { sep: true },
        { id: 'agent.stop', label: 'Stop', hint: 'Esc', disabled: !live?.running, run: () => void s.abort() },
        { id: 'agent.prs', label: 'Pull requests (review one, or this branch)…', disabled: !useApp.getState().workspace, run: () => useLayout.getState().openPrs() },
        { id: 'agent.review', label: "Review this turn's changes", disabled: !session, run: () => session && useLayout.getState().openReview(session.id) },
        { id: 'agent.timeline', label: 'Time machine (step through this session)', disabled: !session, run: () => session && useLayout.getState().openTimeline(session.id) },
        { id: 'agent.impact', label: 'What could break (the latest changes)', disabled: !session || live?.running, run: () => session && void import('@/panels/impact/ImpactPanel').then((m) => m.impactOfSession(session.id)) },
        { id: 'agent.automations', label: 'Automations…', run: () => useLayout.getState().openAutomations() },
        { id: 'agent.compare', label: 'Compare models…', run: () => useLayout.getState().openCompare() },
        { id: 'agent.context', label: 'What the model is holding…', run: () => useLayout.getState().openContext() },
        { id: 'agent.compact', label: 'Compact context', disabled: !session || live?.running, run: () => void s.compact() },
        { id: 'agent.rewind', label: 'Rewind last turn', disabled: !lastUser || live?.running, run: () => lastUser && window.confirm('Rewind to your last message?') && void s.rewind(lastUser.id) },
        { sep: true },
        {
          id: 'agent.mode',
          label: 'Permission mode',
          submenu: (['plan', 'ask', 'auto-edit', 'auto'] as const).map((m) => ({
            id: `agent.mode.${m}`,
            label: m === 'plan' ? 'Plan first' : m === 'ask' ? 'Ask first' : m === 'auto-edit' ? 'Edit freely' : 'Full auto',
            checked: session?.mode === m,
            run: () => void s.setMode(m)
          }))
        },
        { id: 'agent.follow', label: 'Follow the agent in the editor', checked: ui.follow, run: () => ui.setFollow(!ui.follow) },
        {
          id: 'agent.reasoning',
          label: 'Reasoning',
          checked: !!useApp.getState().settings?.agent.reasoning,
          run: () => void useApp.getState().updateSettings({ agent: { reasoning: !useApp.getState().settings?.agent.reasoning } })
        },
        { sep: true },
        { id: 'agent.export', label: 'Copy session as markdown', disabled: !session, run: () => exportSession() },
        { id: 'agent.sessions', label: 'All sessions', run: () => ui.setSide('sessions') }
      ]
    }
  },
  {
    id: 'terminal',
    label: 'Terminal',
    items: () => {
      const t = useTerminals.getState()
      const layout = useLayout.getState()
      return [
        { id: 'term.new', label: 'New terminal', hint: 'Ctrl+Shift+`', run: () => { layout.openTerminal(); void t.create() } },
        { id: 'term.show', label: 'Terminal panel', hint: 'Ctrl+`', run: layout.openTerminal },
        { id: 'term.agent', label: 'Agent console', run: () => { layout.openTerminal(); t.setActive('__agent__') } },
        { sep: true },
        { id: 'term.clear', label: 'Clear active terminal', disabled: !t.active || t.active === '__agent__', run: () => t.active && prism.terminals.write(t.active, prism.platform === 'win32' ? 'clear\r' : 'clear\n') },
        { id: 'term.kill', label: 'Kill active terminal', disabled: !t.active || t.active === '__agent__', danger: true, run: () => t.active && void t.kill(t.active) }
      ]
    }
  },
  {
    id: 'help',
    label: 'Help',
    items: () => [
      { id: 'help.shortcuts', label: 'Keyboard shortcuts', run: () => useUi.getState().setModal('shortcuts') },
      { id: 'help.editShortcuts', label: 'Change keyboard shortcuts…', run: () => useLayout.getState().openSettings('keyboard') },
      { id: 'help.welcome', label: 'Welcome', run: useLayout.getState().openWelcome },
      { id: 'help.lessons', label: 'Lessons…', run: () => void import('@/demo/recorder').then((m) => m.useRecorder.setState({ listOpen: true })) },
      { id: 'help.recordLesson', label: 'Record a lesson', run: () => void import('@/demo/recorder').then((m) => m.startRecording()) },
      { id: 'help.docs', label: 'Using Prism (guide)', run: () => openLink('https://github.com/valware/prism/blob/main/docs/human/using-prism.md') },
      { sep: true },
      { id: 'help.about', label: 'About Prism', run: () => useUi.getState().setModal('about') }
    ]
  }
]

export function exportSession(): void {
  const st = useSessions.getState()
  const items = st.active ? (st.items[st.active] ?? []) : []
  const title = st.sessions.find((x) => x.id === st.active)?.title ?? 'Session'
  const md = [`# ${title}`, '']
  for (const it of items) {
    if (it.kind === 'user') md.push(`## You`, '', it.text, '')
    else if (it.kind === 'assistant' && it.text.trim()) md.push(`## Prism`, '', it.text, '')
    else if (it.kind === 'tool') md.push(`> ${it.name}${it.isError ? ' (error)' : ''}: ${JSON.stringify(it.args).slice(0, 200)}`, '')
    else if (it.kind === 'system' && it.subkind === 'compaction') md.push(`## Summary of earlier conversation`, '', it.text, '')
  }
  void copyText(md.join('\n')).then((ok) => ok && useUi.getState().toast('success', 'Copied the session as markdown'))
}

/** Flattened list for the command palette: every leaf item with its menu path. */
async function exportActive(): Promise<void> {
  const id = useSessions.getState().active
  if (!id) return
  try {
    if (await prism.portable.export(id)) useUi.getState().toast('success', 'Session saved', 'Open it in Prism on any computer with Agent, Open a session file.')
  } catch (e) {
    toastError(e, 'Could not save the session')
  }
}

/** A page to send someone: it opens in any browser, and in Prism it carries on the conversation. */
export async function sharePage(): Promise<void> {
  const id = useSessions.getState().active
  if (!id) return
  try {
    const tools = window.confirm('Include the steps (commands, files read, tool results) under each answer?\n\nThe page holds the whole conversation, including anything pasted into it, so look before you send it.')
    const path = await prism.portable.sharePage(id, tools)
    if (path) useUi.getState().toast('success', 'Conversation saved as a page', `${path.split(/[\\/]/).pop()}: it opens in any browser, and in Prism with Open a session file.`)
  } catch (e) {
    toastError(e, 'Could not save the page')
  }
}

async function importSessionFile(): Promise<void> {
  try {
    const r = await prism.portable.import()
    if (!r) return
    await useSessions.getState().refresh()
    useLayout.getState().openAgent()
    await useSessions.getState().select(r.sessionId)
    if (r.plan) useRefactor.getState().show(r.plan)
    useUi.getState().toast('success', 'Session brought in', r.plan ? 'Its file changes are in a change set: apply what you want.' : 'Carry on where it left off.')
  } catch (e) {
    toastError(e, 'Could not open that session')
  }
}

export function allCommands(includeDisabled = false): Array<{ id: string; label: string; hint?: string; run: () => void }> {
  const out: Array<{ id: string; label: string; hint?: string; run: () => void }> = []
  const walk = (prefix: string, items: MenuItem[]): void => {
    for (const it of items) {
      if (it.sep) continue
      if (it.submenu) walk(`${prefix}${it.label} › `, it.submenu)
      else if (it.run && (includeDisabled || !it.disabled)) out.push({ id: it.id, label: `${prefix}${it.label}`, hint: it.hint, run: it.run })
    }
  }
  for (const g of MENUS) walk(`${g.label}: `, g.items())
  return out
}

/** The "While you were away" summary from `since`, opened as a panel. */
async function openCatchUp(since: number): Promise<void> {
  const [{ useCatchUp }, report] = await Promise.all([import('@/panels/catchup/CatchUp'), prism.catchup.since(since)])
  useCatchUp.setState({ report, offered: false })
  useLayout.getState().openCatchUp()
}
