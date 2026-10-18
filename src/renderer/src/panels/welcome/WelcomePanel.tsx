import { FolderOpen, Plug, Sparkles, TerminalSquare } from 'lucide-react'
import { useApp } from '@/state/app'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { Logo } from '@/components/Logo'
import { basename, cx } from '@/lib/format'

export function WelcomePanel(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const endpoints = useApp((s) => s.endpoints)
  const models = useApp((s) => s.models)
  const settings = useApp((s) => s.settings)
  const openWorkspace = useApp((s) => s.openWorkspace)
  const setWorkspace = useApp((s) => s.setWorkspace)
  const openSettings = useLayout((s) => s.openSettings)
  const openAgent = useLayout((s) => s.openAgent)
  const openTerminal = useLayout((s) => s.openTerminal)
  const hasProvider = endpoints.length > 0 && models.length > 0
  const recent = (settings?.recentWorkspaces ?? []).slice(0, 6)

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-hero">
          <Logo size={52} />
          <div>
            <div className="welcome-title">Prism</div>
            <div className="welcome-sub">An agentic IDE for any model. Open a project, pick a model, start building.</div>
          </div>
        </div>

        {workspace && (
          <button className="btn solid" style={{ alignSelf: 'flex-start' }} onClick={() => useLayout.getState().openDashboard()}>
            Open the dashboard for {basename(workspace)}
          </button>
        )}
        <div className="welcome-grid">
          <button className="welcome-card" onClick={() => void openWorkspace()}>
            <span className="row">
              <span className={cx('step-badge', workspace && 'done')}>1</span>
              <FolderOpen size={16} className="ico" />
            </span>
            <span className="t">{workspace ? basename(workspace) : 'Open a folder'}</span>
            <span className="d">{workspace ? 'Switch to another project' : 'The agent works inside one project folder.'}</span>
          </button>
          <button className="welcome-card" onClick={() => openSettings('models')}>
            <span className="row">
              <span className={cx('step-badge', hasProvider && 'done')}>2</span>
              <Plug size={16} className="ico" />
            </span>
            <span className="t">{hasProvider ? `${models.length} models ready` : 'Connect a provider'}</span>
            <span className="d">{hasProvider ? 'Add more or set model roles' : 'Z.ai, Anthropic, OpenAI, Ollama, anything with a URL.'}</span>
          </button>
          <button
            className="welcome-card"
            onClick={() => {
              openAgent()
              if (workspace && useSessions.getState().sessions.length === 0) void useSessions.getState().create()
            }}
          >
            <span className="row">
              <span className="step-badge">3</span>
              <Sparkles size={16} className="ico" />
            </span>
            <span className="t">Talk to the agent</span>
            <span className="d">It reads, edits and runs your project. You approve what matters.</span>
          </button>
          <button className="welcome-card" onClick={openTerminal}>
            <span className="row">
              <TerminalSquare size={16} className="ico" />
            </span>
            <span className="t">Terminal</span>
            <span className="d">A real shell, next to the agent's.</span>
          </button>
        </div>

        {recent.length > 0 && (
          <div>
            <div className="hud-label" style={{ marginBottom: 6 }}>
              Recent
            </div>
            <div className="welcome-recent">
              {recent.map((p) => (
                <button key={p} className="recent-row" onClick={() => void setWorkspace(p)}>
                  <FolderOpen size={14} className="faint" />
                  <span>{basename(p)}</span>
                  <span className="path grow truncate">{p}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="faint small">
          <span className="kbd">Ctrl P</span> files · <span className="kbd">Ctrl Shift P</span> commands · <span className="kbd">Ctrl L</span> agent · <span className="kbd">Ctrl `</span> terminal · <span className="kbd">Ctrl K</span> inline edit in the editor
        </div>
      </div>
    </div>
  )
}
