// Finds the Claude Code program already installed on this computer. Prism does
// not ship its own copy: it drives the one the user installed and signed in to.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const WIN = process.platform === 'win32'
const NAMES = WIN ? ['claude.exe'] : ['claude']

function fromVsCode(): string[] {
  // editors' extensions each carry their own copy
  const out: string[] = []
  for (const dir of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const base = join(homedir(), dir, 'extensions')
    try {
      for (const h of readdirSync(base)) {
        if (!h.startsWith('anthropic.claude-code-')) continue
        const p = join(base, h, 'resources', 'native-binary', NAMES[0]!)
        if (existsSync(p)) out.push(p)
      }
    } catch {
      /* that editor is not installed */
    }
  }
  return out
}

/** Every Claude Code on this computer, wherever it was put. */
function candidates(): string[] {
  const found = new Set<string>()
  const dirs = [join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local'), ...(process.env['PATH'] ?? '').split(delimiter)]
  for (const d of dirs) {
    if (!d) continue
    for (const n of NAMES) {
      const p = join(d, n)
      if (existsSync(p)) found.add(p)
    }
  }
  for (const p of fromVsCode()) found.add(p)
  return [...found]
}

/**
 * The version a copy reports, asked once and remembered against the file's date, so
 * the question costs one process per copy rather than one per look.
 */
const versions = new Map<string, { mtime: number; version: number[] }>()
function versionOf(exe: string): number[] {
  let mtime = 0
  try {
    mtime = statSync(exe).mtimeMs
  } catch {
    return []
  }
  const known = versions.get(exe)
  if (known && known.mtime === mtime) return known.version
  let version: number[] = []
  try {
    const out = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 8000, env: claudeEnv() as NodeJS.ProcessEnv, windowsHide: true })
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out)
    if (m) version = [Number(m[1]), Number(m[2]), Number(m[3])]
  } catch {
    /* a copy that will not say is ranked below every one that does */
  }
  versions.set(exe, { mtime, version })
  return version
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] ?? -1
    const y = b[i] ?? -1
    if (x !== y) return x > y
  }
  return false
}

/**
 * `preferred` is the path from Settings; an empty one means "find it". Finding it means the
 * newest copy on the computer, not the first one met: the one on PATH is the one updated
 * least often, and Prism was driving a month-old Claude Code while a current one sat unused
 * inside an editor's extension folder.
 */
export function locateClaude(preferred?: string | null): string | null {
  if (preferred?.trim()) return existsSync(preferred.trim()) ? preferred.trim() : null
  let best: string | null = null
  let bestVersion: number[] = []
  for (const p of candidates()) {
    const v = versionOf(p)
    if (!best || newer(v, bestVersion)) {
      best = p
      bestVersion = v
    }
  }
  return best
}

/**
 * The environment Claude Code is started with. When Prism itself was started
 * from inside a Claude Code session, that session's markers must not leak in.
 */
export function claudeEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|ELECTRON_RUN_AS_NODE$)/.test(k)) continue
    out[k] = v
  }
  return out
}

/** Servers Claude Code already knows about from its own config, by the name it would give their tools. */
export function claudeOwnServers(): Set<string> {
  const file = join(process.env['CLAUDE_CONFIG_DIR'] || homedir(), '.claude.json')
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> }
    return new Set(Object.keys(raw.mcpServers ?? {}).map((n) => n.toLowerCase()))
  } catch {
    return new Set()
  }
}
