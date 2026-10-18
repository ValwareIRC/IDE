// The user's rules: things the agent must never do, kept in the project's
// .prism/rules.json (or the app's rules.json for every project). A rule is
// checked before every tool call in both engines, so "never touch the
// migrations" is a wall, not a hope. Rules are written as a sentence; a model
// turns the sentence into what to match (paths, commands), which the user sees
// before it is saved.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { ToolCall, UserRule } from '@shared/types'
import type { Workspace } from '../fs/workspace'
import { globMatch } from '../agent/permissions'
import { ask, firstJson } from '../agent/ask'
import type { ResolvedModel } from '../agent/engine'

export const PROJECT_RULES = '.prism/rules.json'

/** Tools that change files, with where their paths are. */
const WRITERS: Record<string, (a: Record<string, unknown>) => string[]> = {
  write_file: (a) => [String(a['path'] ?? '')],
  edit_file: (a) => [String(a['path'] ?? '')],
  delete_path: (a) => [String(a['path'] ?? '')],
  move_path: (a) => [String(a['from'] ?? ''), String(a['to'] ?? '')],
  propose_changes: (a) => (Array.isArray(a['files']) ? (a['files'] as Array<{ path?: unknown }>).map((f) => String(f.path ?? '')) : []),
  rename_symbol: (a) => [String(a['path'] ?? '')]
}

const norm = (p: string): string => p.split('\\').join('/').replace(/^\.\//, '')

function matchesPath(rule: UserRule, path: string): boolean {
  const p = norm(path)
  return rule.paths.some((g) => globMatch(g, p) || (!g.includes('/') && globMatch(g, p.split('/').pop() ?? p)) || p.startsWith(norm(g).replace(/\/?\*\*?$/, '/')))
}

/** Of these changed paths, the ones a file rule protects, with the first rule that does. */
export function protectedAmong(rules: UserRule[], paths: string[]): { rule: UserRule; paths: string[] } | null {
  for (const r of rules) {
    if (!r.enabled || r.block === 'commands' || !r.paths.length) continue
    const hit = paths.filter((p) => matchesPath(r, p))
    if (hit.length) return { rule: r, paths: hit }
  }
  return null
}

/** The rule this call breaks, if any. */
export function breaks(rules: UserRule[], call: ToolCall): UserRule | null {
  for (const r of rules) {
    if (!r.enabled) continue
    if (r.block !== 'commands' && r.paths.length) {
      const paths = WRITERS[call.name]?.(call.args) ?? (call.name.startsWith('gadget') || call.name.startsWith('mcp__') ? [] : [])
      if (paths.some((p) => p && matchesPath(r, p))) return r
    }
    if (call.name === 'shell' && r.block !== 'files') {
      const cmd = String(call.args['command'] ?? '')
      if (r.command) {
        try {
          if (new RegExp(r.command, 'i').test(cmd)) return r
        } catch {
          /* a bad pattern matches nothing */
        }
      }
    }
  }
  return null
}

export class RuleBook {
  constructor(private personalFile: string) {}

  private readPersonal(): UserRule[] {
    try {
      return existsSync(this.personalFile) ? ((JSON.parse(readFileSync(this.personalFile, 'utf8')) as { rules?: UserRule[] }).rules ?? []) : []
    } catch {
      return []
    }
  }

  async list(ws: Workspace | null): Promise<UserRule[]> {
    const own = this.readPersonal().map((r) => ({ ...r, scope: 'personal' as const }))
    if (!ws) return own
    try {
      const v = JSON.parse((await ws.read(PROJECT_RULES)).content) as { rules?: UserRule[] }
      return [...(v.rules ?? []).map((r) => ({ ...r, scope: 'project' as const })), ...own]
    } catch {
      return own
    }
  }

  async save(ws: Workspace | null, rule: UserRule): Promise<void> {
    if (rule.scope === 'personal' || !ws) {
      const list = this.readPersonal().filter((r) => r.id !== rule.id)
      writeFileSync(this.personalFile, JSON.stringify({ rules: [...list, { ...rule, scope: 'personal' }] }, null, 2), 'utf8')
      return
    }
    const cur = (await this.list(ws)).filter((r) => r.scope === 'project' && r.id !== rule.id)
    await ws.write(PROJECT_RULES, JSON.stringify({ rules: [...cur, rule].map(({ scope: _s, ...r }) => r) }, null, 2))
  }

  async remove(ws: Workspace | null, id: string): Promise<void> {
    const all = await this.list(ws)
    const hit = all.find((r) => r.id === id)
    if (!hit) return
    if (hit.scope === 'personal' || !ws) {
      writeFileSync(this.personalFile, JSON.stringify({ rules: this.readPersonal().filter((r) => r.id !== id) }, null, 2), 'utf8')
      return
    }
    await ws.write(PROJECT_RULES, JSON.stringify({ rules: all.filter((r) => r.scope === 'project' && r.id !== id).map(({ scope: _s, ...r }) => r) }, null, 2))
  }
}

/** Turn a sentence ("never touch the migrations") into what to match. */
export async function ruleFromSentence(model: ResolvedModel, sentence: string, files: string[]): Promise<Omit<UserRule, 'id' | 'enabled' | 'scope'>> {
  const { text } = await ask(
    model,
    'You turn a rule a user wrote for their coding agent into something a program can check before each action. Paths are globs relative to the project folder (folder/** for a whole folder). command is a JavaScript regular expression matched against shell commands, or null. block says what the rule stops: "files" (writing, editing, deleting or moving those paths), "commands" (shell commands), or "both". Reply with JSON only: {"text":"<the rule as one short sentence, starting with Never or Do not>","block":"files"|"commands"|"both","paths":["..."],"command":"..."|null}',
    `Rule: ${sentence}\n\nSome of the project's files, to get the paths right:\n${files.slice(0, 300).join('\n')}`,
    400
  )
  const r = firstJson<{ text?: string; block?: string; paths?: unknown; command?: unknown }>(text)
  if (!r) throw new Error('The rule could not be worked out. Try saying it more plainly.')
  const block = r.block === 'commands' || r.block === 'both' ? r.block : 'files'
  const paths = Array.isArray(r.paths) ? r.paths.map(String).filter(Boolean).slice(0, 20) : []
  const command = typeof r.command === 'string' && r.command.trim() ? r.command.trim() : null
  if (command) new RegExp(command)
  if (!paths.length && !command) throw new Error('The rule did not name any files or commands to stop.')
  return { text: String(r.text ?? sentence).slice(0, 200), block, paths, command }
}
