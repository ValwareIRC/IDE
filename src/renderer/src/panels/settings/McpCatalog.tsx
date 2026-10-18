import { useEffect, useState } from 'react'
import { openLink } from '@/lib/open'
import { Check, ExternalLink, Plus } from 'lucide-react'
import type { McpServerConfig, Toolchain } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { isRemote } from '@shared/place'
import { toastError } from '@/state/ui'
import { cx } from '@/lib/format'
import { MCP_CATALOG, NEEDS, type CatalogEntry } from './mcpServers'

/** Is this catalogue entry already among the configured servers? */
function added(entry: CatalogEntry, servers: McpServerConfig[]): boolean {
  return servers.some((s) => `${s.command} ${s.args.join(' ')}`.toLowerCase().includes(entry.match))
}

/** Ready-made servers: one click adds and connects one. */
export function McpCatalog({ servers, onAdd }: { servers: McpServerConfig[]; onAdd: (server: McpServerConfig, secrets: Record<string, string>) => void }): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const [have, setHave] = useState<Toolchain | null>(null)
  const [open, setOpen] = useState<{ id: string; values: Record<string, string> } | null>(null)

  useEffect(() => {
    void prism.extend.toolchain().then(setHave).catch(toastError)
  }, [])

  const start = (e: CatalogEntry): void => {
    if (!e.inputs?.length) return finish(e, {})
    // a folder on this computer is a sensible first guess; one in WSL or over SSH is not a path the server could open
    const here = workspace && !isRemote(workspace) ? workspace : ''
    setOpen({ id: e.id, values: Object.fromEntries(e.inputs.map((i) => [i.key, i.workspace ? here : ''])) })
  }

  const finish = (e: CatalogEntry, values: Record<string, string>): void => {
    const secrets: Record<string, string> = {}
    for (const i of e.inputs ?? []) if (i.secret) secrets[i.secret] = values[i.key]?.trim() ?? ''
    const args = e.args.map((a) => a.replace(/\{(\w+)\}/g, (_m, k: string) => values[k]?.trim() ?? ''))
    onAdd({ id: crypto.randomUUID(), name: e.name, command: e.command, args, env: {}, ...(Object.keys(secrets).length ? { secrets: Object.keys(secrets) } : {}), enabled: true }, secrets)
    setOpen(null)
  }

  return (
    <div className="mcp-grid">
      {MCP_CATALOG.map((e) => {
        const has = added(e, servers)
        const missing = !has && have ? !have[e.needs] : false
        const form = open?.id === e.id ? open : null
        return (
          <div key={e.id} className={cx('card mcp-card', has && 'has')}>
            <div className="mcp-head">
              <span className="ep-name">{e.name}</span>
              <button className="icon-btn" title="About this server" onClick={() => openLink(e.link)}>
                <ExternalLink size={12} />
              </button>
            </div>
            <div className="mcp-blurb">{e.blurb}</div>
            {e.note && <div className="faint xs">{e.note}</div>}
            {form &&
              e.inputs?.map((i) => (
                <label key={i.key} className="field">
                  <span>{i.label}</span>
                  <input
                    className={cx('input sm', !i.secret && 'mono')}
                    type={i.secret ? 'password' : 'text'}
                    value={form.values[i.key] ?? ''}
                    placeholder={i.placeholder}
                    autoFocus={i === e.inputs![0]}
                    onChange={(ev) => setOpen({ id: e.id, values: { ...form.values, [i.key]: ev.target.value } })}
                  />
                  {i.hint && <span className="faint xs">{i.hint}</span>}
                </label>
              ))}
            <div className="mcp-foot">
              {missing ? (
                <>
                  <span className="chip amber">Needs {NEEDS[e.needs].label}</span>
                  <span className="grow" />
                  <button className="btn sm ghost" onClick={() => openLink(NEEDS[e.needs].url)}>
                    {NEEDS[e.needs].get}
                  </button>
                </>
              ) : has ? (
                <span className="chip mint">
                  <Check size={11} /> Added
                </span>
              ) : form ? (
                <>
                  <span className="grow" />
                  <button className="btn sm ghost" onClick={() => setOpen(null)}>
                    Cancel
                  </button>
                  <button className="btn sm solid" disabled={(e.inputs ?? []).some((i) => !form.values[i.key]?.trim())} onClick={() => finish(e, form.values)}>
                    Add
                  </button>
                </>
              ) : (
                <>
                  <span className="faint xs">Uses {NEEDS[e.needs].label}</span>
                  <span className="grow" />
                  <button className="btn sm" onClick={() => start(e)}>
                    <Plus size={12} /> Add
                  </button>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
