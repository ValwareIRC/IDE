import { useEffect, useState } from 'react'
import { Cpu, MessagesSquare, FolderTree, Keyboard, KeyRound, Lightbulb, Palette, Plug, Puzzle, ShieldCheck, SlidersHorizontal, Sparkles, Star, Terminal, Trash2, Users, Zap } from 'lucide-react'
import type { Endpoint, EndpointInput, McpServerConfig, McpStatus, PermissionRule, RemoteInfo, RoutingRule, Settings } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp, modelKey, refFromKey } from '@/state/app'
import { toastError, useUi } from '@/state/ui'
import { Select } from '@/components/Select'
import { Modal } from '@/components/Modal'
import { cx, humanTokens, timeAgo } from '@/lib/format'
import { PROVIDER_PRESETS } from './presets'
import { fontOptions } from '@/lib/fonts'
import { KeyboardSection } from './KeyboardSection'
import { ClaudeSection } from './ClaudeSection'
import { FleetsSection } from './FleetsSection'
import { ThemeStudio } from './ThemeStudio'
import { ExtendSection } from './ExtendSection'
import { McpCatalog } from './McpCatalog'
import { CONV_DEFAULT, LAYOUTS } from '@/panels/agent/Turns'
import { LOCAL_MODELS, VOICE_DEFAULT } from '@/lib/voice'
import QRCode from 'qrcode'
import { useLayout } from '@/state/layout'
import { useFace } from '@/lib/face'
import type { FaceInfo } from '@shared/ipc'

type Section = 'models' | 'claude' | 'roles' | 'agent' | 'conversation' | 'assist' | 'permissions' | 'editor' | 'files' | 'appearance' | 'keyboard' | 'extend' | 'mcp' | 'fleets'

const SECTIONS: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
  { id: 'models', label: 'Providers', icon: <Plug size={15} /> },
  { id: 'claude', label: 'Claude Agent', icon: <Sparkles size={15} /> },
  { id: 'fleets', label: 'Fleets', icon: <Users size={15} /> },
  { id: 'roles', label: 'Model roles', icon: <Cpu size={15} /> },
  { id: 'agent', label: 'Agent', icon: <Zap size={15} /> },
  { id: 'conversation', label: 'Conversation', icon: <MessagesSquare size={15} /> },
  { id: 'assist', label: 'Helpers & extras', icon: <Lightbulb size={15} /> },
  { id: 'permissions', label: 'Permissions', icon: <ShieldCheck size={15} /> },
  { id: 'editor', label: 'Editor & terminal', icon: <Terminal size={15} /> },
  { id: 'files', label: 'Files', icon: <FolderTree size={15} /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={15} /> },
  { id: 'keyboard', label: 'Keyboard', icon: <Keyboard size={15} /> },
  { id: 'extend', label: 'Skills, tools & rules', icon: <Puzzle size={15} /> },
  { id: 'mcp', label: 'MCP servers', icon: <SlidersHorizontal size={15} /> }
]

export function SettingsPanel({ section: initial, at }: { section?: string; at?: number }): React.JSX.Element {
  const [section, setSection] = useState<Section>((initial as Section) || 'models')
  useEffect(() => {
    if (initial) setSection(initial as Section)
  }, [initial, at])
  return (
    <div className="settings">
      <nav className="settings-nav">
        {SECTIONS.map((s) => (
          <button key={s.id} className={cx(section === s.id && 'on')} data-demo={`settings:${s.id}`} onClick={() => setSection(s.id)}>
            {s.icon} {s.label}
          </button>
        ))}
      </nav>
      <div className="settings-body selectable">
        {section === 'models' && <ProvidersSection />}
        {section === 'claude' && <ClaudeSection />}
        {section === 'roles' && <RolesSection />}
        {section === 'agent' && <AgentSection />}
        {section === 'fleets' && <FleetsSection />}
        {section === 'conversation' && <ConversationSection />}
        {section === 'assist' && <AssistSection />}
        {section === 'files' && <FilesSection />}
        {section === 'permissions' && <PermissionsSection />}
        {section === 'editor' && <EditorSection />}
        {section === 'appearance' && <ThemeStudio />}
        {section === 'keyboard' && <KeyboardSection />}
        {section === 'extend' && <ExtendSection />}
        {section === 'mcp' && <McpSection />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- shared bits

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="setting-row">
      <div className="l">
        <div className="t">{title}</div>
        {desc && <div className="d">{desc}</div>}
      </div>
      {children}
    </div>
  )
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return <button className={cx('switch', on && 'on')} onClick={() => onChange(!on)} role="switch" aria-checked={on} />
}

function useSettingsPatch(): [Settings | null, (patch: Parameters<typeof prism.settings.update>[0]) => void] {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  return [settings, (p) => void update(p).catch(toastError)]
}

// ---------------------------------------------------------------- providers

function ProvidersSection(): React.JSX.Element {
  const endpoints = useApp((s) => s.endpoints)
  const models = useApp((s) => s.models)
  const refresh = useApp((s) => s.refreshModels)
  const [editing, setEditing] = useState<Partial<EndpointInput> | null>(null)
  const [probing, setProbing] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const probe = async (id: string): Promise<void> => {
    setProbing(id)
    try {
      const r = await prism.endpoints.probe(id)
      if (r.ok) useUi.getState().toast('success', `Found ${r.models.length} models`, `${r.latencyMs}ms`)
      else useUi.getState().toast('error', 'Could not reach the endpoint', r.error)
      await refresh()
    } finally {
      setProbing(null)
    }
  }

  const remove = async (e: Endpoint): Promise<void> => {
    if (!window.confirm(`Remove ${e.name}? Its models and key are deleted.`)) return
    await prism.endpoints.delete(e.id)
    await refresh()
  }

  const grouped = new Map<string, typeof models>()
  for (const m of models) {
    // Claude Agent's models have their own page
    if (m.endpointId === 'claude-agent') continue
    if (filter && !m.modelId.toLowerCase().includes(filter.toLowerCase())) continue
    const l = grouped.get(m.endpointId) ?? []
    l.push(m)
    grouped.set(m.endpointId, l)
  }

  return (
    <>
      <h2>Providers</h2>
      <div className="lead">Any OpenAI-compatible server, plus Anthropic and Gemini natively. Keys live in the OS keychain.</div>
      <div className="settings-section">
        {endpoints.map((e) => (
          <div key={e.id} className="card ep-card">
            <KeyRound size={16} className={e.hasKey ? 'accent' : 'faint'} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ep-name">
                {e.name} <span className="chip" style={{ marginLeft: 6 }}>{e.adapter}</span>
              </div>
              <div className="ep-url truncate">{e.baseUrl}</div>
              <div className="faint xs">
                {e.probedAt ? `${models.filter((m) => m.endpointId === e.id).length} models · probed ${timeAgo(e.probedAt)}${e.probeLatencyMs ? ` · ${e.probeLatencyMs}ms` : ''}` : 'not probed yet'}
                {e.probeError && <span className="rose"> · {e.probeError}</span>}
              </div>
            </div>
            <button className="btn sm" onClick={() => void probe(e.id)} disabled={probing === e.id}>
              {probing === e.id ? <span className="spinner" /> : null} Probe
            </button>
            <button className="btn sm ghost" onClick={() => setEditing({ id: e.id, name: e.name, adapter: e.adapter, baseUrl: e.baseUrl, auth: e.auth, extraHeaders: e.extraHeaders })}>
              Edit
            </button>
            <button className="icon-btn" title="Remove" onClick={() => void remove(e)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="settings-section">
        <h3>Add a provider</h3>
        <div className="preset-grid">
          {PROVIDER_PRESETS.map((p) => (
            <button key={p.id} className="preset" onClick={() => setEditing({ name: p.label, adapter: p.adapter, baseUrl: p.baseUrl, auth: p.auth })}>
              <span>{p.label}</span>
              <span className="b">{p.blurb}</span>
            </button>
          ))}
          <button className="preset" onClick={() => setEditing({ name: '', adapter: 'openai-compat', baseUrl: '', auth: { kind: 'bearer' } })}>
            <span>Custom…</span>
            <span className="b">Any URL</span>
          </button>
        </div>
      </div>
      {models.length > 0 && (
        <div className="settings-section">
          <h3>Models</h3>
          <input className="input sm" placeholder="Filter models" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 8, maxWidth: 320 }} />
          {[...grouped.entries()].map(([epId, list]) => (
            <div key={epId} style={{ marginBottom: 12 }}>
              <div className="hud-label" style={{ margin: '6px 8px' }}>
                {list[0]?.endpointName}
              </div>
              {list.map((m) => (
                <div key={m.key} className="model-row">
                  <button className={cx('icon-btn sm star', m.favorite && 'on')} title="Favourite" onClick={() => void prism.models.favorite(m.key, !m.favorite).then(refresh)}>
                    <Star size={13} fill={m.favorite ? 'currentColor' : 'none'} />
                  </button>
                  <span className="mono">{m.modelId}</span>
                  <span className="caps">
                    {m.supportsTools && <span className="chip">tools</span>}
                    {m.supportsVision && <span className="chip violet">vision</span>}
                    {m.reasoning && <span className="chip accent">reasoning</span>}
                    {m.contextWindow && <span className="chip">{humanTokens(m.contextWindow)} ctx</span>}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {editing && <EndpointModal initial={editing} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); void refresh().then(() => probe(id)) }} />}
    </>
  )
}

function EndpointModal({ initial, onClose, onSaved }: { initial: Partial<EndpointInput>; onClose: () => void; onSaved: (id: string) => void }): React.JSX.Element {
  const [form, setForm] = useState<EndpointInput>({
    id: initial.id,
    name: initial.name ?? '',
    adapter: initial.adapter ?? 'openai-compat',
    baseUrl: initial.baseUrl ?? '',
    auth: initial.auth ?? { kind: 'bearer' },
    extraHeaders: initial.extraHeaders ?? {},
    apiKey: ''
  })
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    if (!form.name.trim() || !form.baseUrl.trim()) return
    setBusy(true)
    try {
      const e = await prism.endpoints.save({ ...form, apiKey: form.apiKey?.trim() || undefined })
      onSaved(e.id)
    } catch (err) {
      toastError(err, 'Could not save')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={form.id ? 'Edit provider' : 'Add provider'}
      icon={<Plug size={16} />}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn solid" onClick={() => void save()} disabled={busy || !form.name.trim() || !form.baseUrl.trim()}>
            {form.id ? 'Save' : 'Add & probe'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        </label>
        <label className="field">
          <span>API</span>
          <Select
            value={form.adapter}
            options={[
              { value: 'openai-compat', label: 'OpenAI-compatible' },
              { value: 'anthropic', label: 'Anthropic' },
              { value: 'gemini', label: 'Google Gemini' }
            ]}
            onChange={(v) => setForm({ ...form, adapter: v as EndpointInput['adapter'] })}
          />
        </label>
        <label className="field span2">
          <span>Base URL</span>
          <input className="input mono" value={form.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
        </label>
        <label className="field span2">
          <span>API key {form.id ? <span className="faint">(leave blank to keep the stored key)</span> : null}</span>
          <input className="input mono" type="password" value={form.apiKey ?? ''} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={form.auth.kind === 'none' ? 'not needed' : 'sk-…'} />
        </label>
        <label className="field">
          <span>Auth style</span>
          <Select
            value={form.auth.kind}
            options={[
              { value: 'bearer', label: 'Bearer token' },
              { value: 'header', label: 'Custom header' },
              { value: 'query', label: 'Query parameter' },
              { value: 'none', label: 'None (local server)' }
            ]}
            onChange={(v) => setForm({ ...form, auth: { kind: v as EndpointInput['auth']['kind'], name: form.auth.name } })}
          />
        </label>
        {(form.auth.kind === 'header' || form.auth.kind === 'query') && (
          <label className="field">
            <span>{form.auth.kind === 'header' ? 'Header name' : 'Parameter name'}</span>
            <input className="input mono" value={form.auth.name ?? ''} placeholder={form.auth.kind === 'header' ? 'x-api-key' : 'key'} onChange={(e) => setForm({ ...form, auth: { ...form.auth, name: e.target.value } })} />
          </label>
        )}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- roles

function RolesSection(): React.JSX.Element {
  const [settings, patch] = useSettingsPatch()
  const models = useApp((s) => s.models)
  if (!settings) return <></>
  const routing = settings.routing ?? { enabled: false, rules: [] }
  const setRules = (rules: RoutingRule[]): void => patch({ routing: { rules } })
  const opts = (filter?: (m: (typeof models)[number]) => boolean) =>
    models.filter(filter ?? (() => true)).map((m) => ({ value: m.key, label: m.label ?? m.modelId, group: m.endpointName }))
  // Claude Agent models answer one-off requests through Claude Code, but cannot drive Prism's own agent mid-request
  // (Fallback, Strong) and are too slow and plan-hungry for ghost text, which asks on every pause in typing
  const notClaude = (m: (typeof models)[number]): boolean => m.endpointId !== 'claude-agent'
  const role = (k: keyof Settings['roles'], title: string, desc: string, filter?: (m: (typeof models)[number]) => boolean): React.JSX.Element => (
    <Row title={title} desc={desc}>
      <Select
        value={modelKey(settings.roles[k])}
        options={[{ value: '__none__', label: 'Automatic' }, ...opts(filter)]}
        searchable
        width={340}
        align="right"
        onChange={(v) => patch({ roles: { [k]: v === '__none__' ? null : refFromKey(v) } })}
      />
    </Row>
  )
  return (
    <>
      <h2>Model roles</h2>
      <div className="lead">Different jobs, different models. Leave on automatic to use the lead model everywhere.</div>
      <div className="settings-section">
        {role('lead', 'Lead agent', 'Plans, edits and runs commands. Needs tool calling.', (m) => m.supportsTools)}
        {role('fast', 'Fast model', 'Session titles, context compaction and small questions. Cheap and quick is ideal. A Claude model answers through Claude Code and counts against your plan.')}
        {role('completion', 'Ghost text', 'Inline completions in the editor. Set to enable; a small fast model works best. Not Claude Agent: it asks on every pause in typing, which through Claude Code is seconds each time and uses your plan fast.', notClaude)}
        {role('vision', 'Vision', 'Describes images for a text-only lead model. Any vision-capable model works.', (m) => m.supportsVision)}
        {role('fallback', 'Fallback', 'Takes over for the rest of a run when the lead keeps stalling or erroring. Pick a different model or provider. Not Claude Agent: it takes over Prism’s own agent, which cannot run Claude.', (m) => m.supportsTools && notClaude(m))}
        {role('strong', 'Strong', 'Takes over the rest of a request when the agent keeps going round in circles. A more capable model than the lead. Not Claude Agent: it takes over Prism’s own agent, which cannot run Claude.', (m) => m.supportsTools && notClaude(m))}
        {role('review', 'Review', 'Reviews each turn\'s changes when automatic review is on (Helpers & extras). Blank uses the Fast model.')}
      </div>
      <h2 style={{ marginTop: 26 }}>Routing</h2>
      <div className="lead">Let rules choose the model for each message. They apply to sessions whose model is set to “Auto” in the message box. The first rule that fits wins; if none fits, the lead model answers.</div>
      <div className="settings-section">
        <Row title="Use routing rules" desc="Adds “Auto” to the model list under the message box.">
          <Switch on={routing.enabled} onChange={(v) => patch({ routing: { enabled: v } })} />
        </Row>
        <Row title="Otherwise, by how hard it looks" desc="When no rule matches, the Fast model judges the request in a moment: easy ones go to the Fast model, hard ones to the Strong model (Model roles), the rest to your main model.">
          <Switch on={routing.byDifficulty ?? false} onChange={(v) => patch({ routing: { byDifficulty: v } })} />
        </Row>
        {routing.rules.map((r, i) => (
          <div key={i} className="route-row">
            <span className="dim small">When</span>
            <Select
              value={r.when}
              size="sm"
              width={230}
              options={[
                { value: 'image', label: 'the message has a picture' },
                { value: 'plan', label: 'the session is in Plan first' },
                { value: 'short', label: 'the message is short' },
                { value: 'long', label: 'the message is long' },
                { value: 'keyword', label: 'the message mentions' }
              ]}
              onChange={(v) => setRules(routing.rules.map((x, j) => (j === i ? { ...x, when: v as RoutingRule['when'], value: v === 'short' ? '200' : v === 'long' ? '2000' : '' } : x)))}
            />
            {(r.when === 'short' || r.when === 'long' || r.when === 'keyword') && (
              <input
                className="input sm"
                style={{ width: r.when === 'keyword' ? 190 : 86 }}
                placeholder={r.when === 'keyword' ? 'words, separated by commas' : 'characters'}
                value={r.value ?? ''}
                onChange={(e) => setRules(routing.rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
            )}
            <span className="dim small">use</span>
            <Select
              value={modelKey(r.model)}
              size="sm"
              searchable
              width={300}
              placeholder="Pick a model"
              options={opts(r.when === 'image' ? (m) => m.supportsVision && m.supportsTools : (m) => m.supportsTools)}
              onChange={(v) => setRules(routing.rules.map((x, j) => (j === i ? { ...x, model: refFromKey(v) } : x)))}
            />
            <span className="grow" />
            <button className="icon-btn sm" title="Remove this rule" onClick={() => setRules(routing.rules.filter((_, j) => j !== i))}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => setRules([...routing.rules, { when: 'short', value: '200', model: settings.roles.fast ?? null }])}>
          Add a rule
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- agent

/** Vibecoding Safety Biteback, for the project open in this window (core/biteback/biteback.ts). */
function BitebackRow(): React.JSX.Element | null {
  const workspace = useApp((s) => s.workspace)
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    if (!workspace) return
    void prism.agent.biteback().then(setOn).catch(() => setOn(false))
  }, [workspace])
  if (!workspace || on === null) return null
  return (
    <div className="settings-section">
      <Row
        title="Vibecoding Safety Biteback (this project)"
        desc="For work where you don't know the ground well yet. The agent acts like a fair colleague instead of doing whatever it's told: it insists that what has to come first comes first and explains why, and you can choose your way anyway. It can refuse a direction if you're being unreasonable, and end a conversation that has turned abusive or keeps going in circles, leaving a handover. Anger at its own mistakes never counts. Every insistence, override and refusal goes into the Decisions ledger."
      >
        <Switch
          on={on}
          onChange={(v) => {
            setOn(v)
            void prism.agent.biteback(v).catch(() => setOn(!v))
          }}
        />
      </Row>
    </div>
  )
}

function AgentSection(): React.JSX.Element {
  const [settings, patch] = useSettingsPatch()
  if (!settings) return <></>
  const a = settings.agent
  return (
    <>
      <h2>Agent</h2>
      <div className="lead">How the lead agent runs.</div>
      <BitebackRow />
      <div className="settings-section">
        <Row title="Max steps per message" desc="Each model call is one step. Tool loops stop here.">
          <input className="input sm" type="number" min={1} max={1000} value={a.maxSteps} onChange={(e) => patch({ agent: { maxSteps: Math.max(1, Number(e.target.value) || 1) } })} />
        </Row>
        <Row title="Compact at" desc="Summarise the conversation when context use passes this fraction of the model's window.">
          <input className="input sm" type="number" min={0.3} max={0.95} step={0.05} value={a.compactAt} onChange={(e) => patch({ agent: { compactAt: Math.min(0.95, Math.max(0.3, Number(e.target.value) || 0.8)) } })} />
        </Row>
        <Row title="Warn when a conversation gets big" desc="Every step the model takes sends the whole conversation, so a big one uses your plan or credit fast. Above this size (in thousands of tokens) the agent panel says so and offers to summarise it or start fresh. 0 never warns.">
          <input className="input sm" type="number" min={0} max={2000} step={50} value={a.sizeWarnK ?? 200} onChange={(e) => patch({ agent: { sizeWarnK: Math.max(0, Math.min(2000, Math.floor(Number(e.target.value) || 0))) } })} />
        </Row>
        <Row title="Reasoning" desc="Ask models that support it to think before answering. Costs tokens, improves hard tasks.">
          <Switch on={a.reasoning} onChange={(v) => patch({ agent: { reasoning: v } })} />
        </Row>
        <Row title="Parallel read-only tools" desc="Run several reads and searches at once when the model asks for them together.">
          <Switch on={a.parallelTools} onChange={(v) => patch({ agent: { parallelTools: v } })} />
        </Row>
        <Row title="Repair my tools and gadgets" desc="When one of your own tools or gadgets fails, the agent works out a fix in a session called Repairs. A fixed tool waits for your OK; a gadget fix asks before it is written.">
          <Switch on={a.selfRepair} onChange={(v) => patch({ agent: { selfRepair: v } })} />
        </Row>
        <Row title="Temperature" desc="Blank uses the provider default.">
          <input className="input sm" type="number" min={0} max={2} step={0.1} value={a.temperature ?? ''} placeholder="default" onChange={(e) => patch({ agent: { temperature: e.target.value === '' ? null : Number(e.target.value) } })} />
        </Row>
        <Row title="Time limit for a command" desc="The longest one shell command may run before it is stopped, in seconds. Commands run in the background are not limited.">
          <input className="input sm" type="number" min={5} max={7200} value={a.shellTimeoutSec ?? 120} onChange={(e) => patch({ agent: { shellTimeoutSec: Math.max(5, Math.min(7200, Math.floor(Number(e.target.value) || 120))) } })} />
        </Row>
        <Row title="Tries when the model fails" desc="How many times a call that failed for a passing reason (the connection dropped, the provider was busy) is tried again before giving up or moving to the Fallback model.">
          <input className="input sm" type="number" min={0} max={10} value={a.retries ?? 3} onChange={(e) => patch({ agent: { retries: Math.max(0, Math.min(10, Math.floor(Number(e.target.value) || 0))) } })} />
        </Row>
        <Row title="Fix-ups after a failing check" desc="When a check that runs at the end of a turn fails (see Automations), the agent is sent back to fix it this many times in a row at most. 0 just reports it.">
          <input className="input sm" type="number" min={0} max={10} value={a.hookFixes ?? 2} onChange={(e) => patch({ agent: { hookFixes: Math.max(0, Math.min(10, Math.floor(Number(e.target.value) || 0))) } })} />
        </Row>
        <Row title="Largest team" desc="The most helpers the agent may put in one team.">
          <input className="input sm" type="number" min={1} max={40} value={a.maxTeam ?? 12} onChange={(e) => patch({ agent: { maxTeam: Math.max(1, Math.min(40, Math.floor(Number(e.target.value) || 12))) } })} />
        </Row>
        <Row title="Name new sessions" desc="Give a new session a title from its first message. Off leaves it as New session until you rename it.">
          <Switch on={a.autoTitle ?? true} onChange={(v) => patch({ agent: { autoTitle: v } })} />
        </Row>
        <Row title="Sending a message" desc="Which key sends what you typed. With Enter, Shift+Enter starts a new line; with Ctrl+Enter, Enter does.">
          <Select
            value={a.sendKey ?? 'enter'}
            size="sm"
            options={[
              { value: 'enter', label: 'Enter sends' },
              { value: 'ctrl-enter', label: 'Ctrl+Enter sends' }
            ]}
            onChange={(v) => patch({ agent: { sendKey: v as 'enter' | 'ctrl-enter' } })}
          />
        </Row>
        <Row title="Send what I'm looking at" desc="Put the file you have open in the editor, and anything selected in it, alongside your message. The message box always shows what is going, and you can take it off before you send.">
          <Select
            value={a.editorContext ?? 'selection-and-file'}
            size="sm"
            width={220}
            options={[
              { value: 'selection-and-file', label: 'Selected code and file name' },
              { value: 'selection', label: 'Only selected code' },
              { value: 'off', label: 'Nothing' }
            ]}
            onChange={(v) => patch({ agent: { editorContext: v as 'selection-and-file' | 'selection' | 'off' } })}
          />
        </Row>
        <Row title="Wake-ups in a row" desc="The agent is woken when something it started in the background finishes, a timer it set goes off, or a helper or another session reports back. After this many in a row without you writing, it waits for you. 0 never wakes it.">
          <input className="input sm" type="number" min={0} max={100} value={a.wakeLimit ?? 10} onChange={(e) => patch({ agent: { wakeLimit: Math.max(0, Math.min(100, Math.floor(Number(e.target.value) || 0))) } })} />
        </Row>
      </div>
      <MemoryList />
    </>
  )
}

/** What the agent has saved to remember, for this project and for every project. */
function MemoryList(): React.JSX.Element {
  const [list, setList] = useState<Array<{ name: string; description: string; body: string; scope: 'project' | 'personal' }> | null>(null)
  const [open, setOpen] = useState('')
  const load = (): void => void prism.memory.list().then(setList).catch(() => setList([]))
  useEffect(load, [])
  const forget = async (name: string): Promise<void> => {
    try {
      await prism.memory.remove(name)
      load()
    } catch (e) {
      toastError(e)
    }
  }
  const group = (scope: 'personal' | 'project', title: string, empty: string): React.JSX.Element => {
    const items = (list ?? []).filter((m) => m.scope === scope)
    return (
      <>
        <h3>{title}</h3>
        {items.length === 0 ? (
          <div className="faint small" style={{ padding: '2px 2px 10px' }}>
            {empty}
          </div>
        ) : (
          items.map((m) => (
            <div key={m.name} className="memory-row">
              <button className="memory-head" onClick={() => setOpen((o) => (o === m.name ? '' : m.name))}>
                <b>{m.name}</b>
                <span className="faint truncate">{m.description}</span>
              </button>
              <button className="icon-btn sm" title="Forget this" onClick={() => void forget(m.name)}>
                <Trash2 size={12} />
              </button>
              {open === m.name && <pre className="memory-body selectable">{m.body}</pre>}
            </div>
          ))
        )}
      </>
    )
  }
  return (
    <div className="settings-section">
      <div className="lead" style={{ marginBottom: 8 }}>
        What Prism remembers between sessions. It saves these itself (or when you say "remember…"), sees the list at the start of every session, and reads one in full when it matters.
      </div>
      {list === null ? <div className="faint small">Loading…</div> : <>{group('personal', 'About you, in every project', 'Nothing yet.')}{group('project', 'About this project', 'Nothing yet. These are kept in .prism/memory in the project.')}</>}
    </div>
  )
}

// ---------------------------------------------------------------- permissions

function PermissionsSection(): React.JSX.Element {
  const [settings, patch] = useSettingsPatch()
  const [tool, setTool] = useState('shell')
  const [pattern, setPattern] = useState('')
  if (!settings) return <></>
  const p = settings.permissions
  const add = (kind: 'allow' | 'deny'): void => {
    const rule: PermissionRule = { tool: tool.trim(), ...(pattern.trim() ? { pattern: pattern.trim() } : {}) }
    if (!rule.tool) return
    patch({ permissions: { [kind]: [...p[kind], rule] } })
    setPattern('')
  }
  const list = (kind: 'allow' | 'deny'): React.JSX.Element => (
    <>
      {p[kind].length === 0 && <div className="faint small">No rules</div>}
      {p[kind].map((r, i) => (
        <div key={i} className="rule-row">
          <span className={kind === 'allow' ? 'mint' : 'rose'}>{kind}</span>
          <span>{r.tool}</span>
          {r.pattern && <span className="dim">{r.pattern}</span>}
          <span className="grow" />
          <button className="icon-btn sm" onClick={() => patch({ permissions: { [kind]: p[kind].filter((_, j) => j !== i) } })}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </>
  )
  return (
    <>
      <h2>Permissions</h2>
      <div className="lead">What the agent may do without asking. Patterns match the command or path with * wildcards.</div>
      <div className="settings-section">
        <Row title="Default mode for new sessions" desc="Plan first: Prism only reads, then shows a plan to approve. Ask first: approve each change. Edit freely: file edits run, commands ask. Full auto: only your block rules apply.">
          <div className="seg">
            {(['plan', 'ask', 'auto-edit', 'auto'] as const).map((m) => (
              <button key={m} className={cx(p.mode === m && 'on')} onClick={() => patch({ permissions: { mode: m } })}>
                {m === 'plan' ? 'Plan first' : m === 'ask' ? 'Ask first' : m === 'auto-edit' ? 'Edit freely' : 'Full auto'}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Let a quick checker approve the obvious ones" desc="Before you are asked, the Review model (or the Fast one) looks at the action and what you asked for. If it is plainly part of your request and harmless, it goes ahead and the step says why. Anything else still comes to you, with what the checker noticed. Risky actions always come to you.">
          <Switch on={p.checker ?? false} onChange={(v) => patch({ permissions: { checker: v } })} />
        </Row>
      </div>
      <div className="settings-section">
        <h3>Add a rule</h3>
        <div className="row">
          <Select
            value={tool}
            options={['shell', 'write_file', 'edit_file', 'delete_path', 'move_path', 'web_fetch', 'mcp__*'].map((t) => ({ value: t, label: t }))}
            onChange={setTool}
            width={200}
          />
          <input className="input sm grow mono" placeholder="pattern, e.g. pnpm test* or src/**" value={pattern} onChange={(e) => setPattern(e.target.value)} />
          <button className="btn sm" onClick={() => add('allow')}>Allow</button>
          <button className="btn sm danger" onClick={() => add('deny')}>Deny</button>
        </div>
      </div>
      <div className="settings-section">
        <h3>Allow rules</h3>
        {list('allow')}
      </div>
      <div className="settings-section">
        <h3>Deny rules</h3>
        {list('deny')}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- editor & terminal

function EditorSection(): React.JSX.Element {
  const [settings, patch] = useSettingsPatch()
  const [installed, setInstalled] = useState<string[]>([])
  useEffect(() => void prism.themes.fonts().then(setInstalled).catch(() => {}), [])
  if (!settings) return <></>
  const e = settings.editor
  const term = settings.terminal
  const num = (v: string, d: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Number.isFinite(Number(v)) && v !== '' ? Number(v) : d))
  return (
    <>
      <h2>Editor & terminal</h2>
      <div className="lead">How code looks and behaves in the editor, and the terminals.</div>
      <div className="settings-section">
        <h3>Text</h3>
        <Row title="Font size">
          <input className="input sm" type="number" min={9} max={28} value={e.fontSize} onChange={(ev) => patch({ editor: { fontSize: num(ev.target.value, 13, 9, 28) } })} />
        </Row>
        <Row title="Line height" desc="Pixels from one line to the next.">
          <input className="input sm" type="number" min={12} max={40} value={e.lineHeight ?? 20} onChange={(ev) => patch({ editor: { lineHeight: num(ev.target.value, 20, 12, 40) } })} />
        </Row>
        <Row title="Joined symbols" desc="Draw => and != as single symbols, when the code font has them.">
          <Switch on={e.fontLigatures ?? true} onChange={(v) => patch({ editor: { fontLigatures: v } })} />
        </Row>
        <Row title="Tab size">
          <input className="input sm" type="number" min={1} max={8} value={e.tabSize} onChange={(ev) => patch({ editor: { tabSize: num(ev.target.value, 2, 1, 8) } })} />
        </Row>
        <Row title="Indent with spaces" desc="Off indents with tab characters.">
          <Switch on={e.insertSpaces ?? true} onChange={(v) => patch({ editor: { insertSpaces: v } })} />
        </Row>
        <Row title="Word wrap">
          <Switch on={e.wordWrap} onChange={(v) => patch({ editor: { wordWrap: v } })} />
        </Row>
        <Row title="Show spaces and tabs">
          <Select
            value={e.renderWhitespace ?? 'selection'}
            size="sm"
            options={[
              { value: 'none', label: 'Never' },
              { value: 'selection', label: 'In selected text' },
              { value: 'boundary', label: 'Except single spaces' },
              { value: 'all', label: 'Always' }
            ]}
            onChange={(v) => patch({ editor: { renderWhitespace: v as Settings['editor']['renderWhitespace'] } })}
          />
        </Row>
      </div>
      <div className="settings-section">
        <h3>Around the code</h3>
        <Row title="Line numbers">
          <Select
            value={e.lineNumbers ?? 'on'}
            size="sm"
            options={[
              { value: 'on', label: 'Shown' },
              { value: 'relative', label: 'Counted from the cursor' },
              { value: 'off', label: 'Hidden' }
            ]}
            onChange={(v) => patch({ editor: { lineNumbers: v as Settings['editor']['lineNumbers'] } })}
          />
        </Row>
        <Row title="Minimap" desc="A small picture of the whole file at the side.">
          <Switch on={e.minimap} onChange={(v) => patch({ editor: { minimap: v } })} />
        </Row>
        <Row title="Keep the current function in view" desc="Its first line stays at the top while you scroll through it.">
          <Switch on={e.stickyScroll ?? true} onChange={(v) => patch({ editor: { stickyScroll: v } })} />
        </Row>
        <Row title="Coloured brackets" desc="Matching brackets share a colour, with guide lines between them.">
          <Switch on={e.bracketColours ?? true} onChange={(v) => patch({ editor: { bracketColours: v } })} />
        </Row>
        <Row title="Cursor">
          <Select
            value={e.cursorBlinking ?? 'smooth'}
            size="sm"
            options={[
              { value: 'smooth', label: 'Fades in and out' },
              { value: 'blink', label: 'Blinks' },
              { value: 'phase', label: 'Pulses' },
              { value: 'solid', label: 'Stays still' }
            ]}
            onChange={(v) => patch({ editor: { cursorBlinking: v as Settings['editor']['cursorBlinking'] } })}
          />
        </Row>
        <Row title="Smooth scrolling">
          <Switch on={e.smoothScrolling ?? true} onChange={(v) => patch({ editor: { smoothScrolling: v } })} />
        </Row>
      </div>
      <div className="settings-section">
        <h3>Saving and suggestions</h3>
        <Row title="Save by itself" desc="Files you change are saved without Ctrl+S.">
          <Select
            value={e.autoSave ?? 'off'}
            size="sm"
            options={[
              { value: 'off', label: 'Never' },
              { value: 'delay', label: 'When I stop typing' },
              { value: 'focus', label: 'When I leave the editor' }
            ]}
            onChange={(v) => patch({ editor: { autoSave: v as Settings['editor']['autoSave'] } })}
          />
        </Row>
        {e.autoSave === 'delay' && (
          <Row title="After I stop typing for (ms)">
            <input className="input sm" type="number" min={200} max={30000} step={100} value={e.autoSaveDelayMs ?? 1000} onChange={(ev) => patch({ editor: { autoSaveDelayMs: num(ev.target.value, 1000, 200, 30000) } })} />
          </Row>
        )}
        <Row title="Tidy the file when saving" desc="Run the language's formatter on Ctrl+S (not on saves made by itself).">
          <Switch on={e.formatOnSave} onChange={(v) => patch({ editor: { formatOnSave: v } })} />
        </Row>
        <Row title="Ghost text completions" desc="Needs a model in the Ghost text role. Tab accepts.">
          <Switch on={e.ghostText} onChange={(v) => patch({ editor: { ghostText: v } })} />
        </Row>
        <Row title="Ghost text delay (ms)">
          <input className="input sm" type="number" min={0} max={3000} step={50} value={e.ghostTextDelayMs} onChange={(ev) => patch({ editor: { ghostTextDelayMs: num(ev.target.value, 350, 0, 3000) } })} />
        </Row>
        <Row title="Offer the same change elsewhere" desc="After you save a change, look for other places that need the same change and offer them in the status bar.">
          <Switch on={e.nextEdit ?? true} onChange={(v) => patch({ editor: { nextEdit: v } })} />
        </Row>
        <Row title="Mark the lines the agent wrote" desc="A thin bar in the margin, one colour per conversation. Hover a line to see which request wrote it and why; click the bar to open that conversation there.">
          <Switch on={e.agentLines ?? true} onChange={(v) => patch({ editor: { agentLines: v } })} />
        </Row>
      </div>
      <div className="settings-section">
        <h3>Terminal</h3>
        <Row title="Shell" desc="Blank uses PowerShell on Windows, $SHELL elsewhere. Also used by the agent's shell tool.">
          <input className="input mono" style={{ width: 260 }} placeholder="pwsh.exe" value={term.shell ?? ''} onChange={(ev) => patch({ terminal: { shell: ev.target.value || null } })} />
        </Row>
        <Row title="Terminal font" desc="Its own lettering, or the code font of your theme.">
          <Select
            value={term.fontFamily ?? ''}
            size="sm"
            searchable
            width={300}
            align="right"
            options={[{ value: '', label: "The theme's code font", group: 'Follow the theme' }, ...fontOptions(installed, true)]}
            onChange={(v) => patch({ terminal: { fontFamily: v, ...(v === 'Fixedsys Excelsior' && term.fontSize !== 16 ? { fontSize: 16, lineHeight: 1 } : {}) } })}
          />
        </Row>
        <Row title="Terminal font size" desc={term.fontFamily === 'Fixedsys Excelsior' ? 'Fixedsys Excelsior is drawn in pixels: it is sharpest at 16 (or 32).' : undefined}>
          <input className="input sm" type="number" min={9} max={40} value={term.fontSize} onChange={(ev) => patch({ terminal: { fontSize: num(ev.target.value, 13, 9, 40) } })} />
        </Row>
        <Row title="Terminal line height" desc="Space from one line to the next, as a multiple of the font size. 1 is tight; 1.2 is roomy.">
          <input className="input sm" type="number" min={0.8} max={2} step={0.05} value={term.lineHeight ?? 1} onChange={(ev) => patch({ terminal: { lineHeight: num(ev.target.value, 1, 0.8, 2) } })} />
        </Row>
        <Row title="Lines kept for scrolling back">
          <input className="input sm" type="number" min={100} max={200000} step={1000} value={term.scrollback ?? 8000} onChange={(ev) => patch({ terminal: { scrollback: num(ev.target.value, 8000, 100, 200000) } })} />
        </Row>
        <Row title="Cursor shape">
          <Select
            value={term.cursorStyle ?? 'bar'}
            size="sm"
            options={[
              { value: 'bar', label: 'Line' },
              { value: 'block', label: 'Block' },
              { value: 'underline', label: 'Underline' }
            ]}
            onChange={(v) => patch({ terminal: { cursorStyle: v as Settings['terminal']['cursorStyle'] } })}
          />
        </Row>
        <Row title="Blinking cursor">
          <Switch on={term.cursorBlink ?? true} onChange={(v) => patch({ terminal: { cursorBlink: v } })} />
        </Row>
        <Row title="Copy when I select" desc="Selected text goes straight to the clipboard.">
          <Switch on={term.copyOnSelect ?? false} onChange={(v) => patch({ terminal: { copyOnSelect: v } })} />
        </Row>
        <Row title="Follow the project" desc="When you switch project, close idle terminals from the old one and open one in the new. Terminals with something running are kept either way.">
          <Switch on={term.followProject ?? true} onChange={(v) => patch({ terminal: { followProject: v } })} />
        </Row>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- helpers & extras

function ConversationSection(): React.JSX.Element {
  const [settings, patch] = useSettingsPatch()
  if (!settings) return <></>
  const c = { ...CONV_DEFAULT, ...settings.conversation }
  const seg = <T extends string>(value: T, options: Array<[T, string]>, set: (v: T) => void): React.JSX.Element => (
    <div className="seg">
      {options.map(([v, l]) => (
        <button key={v} className={cx(value === v && 'on')} onClick={() => set(v)}>
          {l}
        </button>
      ))}
    </div>
  )
  return (
    <>
      <h2>Conversation</h2>
      <div className="lead">How the agent's work and answers are laid out. Changes show straight away in every session.</div>
      <div className="settings-section">
        <div className="layout-pick">
          {LAYOUTS.map((l) => (
            <button key={l.id} className={cx('layout-opt', c.layout === l.id && 'on')} onClick={() => patch({ conversation: { layout: l.id } })}>
              <span className="lo-dot" />
              <span className="lo-text">
                <b>{l.label}</b>
                <span>{l.blurb}</span>
              </span>
            </button>
          ))}
        </div>
        <Row title="Spacing" desc="How tightly the conversation is packed.">
          {seg(c.spacing, [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['roomy', 'Roomy']], (v) => patch({ conversation: { spacing: v } }))}
        </Row>
        <Row
          title="Requests drawn at once"
          desc="A long conversation is only drawn from here down; a button above it brings back a hundred more at a time, and searching reaches all of it either way. Drawing more makes the panel slower to type in, because everything on the page is redrawn together."
        >
          {seg(
            String(c.drawn),
            [
              ['20', '20'],
              ['40', '40'],
              ['100', '100'],
              ['400', '400'],
              [String(Number.MAX_SAFE_INTEGER), 'All']
            ],
            (v) => patch({ conversation: { drawn: Number(v) } })
          )}
        </Row>
        <Row title="The agent's thinking" desc="Under each step, only when you open a step, or never.">
          {seg(c.thinking, [['always', 'Always'], ['opened', 'When opened'], ['never', 'Never']], (v) => patch({ conversation: { thinking: v } }))}
        </Row>
        <Row title="Times on messages" desc="When you sent each message, when each answer arrived, and how long the request took. Hover a time for the full date.">
          <Switch on={c.times} onChange={(v) => patch({ conversation: { times: v } })} />
        </Row>
        <Row title="Linked words" desc="Files, commands and &quot;tests pass&quot; in an answer are underlined; hover to see the step behind them, click to open it.">
          <Switch on={c.linkedWords} onChange={(v) => patch({ conversation: { linkedWords: v } })} />
        </Row>
        <Row title="What needs you goes under the answer" desc="Guesses to check, the proof and the reviewer's opinion, gathered in one place instead of among the steps.">
          <Switch on={c.needsUnder} onChange={(v) => patch({ conversation: { needsUnder: v } })} />
        </Row>
        <Row title="Don't repeat in the answer" desc="Ask the agent not to paste code it just changed or list its guesses again, since you see them beside the answer.">
          <Switch on={c.noRepeat} onChange={(v) => patch({ conversation: { noRepeat: v } })} />
        </Row>
        <Row title="Work pane" desc="Every step of one request, opened, in a panel of its own. Click a request in the conversation to show it there.">
          <button className="btn sm" onClick={() => useLayout.getState().openWork()}>
            Open the work pane
          </button>
        </Row>
      </div>
      <VoiceSettings />
    </>
  )
}

function VoiceSettings(): React.JSX.Element {
  const [settings, patch] = useSettingsPatch()
  const endpoints = useApp((s) => s.endpoints)
  const [kept, setKept] = useState<Array<{ repo: string; bytes: number }>>([])
  const refresh = (): void => void prism.voice.kept().then(setKept).catch(() => setKept([]))
  useEffect(refresh, [])
  if (!settings) return <></>
  const v = { ...VOICE_DEFAULT, ...settings.voice }
  const engines: Array<[typeof v.engine, string, string]> = [
    ['local', 'Inside Prism', 'Whisper runs on this computer. Downloads once, then works offline; nothing leaves the computer.'],
    ['provider', 'A provider', "Sends the recording to one of your providers' speech-to-text. Needs one that offers it; may cost per minute."],
    ...(prism.platform === 'win32' ? ([['windows', 'Windows dictation', "Opens Windows' own dictation (the same as Win+H), which types into the message box."]] as Array<[typeof v.engine, string, string]>) : [])
  ]
  return (
    <>
      <h3 className="settings-sub">Voice input</h3>
      <div className="settings-section">
        <div className="layout-pick">
          {engines.map(([id, label, blurb]) => (
            <button key={id} className={cx('layout-opt', v.engine === id && 'on')} onClick={() => patch({ voice: { engine: id } })}>
              <span className="lo-dot" />
              <span className="lo-text">
                <b>{label}</b>
                <span>{blurb}</span>
              </span>
            </button>
          ))}
        </div>
        {v.engine === 'local' && (
          <Row title="Speech model" desc={`Bigger understands more but is slower. ${LOCAL_MODELS.find((m) => m.id === v.localModel)?.label ?? ''}: ${LOCAL_MODELS.find((m) => m.id === v.localModel)?.size ?? ''} (less without a graphics card), once, the first time you speak; you see how far it has got next to the microphone.`}>
            <div className="seg">
              {LOCAL_MODELS.map((m) => (
                <button key={m.id} className={cx(v.localModel === m.id && 'on')} title={m.size} onClick={() => patch({ voice: { localModel: m.id } })}>
                  {m.label}
                </button>
              ))}
            </div>
          </Row>
        )}
        {v.engine === 'local' &&
          kept.map((k) => (
            <Row key={k.repo} title={`Kept: ${k.repo.split('/')[1]}`} desc={`${Math.round(k.bytes / 1e6)} MB on this computer.`}>
              <button className="btn sm ghost" onClick={() => void prism.voice.forget(k.repo).then(refresh).catch(toastError)}>
                Delete
              </button>
            </Row>
          ))}
        {v.engine === 'provider' && (
          <>
            <Row title="Provider" desc="Any OpenAI-compatible provider that offers speech-to-text (/audio/transcriptions).">
              <select className="input sm" value={v.endpointId} onChange={(e) => patch({ voice: { endpointId: e.target.value } })}>
                <option value="">Pick one…</option>
                {endpoints.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    {ep.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row title="Speech model" desc="Its name at that provider, for example whisper-1 or gpt-4o-mini-transcribe.">
              <input className="input sm" value={v.model} onChange={(e) => patch({ voice: { model: e.target.value } })} />
            </Row>
          </>
        )}
        {v.engine !== 'windows' && (
          <Row title="Language" desc='A code such as "en" or "fr". Leave it empty to have it worked out.'>
            <input className="input sm" style={{ width: 80 }} value={v.language} placeholder="auto" onChange={(e) => patch({ voice: { language: e.target.value.trim().toLowerCase() } })} />
          </Row>
        )}
      </div>
      <SpeechSettings />
      <FaceSettings />
    </>
  )
}

/** The face shown during a call. */
function FaceSettings(): React.JSX.Element {
  const [settings, patch] = useSettingsPatch()
  const [info, setInfo] = useState<FaceInfo | null | undefined>(undefined)
  const why = useFace((s) => (s.state === 'failed' ? s.why : ''))
  const f = settings?.face
  useEffect(() => {
    void prism.face.info().then(setInfo).catch(() => setInfo(null))
  }, [f?.path])
  if (!settings || !f) return <></>
  const which = why ? `The last call could not show it: ${why}` : info === undefined ? 'Looking…' : info ? (info.own ? info.name : 'The one that comes with Prism.') : 'There is no face file to show.'
  return (
    <>
      <h3 className="settings-sub">Face in calls</h3>
      <div className="settings-section">
        <Row title="Show a face" desc="Someone to look at while you talk. It blinks, looks at you while you speak, looks away while it thinks, and moves its mouth with the voice. In a call, tap it to make it bigger or smaller.">
          <Switch on={f.enabled} onChange={(v) => patch({ face: { enabled: v } })} />
        </Row>
        {f.enabled && (
          <Row title="Which face" desc={which}>
            <div className="row" style={{ gap: 6 }}>
              {info?.own && (
                <button className="btn sm ghost" onClick={() => patch({ face: { path: '' } })}>
                  Use the one that comes with Prism
                </button>
              )}
              {!window.__prismMobile && (
                <button className="btn sm" title="A VRM avatar, such as one exported from VRoid Studio" onClick={() => void prism.face.pick().then((i) => i && setInfo(i)).catch(toastError)}>
                  Choose a .vrm…
                </button>
              )}
            </div>
          </Row>
        )}
      </div>
    </>
  )
}

/** The voice Prism answers in, which is a different thing from how it hears you. */
function SpeechSettings(): React.JSX.Element {
  const [settings, patch] = useSettingsPatch()
  const [windows, setWindows] = useState<Array<{ name: string; culture: string; gender: string }>>([])
  const [better, setBetter] = useState<{ ok: boolean; why: string; path: string; voices: string[] } | null>(null)
  const sp = settings?.speech
  const look = (): void => {
    void prism.voice.voices().then(setWindows).catch(() => setWindows([]))
    void prism.voice.kokoro(sp?.kokoroPath ?? '').then(setBetter).catch(() => setBetter(null))
  }
  useEffect(look, [sp?.kokoroPath])
  if (!settings || !sp) return <></>
  if (prism.platform !== 'win32') return <></>

  const engines: Array<[typeof sp.engine, string, string]> = [
    ['windows', 'The computer’s own', 'Instant, and always there. Sounds like a computer.'],
    ['kokoro', 'A better voice', 'Sounds like a person. Takes about a second a sentence, which you only notice at the very start of an answer.']
  ]
  return (
    <>
      <h3 className="settings-sub">Voice output</h3>
      <div className="settings-section">
        <div className="layout-pick">
          {engines.map(([id, label, blurb]) => (
            <button key={id} className={cx('layout-opt', sp.engine === id && 'on')} onClick={() => patch({ speech: { engine: id } })}>
              <span className="lo-dot" />
              <span className="lo-text">
                <b>{label}</b>
                <span>{blurb}</span>
              </span>
            </button>
          ))}
        </div>
        {sp.engine === 'windows' && (
          <Row title="Voice" desc="The voices Windows has. Leave it on the first one to use whichever matches where you are.">
            <select className="input sm" value={sp.windowsVoice} onChange={(e) => patch({ speech: { windowsVoice: e.target.value } })}>
              <option value="">Pick for me</option>
              {windows.map((w) => (
                <option key={w.name} value={w.name}>
                  {w.name.replace(/^Microsoft | Desktop$/g, '')} ({w.culture})
                </option>
              ))}
            </select>
          </Row>
        )}
        {sp.engine === 'kokoro' && (
          <>
            <Row title="Where it is" desc={better?.ok ? 'Found at ' + better.path + '.' : (better?.why ?? 'Looking…')}>
              <input
                className="input sm"
                style={{ width: 220 }}
                value={sp.kokoroPath}
                placeholder={better?.path || 'Look for it'}
                onChange={(e) => patch({ speech: { kokoroPath: e.target.value.trim() } })}
              />
            </Row>
            {better?.ok && (
              <Row title="Voice" desc="The letters say where it sounds like it is from: bf is British, af American.">
                <select className="input sm" value={sp.kokoroVoice} onChange={(e) => patch({ speech: { kokoroVoice: e.target.value } })}>
                  {better.voices.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </Row>
            )}
            {better && !better.ok && (
              <Row title="Not set up" desc="It needs a folder with a Python that has kokoro-onnx in it, and the model files under models/. Until then it falls back to the computer’s own voice rather than going quiet.">
                <button className="btn sm ghost" onClick={look}>
                  Look again
                </button>
              </Row>
            )}
          </>
        )}
        <Row title="Try it" desc="Says a line out loud in the voice above.">
          <button
            className="btn sm"
            onClick={() => void import('@/lib/speech').then((m) => m.speak('This is the voice Prism will answer you in.')).catch(toastError)}
          >
            Say something
          </button>
        </Row>
      </div>
    </>
  )
}

function PhoneBox(): React.JSX.Element {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof prism.phone.info>> | null>(null)
  const [qr, setQr] = useState('')
  useEffect(() => {
    const get = (): void => void prism.phone.info().then(setInfo).catch(() => {})
    get()
    const t = setInterval(get, 3000)
    return () => clearInterval(t)
  }, [])
  const url = info?.urls[0] ?? ''
  useEffect(() => {
    if (url) void QRCode.toDataURL(url, { margin: 1, width: 168, color: { dark: '#0b0d13', light: '#ffffff' } }).then(setQr).catch(() => setQr(''))
  }, [url])
  if (!info) return <></>
  if (info.error) return <div className="phone-box">Could not start: {info.error}. Try another port in the settings file, or close what uses it.</div>
  return (
    <div className="phone-box">
      {qr && <img src={qr} alt="" width={120} height={120} />}
      <div className="grow">
        <div className="small">On your phone, open</div>
        {info.urls.map((u) => (
          <div key={u} className="mono">
            {u}
          </div>
        ))}
        {!info.urls.length && <div className="faint small">No network address found: is this computer on a network?</div>}
        <div className="small" style={{ marginTop: 8 }}>
          and type this code: <b className="mono phone-code">{info.code}</b>
        </div>
        <div className="faint xs" style={{ marginTop: 6 }}>
          {info.paired} phone{info.paired === 1 ? '' : 's'} paired.{' '}
          {info.paired > 0 && (
            <button className="link-btn" onClick={() => void prism.phone.forget()}>
              Unpair them all
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const PHONE_APP = true

function RemoteBox(): React.JSX.Element {
  const [info, setInfo] = useState<RemoteInfo | null>(null)
  const [qr, setQr] = useState('')
  useEffect(() => {
    const get = (): void => void prism.remote.info().then(setInfo).catch(() => {})
    get()
    const t = setInterval(get, 2000)
    return () => clearInterval(t)
  }, [])
  const offer = info?.pairing?.qr ?? ''
  useEffect(() => {
    if (offer) void QRCode.toDataURL(offer, { margin: 1, width: 220, errorCorrectionLevel: 'L', color: { dark: '#0b0d13', light: '#ffffff' } }).then(setQr).catch(() => setQr(''))
    else setQr('')
  }, [offer])
  if (!info) return <></>
  const left = info.pairing ? Math.max(0, Math.ceil((info.pairing.until - Date.now()) / 60_000)) : 0
  return (
    <div className="phone-box remote-box">
      {info.error && <div className="remote-err">Could not start: {info.error}. Try another port, or close what uses it.</div>}
      {info.pairing ? (
        <div className="remote-pair">
          {qr && <img src={qr} alt="" width={168} height={168} />}
          <div className="grow">
            <div className="small">In the Prism app on your phone, scan this code. Or tap "Type it in instead" and enter:</div>
            <div className="mono phone-code" style={{ margin: '6px 0' }}>
              {info.pairing.code}
            </div>
            {info.direct.map((u) => (
              <div key={u} className="mono xs">
                {u.replace(/^ws:\/\//, '')}
              </div>
            ))}
            {info.relay && <div className="mono xs">Prism id {info.hostId}</div>}
            <div className="faint xs" style={{ marginTop: 6 }}>
              Good for {left} more minute{left === 1 ? '' : 's'}, for one phone.
            </div>
          </div>
        </div>
      ) : (
        <button className="btn sm" onClick={() => void prism.remote.pair().then(setInfo).catch(toastError)}>
          Pair a phone
        </button>
      )}
      <div className="faint xs">
        This computer's key: <span className="mono">{info.fingerprint}</span>. The app shows the same when it connects.
      </div>
      {info.outside.state !== 'off' && (
        <div className="xs">
          Router:{' '}
          {info.outside.state === 'open' ? (
            <span style={{ color: 'var(--mint)' }}>
              open ({info.outside.how}), phones reach this computer at <span className="mono">{info.outside.external?.replace(/^ws:\/\//, '')}</span>
            </span>
          ) : info.outside.state === 'trying' ? (
            <span className="faint">asking the router…</span>
          ) : (
            <span style={{ color: 'var(--amber)' }}>{info.outside.error}</span>
          )}
        </div>
      )}
      {info.relay && (
        <div className="xs">
          Relay: {info.relay.connected ? <span style={{ color: 'var(--mint)' }}>connected</span> : <span style={{ color: 'var(--amber)' }}>{info.relay.error ?? 'connecting…'}</span>}
        </div>
      )}
      {info.devices.length > 0 && (
        <div className="remote-devices">
          {info.devices.map((d) => (
            <div key={d.pub} className="remote-device">
              <span className="grow">
                {d.name}
                <span className="faint xs"> · {d.lastSeen ? `last here ${new Date(d.lastSeen).toLocaleString()}` : 'not connected yet'}</span>
              </span>
              <button className="link-btn" onClick={() => void prism.remote.forget(d.pub).then(() => prism.remote.info().then(setInfo)).catch(toastError)}>
                Forget
              </button>
            </div>
          ))}
        </div>
      )}
      {info.connected > 0 && (
        <div className="xs" style={{ color: 'var(--mint)' }}>
          {info.connected} connected now
        </div>
      )}
    </div>
  )
}

function AssistSection(): React.JSX.Element {
  const [settings, patch] = useSettingsPatch()
  if (!settings) return <></>
  const a = settings.assist
  return (
    <>
      <h2>Helpers & extras</h2>
      <div className="lead">Things Prism does around the agent on its own. Each can be turned off.</div>
      <div className="settings-section">
        <Row title="Learn from my corrections" desc="When you correct the agent the same way more than once, offer to turn it into a skill or a rule.">
          <Switch on={a?.learn ?? true} onChange={(v) => patch({ assist: { learn: v } })} />
        </Row>
        <Row title="Check the spec" desc="After a turn changes files, check whether the project's SPEC.md still describes what the code does, and say so if not.">
          <Switch on={a?.specChecks ?? true} onChange={(v) => patch({ assist: { specChecks: v } })} />
        </Row>
        <Row title="Before and after pictures" desc="When a turn changes web files and a page is open in the Browser panel, show how the page looked before and after.">
          <Switch on={a?.pagePictures ?? true} onChange={(v) => patch({ assist: { pagePictures: v } })} />
        </Row>
        <Row title="While you were away" desc="When you come back to Prism after this many minutes, offer a summary of what the agents did meanwhile. 0 never offers it (it is still in the View menu).">
          <input className="input sm" type="number" min={0} max={1440} value={a?.catchUpAfterMin ?? 10} onChange={(e) => patch({ assist: { catchUpAfterMin: Math.max(0, Math.min(1440, Math.floor(Number(e.target.value) || 0))) } })} />
        </Row>
        <Row title="Agent map in the explorer" desc="Colour the files the agent read (blue) and changed (warm) in the current session.">
          <Switch on={a?.agentMap ?? true} onChange={(v) => patch({ assist: { agentMap: v } })} />
        </Row>
        <Row title="Desktop notifications" desc="When Prism is in the background: a turn finished, the agent needs your approval, or news arrived for a session.">
          <Switch on={a?.notifications ?? true} onChange={(v) => patch({ assist: { notifications: v } })} />
        </Row>
        <Row title="Control from your phone" desc="A page on your home network where a paired phone sees your sessions, approves, answers, sends messages and stops runs. Only phones that typed the pairing code can use it. Use it on networks you trust.">
          <Switch on={settings.phone?.enabled ?? false} onChange={(v) => patch({ phone: { enabled: v } })} />
        </Row>
        {settings.phone?.enabled && <PhoneBox />}
        {/* shown once the Android app ships */}
        {PHONE_APP && (
          <Row title="Prism phone app" desc="The Android app: the whole of Prism on your phone, working on this computer. Paired phones reach it on the same network, or from anywhere through a relay. Everything between them is encrypted end to end.">
          <Switch on={settings.remote?.enabled ?? false} onChange={(v) => patch({ remote: { enabled: v } })} />
          </Row>
        )}
        {PHONE_APP && settings.remote?.enabled && (
          <>
            <Row title="Port" desc="Where phones on the same network reach this computer.">
              <input className="input sm" type="number" min={1024} max={65535} value={settings.remote.port} onChange={(e) => patch({ remote: { port: Math.max(1024, Math.min(65535, Math.floor(Number(e.target.value) || 8793))) } })} />
            </Row>
            <Row title="Relay" desc="For reaching this computer away from home: the address of a Prism relay you run (see relay/README.md). The relay only passes sealed messages along and cannot read them. Leave empty for the same network only.">
              <input className="input sm" style={{ width: 260 }} value={settings.remote.relay} placeholder="wss://relay.example.com" onChange={(e) => patch({ remote: { relay: e.target.value.trim() } })} />
            </Row>
            <Row title="Open a port on my router" desc="Asks your home router to let phones reach this computer from anywhere, with no relay (UPnP or NAT-PMP). Many routers allow it; some have it switched off, and some internet providers share one address between customers, which no router can get around. Only paired phones can use the port, but anyone on the internet can see it is there.">
              <Switch on={settings.remote.upnp ?? false} onChange={(v) => patch({ remote: { upnp: v } })} />
            </Row>
            <RemoteBox />
          </>
        )}
        <Row title="Review every turn" desc="After a turn changes code, the Review model (or the Fast one) reads the change and lists real problems, or says it looks right. One more model call per turn.">
          <Switch on={a?.autoReview ?? false} onChange={(v) => patch({ assist: { autoReview: v } })} />
        </Row>
        <Row title="Pair mode" desc="When you save a file, the Fast model glances at what you changed and speaks up only about a likely bug. One small model call per save.">
          <Switch on={a?.pair ?? false} onChange={(v) => patch({ assist: { pair: v } })} />
        </Row>
        <Row title="Offer gadgets" desc="After a turn whose work has an ongoing or repeatable shape, the Fast model considers whether a small live panel would serve you and the agent better than more scrollback, and offers to build one. Turning down a kind of gadget silences that kind in this project.">
          <Switch on={a?.gadgetIdeas !== false} onChange={(v) => patch({ assist: { gadgetIdeas: v } })} />
        </Row>
        <RefusedGadgets />
      </div>
      <div className="settings-section">
        <h3>Recipes</h3>
        <div className="small faint" style={{ marginBottom: 8 }}>
          Requests you use again and again. Save one from any of your messages (right-click it), then pick it from Ctrl+Shift+P. Write {'{{'}like this{'}}'} where something changes each time: it is selected for you to type over, and Tab moves to the next.
        </div>
        {(settings.recipes ?? []).map((r) => (
          <div key={r.id} className="recipe-row">
            <input className="input sm" value={r.name} onChange={(e) => patch({ recipes: settings.recipes.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)) })} />
            <textarea className="input" rows={2} value={r.text} onChange={(e) => patch({ recipes: settings.recipes.map((x) => (x.id === r.id ? { ...x, text: e.target.value } : x)) })} />
            <button className="icon-btn sm" title="Delete" onClick={() => patch({ recipes: settings.recipes.filter((x) => x.id !== r.id) })}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <button className="btn sm ghost" onClick={() => patch({ recipes: [...(settings.recipes ?? []), { id: Math.random().toString(16).slice(2, 10), name: 'New recipe', text: 'Add tests for {{which part}} and make sure they pass.' }] })}>
          Add a recipe
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- files

function FilesSection(): React.JSX.Element {
  const [settings, patch] = useSettingsPatch()
  const [draft, setDraft] = useState('')
  if (!settings) return <></>
  const hidden = settings.files?.hidden ?? []
  const set = (list: string[]): void => patch({ files: { hidden: [...new Set(list.map((x) => x.trim()).filter(Boolean))] } })
  const add = (): void => {
    const names = draft.split(/[,\n]/).map((x) => x.trim().replace(/[\\/]+$/, '')).filter(Boolean)
    if (!names.length) return
    set([...hidden, ...names])
    setDraft('')
  }
  return (
    <>
      <h2>Files</h2>
      <div className="lead">Folders Prism skips, wherever they appear in a project: they are not searched, the agent's file listings pass over them, and changes inside them are not watched. They still show in the explorer, greyed out. Files your project's .gitignore leaves out are also left out of search.</div>
      <div className="settings-section">
        <h3>Folders to skip</h3>
        <div className="chip-list">
          {hidden.map((d) => (
            <span key={d} className="chip removable">
              <span className="mono">{d}</span>
              <button className="icon-btn sm" title={`Stop skipping ${d}`} onClick={() => set(hidden.filter((x) => x !== d))}>
                <Trash2 size={11} />
              </button>
            </span>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10, gap: 6 }}>
          <input className="input sm mono" style={{ width: 260 }} placeholder="folder name, e.g. .terraform" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="btn sm" onClick={add} disabled={!draft.trim()}>
            Skip it
          </button>
          <span className="grow" />
          <button className="btn sm ghost" title="Back to the folders Prism skips to begin with" onClick={() => void prism.settings.defaults().then((d) => set(d.files.hidden)).catch(toastError)}>
            Start over
          </button>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- appearance

// ---------------------------------------------------------------- mcp

function McpSection(): React.JSX.Element {
  const [settings, patch] = useSettingsPatch()
  const [statuses, setStatuses] = useState<McpStatus[]>([])
  const [form, setForm] = useState<{ name: string; command: string; args: string } | null>(null)
  const reload = (): void => {
    void prism.mcp.list().then(setStatuses).catch(() => {})
  }
  useEffect(reload, [settings?.mcp])
  if (!settings) return <></>
  const add = (): void => {
    if (!form || !form.name.trim() || !form.command.trim()) return
    const id = crypto.randomUUID()
    patch({ mcp: [...settings.mcp, { id, name: form.name.trim(), command: form.command.trim(), args: form.args.trim() ? form.args.trim().split(/\s+/) : [], env: {}, enabled: true }] })
    setForm(null)
    setTimeout(() => void prism.mcp.connect(id).then(reload), 200)
  }
  /** From the catalogue: tokens go to the vault first, so the server finds them when it starts. */
  const addReady = async (server: McpServerConfig, secrets: Record<string, string>): Promise<void> => {
    try {
      for (const [name, value] of Object.entries(secrets)) await prism.mcp.setSecret(server.id, name, value)
      // the newest list, not the one this render closed over, so adding two in a row keeps both;
      // and the server has to be saved before it can be connected by id
      const now = useApp.getState().settings?.mcp ?? []
      await useApp.getState().updateSettings({ mcp: [...now, server] })
      reload()
      await prism.mcp.connect(server.id)
    } catch (e) {
      toastError(e)
    } finally {
      reload()
    }
  }
  const remove = (s: McpStatus): void => {
    if (!window.confirm(`Remove ${s.name}?`)) return
    void prism.mcp.disconnect(s.id).catch(() => {})
    for (const name of s.secrets ?? []) void prism.mcp.setSecret(s.id, name, '').catch(() => {})
    patch({ mcp: settings.mcp.filter((m) => m.id !== s.id) })
  }
  return (
    <>
      <h2>MCP servers</h2>
      <div className="lead">Tool servers the agent can call: browsers, databases, Blender, anything that speaks MCP. Pick one from the list below or add your own.</div>
      <div className="settings-section">
        {statuses.map((s) => (
          <div key={s.id} className="card ep-card">
            <span className={cx('dot', s.state === 'connected' && 'live', s.state === 'error' && 'rose', s.state === 'connecting' && 'amber')} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ep-name">
                {s.name} <span className="faint small">{s.state === 'connected' ? `${s.toolCount} tools` : s.state}</span>
              </div>
              <div className="ep-url truncate">
                {s.command} {s.args.join(' ')}
              </div>
              {s.state === 'connecting' && <div className="faint xs">Starting. The first time, the server is downloaded, which can take a minute.</div>}
              {s.error && <div className="rose xs selectable" style={{ whiteSpace: 'pre-wrap' }}>{s.error}</div>}
              {s.state === 'connected' && s.tools.length > 0 && (
                <div className="faint xs truncate" title={s.tools.map((t) => t.name).join(', ')}>
                  {s.tools.slice(0, 8).map((t) => t.name).join(' · ')}
                  {s.tools.length > 8 ? ` · +${s.tools.length - 8}` : ''}
                </div>
              )}
            </div>
            <Switch on={s.enabled} onChange={(v) => patch({ mcp: settings.mcp.map((m) => (m.id === s.id ? { ...m, enabled: v } : m)) })} />
            {s.state === 'connected' ? (
              <button className="btn sm ghost" onClick={() => void prism.mcp.disconnect(s.id).then(reload)}>Disconnect</button>
            ) : (
              <button className="btn sm" onClick={() => void prism.mcp.connect(s.id).then(reload)}>Connect</button>
            )}
            <button className="icon-btn" title="Remove" onClick={() => remove(s)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {statuses.length === 0 && <div className="faint small">No servers yet.</div>}
      </div>
      <div className="settings-section">
        {form ? (
          <div className="card" style={{ padding: 12 }}>
            <div className="form-grid">
              <label className="field">
                <span>Name</span>
                <input className="input" value={form.name} placeholder="blender" onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
              </label>
              <label className="field">
                <span>Command</span>
                <input className="input mono" value={form.command} placeholder="uvx or C:\\path\\server.exe" onChange={(e) => setForm({ ...form, command: e.target.value })} />
              </label>
              <label className="field span2">
                <span>Arguments</span>
                <input className="input mono" value={form.args} placeholder="blender-mcp" onChange={(e) => setForm({ ...form, args: e.target.value })} />
              </label>
            </div>
            <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
              <button className="btn ghost sm" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn solid sm" onClick={add}>Add & connect</button>
            </div>
          </div>
        ) : (
          <button className="btn" onClick={() => setForm({ name: '', command: '', args: '' })}>
            Add your own server
          </button>
        )}
      </div>
      <div className="settings-section">
        <h3>Ready to add</h3>
        <McpCatalog servers={settings.mcp} onAdd={(server, secrets) => void addReady(server, secrets)} />
      </div>
    </>
  )
}

/** Kinds of gadget turned down for good in this project, and the way back. */
function RefusedGadgets(): React.JSX.Element | null {
  const [kinds, setKinds] = useState<string[]>([])
  useEffect(() => {
    void prism.gadgets.refusedIdeas().then(setKinds).catch(() => {})
  }, [])
  if (!kinds.length) return null
  return (
    <div className="small faint" style={{ margin: '2px 0 8px' }}>
      Not offered here:{' '}
      {kinds.map((k) => (
        <button
          key={k}
          className="linkish xs"
          style={{ marginRight: 8 }}
          title="Let it be offered again"
          onClick={() => void prism.gadgets.allowIdea(k).then(() => setKinds((list) => list.filter((x) => x !== k)))}
        >
          {k} ×
        </button>
      ))}
    </div>
  )
}
