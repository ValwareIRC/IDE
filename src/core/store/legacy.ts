import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AdapterId, AuthConfig, McpServerConfig } from '@shared/types'
import type { Repo } from './repo'

/**
 * One-time import from the previous Prism (GLM-era) data files that share the
 * same userData folder: endpoints from prism.db and keys from secrets.json.
 * Nothing is modified or deleted; the old app keeps working.
 */
export function importLegacy(userData: string, repo: Repo, setKey: (id: string, key: string) => void, hasKey: (id: string) => boolean): number {
  const dbFile = join(userData, 'prism.db')
  if (!existsSync(dbFile)) return 0
  let imported = 0
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true })
    const cols = (db.prepare("PRAGMA table_info('endpoints')").all() as Array<{ name: string }>).map((c) => c.name)
    if (!cols.includes('base_url')) return 0
    const rows = db.prepare('SELECT id, name, adapter, base_url, auth, extra_headers FROM endpoints').all() as Array<{
      id: string
      name: string
      adapter: string
      base_url: string
      auth: string
      extra_headers: string
    }>
    const secrets = readSecrets(join(userData, 'secrets.json'))
    for (const r of rows) {
      if (repo.getEndpoint(r.id)) continue
      let auth: AuthConfig = { kind: 'bearer' }
      try {
        const a = JSON.parse(r.auth) as { kind?: string; name?: string }
        auth = { kind: (a.kind as AuthConfig['kind']) ?? 'bearer', ...(a.name ? { name: a.name } : {}) }
      } catch {
        /* default */
      }
      let extraHeaders: Record<string, string> = {}
      try {
        extraHeaders = JSON.parse(r.extra_headers) as Record<string, string>
      } catch {
        /* default */
      }
      const adapter: AdapterId = r.adapter === 'anthropic' || r.adapter === 'gemini' ? r.adapter : 'openai-compat'
      repo.upsertEndpoint({ id: r.id, name: r.name, adapter, baseUrl: r.base_url, auth, extraHeaders })
      const secret = secrets[r.id]
      if (secret && !hasKey(r.id)) setKey(r.id, secret)
      imported++
    }
    db.close()
  } catch {
    return imported
  }
  return imported
}

/** MCP servers from the previous Prism (name + one command line). */
export function importLegacyMcp(userData: string): McpServerConfig[] {
  const dbFile = join(userData, 'prism.db')
  if (!existsSync(dbFile)) return []
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true })
    const rows = db.prepare('SELECT id, name, command, enabled FROM mcp_servers').all() as Array<{ id: string; name: string; command: string; enabled: number }>
    db.close()
    return rows.map((r) => {
      const parts = splitCommandLine(r.command)
      return { id: r.id, name: r.name, command: parts[0] ?? r.command, args: parts.slice(1), env: {}, enabled: r.enabled === 1 }
    })
  } catch {
    return []
  }
}

function splitCommandLine(cmd: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd.trim()))) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** Old vault format: { [endpointId]: "enc:<base64 DPAPI blob>" | "plain:<base64>" } — same format as the new Vault. */
function readSecrets(file: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}
