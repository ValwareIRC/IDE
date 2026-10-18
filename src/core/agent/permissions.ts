import type { PermissionMode, PermissionRule, RiskLevel } from '@shared/types'

/** Simple glob: `*` matches anything, `?` one char. Case-insensitive. Anchored. */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((seg) => seg.split('?').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.'))
        .join('.*') +
      '$',
    'is'
  )
  return re.test(value)
}

export function ruleMatches(rule: PermissionRule, tool: string, primary: string | null): boolean {
  if (!globMatch(rule.tool, tool)) return false
  if (!rule.pattern) return true
  if (primary === null) return false
  return globMatch(rule.pattern, primary.trim())
}

export type Decision = 'allow' | 'deny' | 'ask'

export interface PermissionInput {
  mode: PermissionMode
  allow: PermissionRule[]
  deny: PermissionRule[]
  /** Rules the user accepted with "always" during this session. */
  sessionAllow: PermissionRule[]
}

const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'move_path', 'create_dir', 'remember', 'rename_symbol'])

/** Whether a mode lets a tool through without asking (ignoring rules). */
export function modeAllows(mode: PermissionMode, tool: string): boolean {
  return mode === 'auto' || (mode === 'auto-edit' && EDIT_TOOLS.has(tool))
}

export function decide(p: PermissionInput, tool: string, primary: string | null, risk: RiskLevel | null): Decision {
  if (risk === null) return 'allow'
  for (const r of p.deny) if (ruleMatches(r, tool, primary)) return 'deny'
  for (const r of [...p.allow, ...p.sessionAllow]) if (ruleMatches(r, tool, primary)) return 'allow'
  return modeAllows(p.mode, tool) ? 'allow' : 'ask'
}

/** Suggest the rule "always allow" should add for this call. */
export function suggestRule(tool: string, primary: string | null): PermissionRule {
  if (tool === 'shell' && primary) {
    const first = primary.trim().split(/\s+/)[0] ?? ''
    const second = primary.trim().split(/\s+/)[1] ?? ''
    if (/^(git|npm|pnpm|yarn|bun|cargo|dotnet|python|pip|uv|go|make|docker|node)$/i.test(first) && second && !second.startsWith('-')) {
      return { tool, pattern: `${first} ${second}*` }
    }
    return { tool, pattern: `${first}*` }
  }
  if (tool.startsWith('mcp__')) return { tool: tool.split('__').slice(0, 2).join('__') + '__*' }
  return { tool }
}

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\brm\s+-r\b/i,
  /\b(rmdir|rd)\b.*\/s/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\bdel\b.*\/[sq]/i,
  /\bformat\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bgit\s+(push\s+.*--force|push\s+-f|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|checkout\s+--\s+\.)/i,
  /\bgit\s+push\b/i,
  /\b(shutdown|reboot|taskkill|Stop-Process|kill\s+-9)\b/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bcurl\b.*\|\s*(sh|bash)\b/i,
  /\biex\b|Invoke-Expression/i,
  /\bnpm\s+publish\b|\bcargo\s+publish\b|\bpnpm\s+publish\b/i
]

export function shellRisk(command: string): RiskLevel {
  for (const re of DESTRUCTIVE) if (re.test(command)) return 'high'
  if (/\b(sudo|runas)\b/i.test(command)) return 'high'
  return 'medium'
}
