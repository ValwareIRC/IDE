// The agent working on Prism itself: reading and changing the user's settings, and opening panels.
// Permissions, providers, keys, model roles, MCP servers and the user's own themes are off limits: an
// agent must never widen its own permissions or reroute where its requests go.
import type { Settings, SettingsPatch } from '@shared/types'
import { err, str, type AgentTool } from './types'

export interface PrismHost {
  settings(): Settings
  defaults(): Settings
  update(patch: SettingsPatch): void
  /** Open a panel in the window (settings take an optional section). */
  open(panel: string, section?: string): void
  /** The window's tab groups and their tabs, for tabs_look; null when no window shows the project. */
  tabs?(): Promise<TabsLayout | null>
}
import type { TabsLayout } from './window'

const OFF_LIMITS = ['permissions', 'roles', 'claude', 'mcp', 'routing', 'keybindings', 'recentWorkspaces', 'onboarded', 'appearance.themes', 'appearance.accent', 'appearance.bg']

export const PANELS: Record<string, string> = {
  settings: 'Settings (section: models, claude, roles, agent, conversation, assist, permissions, editor, files, appearance, keyboard, extend, mcp)',
  terminal: 'the terminal',
  dashboard: 'the project dashboard',
  browser: 'the in-app browser',
  scratch: 'the scratchpad',
  problems: 'the Problems list',
  history: 'the commit graph',
  usage: 'usage and cost',
  spec: 'the project spec',
  tours: 'guided tours',
  catchup: 'while you were away',
  automations: 'automations',
  context: 'what the model is holding',
  mission: 'mission control (every session at a glance)',
  work: 'the work pane (every step of one request, opened)',
  searchChats: 'search every conversation in the project',
  prs: 'pull requests: review one, or the current branch before pushing',
  tasks: 'the task board',
  welcome: 'the welcome page'
}

function at(obj: unknown, path: string[]): unknown {
  let cur = obj
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

/** The value converted to the type the setting already has, or an error. */
function coerce(value: unknown, like: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof like === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value }
    if (value === 'true' || value === 'on') return { ok: true, value: true }
    if (value === 'false' || value === 'off') return { ok: true, value: false }
    return { ok: false, error: 'it is on or off (true or false)' }
  }
  if (typeof like === 'number') {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: 'it is a number' }
  }
  if (typeof like === 'string' || like === null) return value === null || typeof value === 'string' ? { ok: true, value } : { ok: false, error: 'it is text' }
  if (Array.isArray(like)) return Array.isArray(value) ? { ok: true, value } : { ok: false, error: 'it is a list' }
  return { ok: false, error: 'set one of its parts instead (e.g. editor.fontSize)' }
}

export function createPrismTools(host: PrismHost): AgentTool[] {
  const settingsTool: AgentTool = {
    spec: {
      name: 'prism_settings',
      description:
        "Read or change Prism's own settings for the user (\"turn off the minimap\", \"make the terminal font bigger\", \"save files by themselves\"). " +
        'action "get" with a key (like "editor" or "editor.fontSize", or "" for the list of sections) shows current values; action "set" with key and value changes one. ' +
        "Permissions, providers, model roles, MCP servers and keyboard shortcuts cannot be changed this way: tell the user where to change them. For themes use set_theme.",
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'] },
          key: { type: 'string', description: 'Dotted path, e.g. "terminal.fontFamily"' },
          value: { description: 'The new value (set only)' }
        },
        required: ['action']
      }
    },
    primaryArg: 'key',
    readOnly: false,
    risk: (a) => (str(a, 'action') === 'set' ? 'low' : null),
    summary: (a) => (str(a, 'action') === 'set' ? `set ${str(a, 'key')} = ${JSON.stringify(a['value'])}` : `read setting ${str(a, 'key') || 'sections'}`),
    async execute(args) {
      const key = str(args, 'key').trim()
      const path = key ? key.split('.') : []
      const s = host.settings()
      if (str(args, 'action') !== 'set') {
        if (!path.length) return { content: `Sections: ${Object.keys(s).filter((k) => !OFF_LIMITS.includes(k)).join(', ')}`, isError: false }
        if (OFF_LIMITS.some((o) => key === o || key.startsWith(`${o}.`))) return err(`${key} is not open to the agent.`)
        const v = at(s, path)
        if (v === undefined) return err(`There is no setting ${key}.`)
        return { content: `${key} = ${JSON.stringify(v, (k, x) => (k === 'themes' ? undefined : x), 2).slice(0, 6000)}`, isError: false }
      }
      if (path.length < 2) return err('Give the full key, like "editor.fontSize".')
      if (OFF_LIMITS.some((o) => key === o || key.startsWith(`${o}.`))) return err(`${key} can only be changed by the user, in Settings.`)
      const known = at(host.defaults(), path)
      const current = at(s, path)
      if (known === undefined && current === undefined) return err(`There is no setting ${key}. Use action "get" on its section to see the names.`)
      const c = coerce(args['value'], known ?? current)
      if (!c.ok) return err(`${key} was not changed: ${c.error}.`)
      // build { section: { …: value } } for the store, which merges it
      const patch: Record<string, unknown> = {}
      let cur = patch
      for (const [i, k] of path.entries()) {
        if (i === path.length - 1) cur[k] = c.value
        else cur = cur[k] = {} as Record<string, unknown>
      }
      host.update(patch as SettingsPatch)
      return { content: `${key} is now ${JSON.stringify(c.value)} (it was ${JSON.stringify(current)}).`, isError: false, meta: { setting: key } }
    }
  }

  const openTool: AgentTool = {
    spec: {
      name: 'prism_open',
      description: `Open a panel of Prism for the user. Panels: ${Object.entries(PANELS).map(([k, v]) => `${k} (${v})`).join('; ')}.`,
      parameters: { type: 'object', properties: { panel: { type: 'string', enum: Object.keys(PANELS) }, section: { type: 'string', description: 'For settings: which section' } }, required: ['panel'] }
    },
    primaryArg: 'panel',
    readOnly: true,
    risk: () => null,
    summary: (a) => `open ${str(a, 'panel')}${str(a, 'section') ? ` (${str(a, 'section')})` : ''}`,
    async execute(args) {
      const panel = str(args, 'panel')
      if (!PANELS[panel]) return err(`No panel "${panel}". Panels: ${Object.keys(PANELS).join(', ')}.`)
      host.open(panel, str(args, 'section') || undefined)
      return { content: `Opened ${PANELS[panel]!.split(' (')[0]}.`, isError: false }
    }
  }
  return [settingsTool, openTool]
}
