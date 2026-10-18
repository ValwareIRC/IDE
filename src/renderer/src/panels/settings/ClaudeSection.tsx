import { useEffect, useState } from 'react'
import { CheckCircle2, CircleAlert, RefreshCw } from 'lucide-react'
import type { ClaudeStatus } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { toastError } from '@/state/ui'
import { cx, timeAgo } from '@/lib/format'

/** Claude through the Claude Code already installed on this computer. */
export function ClaudeSection(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const refreshModels = useApp((s) => s.refreshModels)
  const [status, setStatus] = useState<ClaudeStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [path, setPath] = useState(settings?.claude?.path ?? '')

  useEffect(() => {
    void prism.claude.status().then(setStatus).catch(toastError)
    return prism.claude.onChanged(setStatus)
  }, [])

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      setStatus(await prism.claude.refresh())
      await refreshModels()
    } catch (e) {
      toastError(e)
    } finally {
      setChecking(false)
    }
  }

  const savePath = async (): Promise<void> => {
    const next = path.trim() || null
    if (next === (settings?.claude?.path ?? null)) return
    await update({ claude: { path: next } }).catch(toastError)
    await check()
  }

  const enabled = settings?.claude?.enabled ?? true
  const found = !!status?.path
  const checked = !!status?.checkedAt

  return (
    <>
      <h2>Claude Agent</h2>
      <div className="lead">
        Use Claude in Prism through the Claude Code that is already on this computer. It answers with your Claude login, uses its own tools, memory and saved permissions, and Prism shows its work in the agent panel like any other model.
      </div>

      <div className="settings-section">
        <div className="card ep-card">
          {found ? <CheckCircle2 size={18} className="mint" /> : <CircleAlert size={18} className="amber" />}
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ep-name">
              {found ? 'Claude Code is installed' : 'Claude Code was not found'}
              {status?.version && <span className="chip" style={{ marginLeft: 8 }}>{status.version}</span>}
              {status?.plan && <span className="chip accent" style={{ marginLeft: 6 }}>{status.plan}</span>}
            </div>
            {found && <div className="ep-url truncate">{status?.path}</div>}
            <div className="faint xs">
              {!found && 'Install Claude Code, open a terminal, run "claude" and sign in. Then press Check again.'}
              {found && !checked && 'Not checked yet.'}
              {found && checked && !status?.error && (status?.signedIn ? `Signed in · checked ${timeAgo(status.checkedAt)}` : 'Not signed in. Open a terminal, run "claude" and use /login.')}
              {found && status?.error && <span className="rose">{status.error}</span>}
            </div>
          </div>
          <button className="btn sm" disabled={checking} onClick={() => void check()}>
            <RefreshCw size={12} className={cx(checking && "spin-slow")} /> {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>

        <div className="setting-row">
          <div className="l">
            <div className="t">Show Claude Agent in the model list</div>
            <div className="d">Adds Claude’s models to the list under the message box. Pick one to make a session a Claude session.</div>
          </div>
          <button className={cx('switch', enabled && 'on')} role="switch" aria-checked={enabled} onClick={() => void update({ claude: { enabled: !enabled } }).then(refreshModels).catch(toastError)} />
        </div>
        <div className="setting-row">
          <div className="l">
            <div className="t">Where Claude Code is</div>
            <div className="d">Leave empty to find it automatically. Fill in only if you keep it somewhere unusual.</div>
          </div>
          <input
            className="input sm mono"
            style={{ width: 340 }}
            placeholder="Found automatically"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onBlur={() => void savePath()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void savePath()
            }}
          />
        </div>
      </div>

      {found && (status?.models.length ?? 0) > 0 && (
        <div className="settings-section">
          <h3>Models your plan offers</h3>
          {status!.models.map((m) => (
            <div key={m.value} className="model-row">
              <span style={{ minWidth: 150 }}>{m.name}</span>
              <span className="faint small truncate">{m.description}</span>
            </div>
          ))}
        </div>
      )}

      <div className="settings-section">
        <h3>Helpers on your other models</h3>
        <div className="setting-row">
          <div className="l">
            <div className="t">Let Claude start helpers and fleets</div>
            <div className="d">
              Claude can hand a task to a helper on any model from any of your providers (GLM, another Claude model, anything set up here) and run your fleets (Settings, Fleets). Each helper uses that model’s own account: GLM your Z.ai credit, a Claude helper your Claude plan. Its report comes back to Claude. Each helper shows as a conversation of its own under Claude’s. Starts with Claude’s next message.
            </div>
          </div>
          <button className={cx('switch', settings?.claude?.helpers && 'on')} role="switch" aria-checked={!!settings?.claude?.helpers} aria-label="Let Claude start helpers and fleets" onClick={() => void update({ claude: { helpers: !settings?.claude?.helpers } }).catch(toastError)} />
        </div>
      </div>

      <div className="settings-section">
        <h3>How a Claude session differs</h3>
        <div className="claude-notes">
          <p>The four modes under the message box work the same. “Always allow” is remembered by Claude Code, in its own settings.</p>
          <p>Claude Code’s own commands work when you type them, for example /compact or /context.</p>
          <p>Its CLAUDE.md files, memory and MCP servers are used, the same as in a terminal or in VS Code. It can also build and use Prism’s gadgets, run the project checks and show you files. MCP servers added in Prism’s own settings are not passed on to it; add those to Claude Code instead.</p>
          <p>The cost shown for a session stays at zero when you are on a Claude plan: usage counts against your plan’s limits instead.</p>
          <p>This uses the Claude Code on this computer, signed in by you through Anthropic’s own sign-in, so it runs on your own plan or API key. Prism never sees or keeps your Claude sign-in.</p>
        </div>
      </div>
    </>
  )
}
