import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Settings, SettingsPatch } from '@shared/types'
import { IGNORED_DIRS } from '../fs/paths'

export const DEFAULT_SETTINGS: Settings = {
  roles: { lead: null, fast: null, completion: null, vision: null, fallback: null },
  permissions: {
    mode: 'ask',
    allow: [
      { tool: 'shell', pattern: 'git status*' },
      { tool: 'shell', pattern: 'git diff*' },
      { tool: 'shell', pattern: 'git log*' }
    ],
    deny: [],
    checker: false
  },
  agent: {
    maxSteps: 200,
    compactAt: 0.8,
    reasoning: true,
    temperature: null,
    parallelTools: true,
    selfRepair: true,
    wakeLimit: 10,
    shellTimeoutSec: 120,
    retries: 3,
    hookFixes: 2,
    maxTeam: 12,
    autoTitle: true,
    sendKey: 'enter',
    editorContext: 'selection-and-file',
    sizeWarnK: 200
  },
  editor: {
    fontSize: 13,
    tabSize: 2,
    wordWrap: false,
    minimap: false,
    ghostText: true,
    ghostTextDelayMs: 350,
    formatOnSave: false,
    insertSpaces: true,
    autoSave: 'off',
    autoSaveDelayMs: 1000,
    fontLigatures: true,
    lineHeight: 20,
    lineNumbers: 'on',
    stickyScroll: true,
    bracketColours: true,
    renderWhitespace: 'selection',
    cursorBlinking: 'smooth',
    smoothScrolling: true,
    nextEdit: true,
    agentLines: true
  },
  terminal: {
    shell: null,
    fontSize: 13,
    fontFamily: '',
    lineHeight: 1,
    scrollback: 8000,
    cursorStyle: 'bar',
    cursorBlink: true,
    copyOnSelect: false,
    followProject: true
  },
  assist: {
    learn: true,
    specChecks: true,
    pagePictures: true,
    catchUpAfterMin: 10,
    agentMap: true,
    notifications: true,
    autoReview: false,
    gadgetIdeas: true,
    pair: false
  },
  files: {
    hidden: [...IGNORED_DIRS]
  },
  recipes: [],
  appearance: {
    theme: '',
    themes: [],
    bg: '#07080c',
    accent: 'aurora',
    motion: true,
    density: 'comfortable',
    glow: true
  },
  conversation: {
    layout: 'rail',
    spacing: 'compact',
    linkedWords: true,
    needsUnder: true,
    noRepeat: true,
    thinking: 'opened',
    times: true,
    drawn: 40
  },
  remote: { enabled: false, port: 8793, relay: '', upnp: false },
  phone: { enabled: false, port: 8791 },
  voice: { engine: 'local', localModel: 'base', endpointId: '', model: 'whisper-1', language: '' },
  speech: { engine: 'kokoro', windowsVoice: '', kokoroPath: '', kokoroVoice: 'bf_emma' },
  face: { enabled: true, path: '' },
  claude: { enabled: true, path: null },
  routing: { enabled: false, rules: [] },
  mcp: [],
  keybindings: [],
  recentWorkspaces: [],
  onboarded: false
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep-merge a partial over defaults; arrays replace, objects merge. */
function merge<T>(base: T, patch: unknown): T {
  if (!isObject(patch) || !isObject(base)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k]
    out[k] = isObject(cur) && isObject(v) ? merge(cur, v) : v
  }
  return out as T
}

export class SettingsStore {
  private file: string
  private value: Settings
  private listeners = new Set<(s: Settings) => void>()

  constructor(file: string) {
    this.file = file
    this.value = DEFAULT_SETTINGS
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
        this.value = merge(DEFAULT_SETTINGS, raw)
      }
    } catch {
      this.value = DEFAULT_SETTINGS
    }
  }

  get(): Settings {
    return this.value
  }

  update(patch: SettingsPatch): Settings {
    this.value = merge(this.value, patch)
    this.flush()
    for (const l of this.listeners) l(this.value)
    return this.value
  }

  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.value, null, 2), 'utf8')
  }
}
