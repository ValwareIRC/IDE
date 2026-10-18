import { useApp } from '@/state/app'

/**
 * Shortcuts Prism handles itself, by command id. The user's changes
 * (settings.keybindings) lie on top. Editor built-ins such as find or
 * multi-cursor stay with the editor and are listed in EDITOR_KEYS.
 */
export const DEFAULT_KEYS: Record<string, string> = {
  'view.palette': 'Ctrl+Shift+P',
  'view.quickOpen': 'Ctrl+P',
  'edit.gotoSymbol': 'Ctrl+Shift+O',
  'edit.gotoLine': 'Ctrl+G',
  'file.new': 'Ctrl+N',
  'file.open': 'Ctrl+O',
  'file.save': 'Ctrl+S',
  'file.closeEditor': 'Ctrl+W',
  'view.explorer': 'Ctrl+Shift+E',
  'view.search': 'Ctrl+Shift+F',
  'view.outline': 'Ctrl+Shift+U',
  'view.git': 'Ctrl+Shift+G',
  'view.sessions': 'Ctrl+Shift+S',
  'view.gadgets': 'Ctrl+Shift+D',
  'view.sidebar': 'Ctrl+B',
  'agent.open': 'Ctrl+L',
  'agent.new': 'Ctrl+Shift+L',
  'agent.quickAsk': 'Ctrl+Shift+A',
  'agent.searchChats': 'Ctrl+Alt+F',
  'file.newWindow': 'Ctrl+Shift+N',
  'agent.voice': 'Ctrl+Alt+V',
  'agent.switchSession': 'Ctrl+Shift+J',
  'agent.switchModel': 'Ctrl+Alt+M',
  'view.problems': 'Ctrl+Shift+M',
  'term.show': 'Ctrl+`',
  'term.new': 'Ctrl+Shift+`',
  'view.settings': 'Ctrl+,',
  'view.zoomIn': 'Ctrl+=',
  'view.zoomOut': 'Ctrl+-',
  'view.zoomReset': 'Ctrl+0',
  'view.zen': 'Ctrl+Alt+Z',
  'view.splitEditor': 'Ctrl+\\',
  'help.shortcuts': 'F1'
}

/** Menu entries that are the same command under another menu. */
const ALIAS: Record<string, string> = {
  'view.agent': 'agent.open',
  'view.terminal': 'term.show',
  'edit.findInFiles': 'view.search'
}

/** Built into the editor; shown for reference, not changeable here. */
export const EDITOR_KEYS: Array<[string, string]> = [
  ['Ctrl+F', 'Find in file'],
  ['Ctrl+H', 'Replace in file'],
  ['Ctrl+I or Ctrl+K', 'Inline chat: change the selection, preview it, refine, accept'],
  ['Ctrl+/', 'Toggle comment'],
  ['Shift+Alt+F', 'Format document'],
  ['Ctrl+D', 'Select next match'],
  ['Alt+Click', 'Add a cursor'],
  ['Alt+↑ / Alt+↓', 'Move line'],
  ['Shift+Alt+↑ / ↓', 'Copy line'],
  ['Ctrl+Space', 'Suggest'],
  ['F2', 'Rename: a name everywhere it is used (in the editor), or a file (in the explorer)'],
  ['Shift+F12', 'Find everywhere a name is used'],
  ['F12', 'Go to definition'],
  ['Tab', 'Accept the grey suggestion'],
  ['Enter', 'Send to the agent (Shift+Enter for a new line)'],
  ['Esc', 'Stop the agent']
]

const CODE_KEYS: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  NumpadAdd: '=',
  NumpadSubtract: '-'
}

/**
 * The shortcut a key event stands for, e.g. "Ctrl+Shift+P", or null for plain
 * typing. Uses the physical key so Shift+` is still "`" on every layout.
 */
export function chordOf(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return null
  let key: string | undefined
  if (/^Key[A-Z]$/.test(e.code)) key = e.key.length === 1 && /[a-z]/i.test(e.key) ? e.key.toUpperCase() : e.code.slice(3)
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6)
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code
  else key = CODE_KEYS[e.code]
  if (!key) return null
  const mod = e.ctrlKey || e.metaKey
  const isFn = /^F\d{1,2}$/.test(key)
  if (!mod && !e.altKey && !isFn) return null
  const parts: string[] = []
  if (mod) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  parts.push(key)
  return parts.join('+')
}

function overrides(): Map<string, string> {
  const m = new Map<string, string>()
  for (const b of useApp.getState().settings?.keybindings ?? []) m.set(b.command, b.key)
  return m
}

/** Every command that has a shortcut right now. */
export function effectiveKeys(): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_KEYS }
  for (const [cmd, key] of overrides()) {
    if (key) out[cmd] = key
    else delete out[cmd]
  }
  return out
}

/** The shortcut to show next to a command, if it has one. */
export function keyFor(id: string): string | undefined {
  return effectiveKeys()[ALIAS[id] ?? id]
}

/** True when the shortcut for this command is managed here (so a menu's own hint must not be shown instead). */
export function isRebindable(id: string): boolean {
  const real = ALIAS[id] ?? id
  return real in DEFAULT_KEYS || overrides().has(real)
}

export function commandForChord(chord: string): string | undefined {
  const keys = effectiveKeys()
  // the user's own choices win when two commands share a shortcut
  for (const [cmd, key] of overrides()) if (key === chord) return cmd
  for (const [cmd, key] of Object.entries(keys)) if (key === chord) return cmd
  return undefined
}

export function isCustom(id: string): boolean {
  return overrides().has(id)
}

/** Set, clear ('') or reset (null) one command's shortcut. Returns the command that lost the shortcut, if any. */
export async function setKey(id: string, key: string | null): Promise<string | undefined> {
  const app = useApp.getState()
  let list = (app.settings?.keybindings ?? []).filter((b) => b.command !== id)
  let displaced: string | undefined
  if (key !== null) {
    if (key) {
      const cur = effectiveKeys()
      displaced = Object.keys(cur).find((cmd) => cmd !== id && cur[cmd] === key)
      if (displaced) list = [...list.filter((b) => b.command !== displaced), { command: displaced, key: '' }]
    }
    if (key !== (DEFAULT_KEYS[id] ?? '')) list = [...list, { command: id, key }]
  }
  await app.updateSettings({ keybindings: list })
  return displaced
}

export async function resetAllKeys(): Promise<void> {
  await useApp.getState().updateSettings({ keybindings: [] })
}

// while the settings page is listening for a new shortcut, nothing else may react
let recording = false
export function setRecording(on: boolean): void {
  recording = on
}
export function isRecording(): boolean {
  return recording
}
