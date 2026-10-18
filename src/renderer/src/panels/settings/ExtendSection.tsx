import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Eye, FolderOpen, Globe, Pencil, Plus, ShieldCheck, Terminal, Trash2, Wrench } from 'lucide-react'
import type { CustomToolInfo, ExtendState, SkillInfo } from '@shared/types'
import { prism } from '@/lib/ipc'
import { setupMonaco, monaco } from '@/lib/monaco'
import { currentTheme, fontStack } from '@/theme/apply'
import { useApp } from '@/state/app'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { toastError, useUi } from '@/state/ui'
import { Modal } from '@/components/Modal'
import { RulesSection } from './RulesSection'

type Kind = 'skill' | 'tool'
type Scope = 'project' | 'personal'
interface Editing {
  kind: Kind
  path: string
  scope: Scope
  title: string
}

const fileName = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p
const where = (scope: Scope | 'builtin'): string => (scope === 'project' ? 'This project' : scope === 'personal' ? 'All my projects' : 'Comes with Prism')

/** A skill or tool file, edited in place. */
function FileEditor({ file, onClose }: { file: Editing; onClose: (saved: boolean) => void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [dirty, setDirty] = useState(false)
  const [ready, setReady] = useState(false)
  const saved = useRef(false)

  const save = useCallback(async (): Promise<boolean> => {
    const e = editor.current
    if (!e) return false
    try {
      await prism.extend.write(file.kind, file.path, file.scope, e.getValue())
      setDirty(false)
      saved.current = true
      return true
    } catch (err) {
      toastError(err)
      return false
    }
  }, [file])

  useEffect(() => {
    let gone = false
    let model: monaco.editor.ITextModel | null = null
    void prism.extend
      .read(file.kind, file.path, file.scope)
      .then((content) => {
        if (gone || !host.current) return
        const m = setupMonaco()
        model = m.editor.createModel(content, file.kind === 'skill' ? 'markdown' : 'typescript', m.Uri.parse(`inmemory://extend/${Date.now()}-${fileName(file.path)}`))
        const e = m.editor.create(host.current, {
          model,
          theme: 'prism',
          automaticLayout: true,
          fontFamily: fontStack(currentTheme().look.fontMono, true),
          fontSize: useApp.getState().settings?.editor.fontSize ?? 13,
          lineHeight: 20,
          minimap: { enabled: false },
          lineNumbers: file.kind === 'tool' ? 'on' : 'off',
          lineNumbersMinChars: 3,
          glyphMargin: false,
          folding: false,
          renderLineHighlight: 'none',
          scrollBeyondLastLine: false,
          overviewRulerLanes: 0,
          padding: { top: 10, bottom: 10 },
          tabSize: 2,
          wordWrap: 'on'
        })
        e.onDidChangeModelContent(() => setDirty(true))
        e.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => void save())
        editor.current = e
        setReady(true)
        e.focus()
      })
      .catch((err) => {
        toastError(err)
        onClose(false)
      })
    return () => {
      gone = true
      editor.current?.dispose()
      editor.current = null
      model?.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, file.scope, file.kind])

  const close = (): void => {
    if (dirty && !window.confirm('Close without saving your changes?')) return
    onClose(saved.current)
  }

  return (
    <Modal
      title={file.title}
      icon={file.kind === 'skill' ? <BookOpen size={15} /> : <Wrench size={15} />}
      onClose={close}
      width={860}
      footer={
        <>
          <span className="faint small grow">{file.kind === 'skill' ? 'The words after "when:" decide when the agent gets these instructions.' : 'Saved tools are ready from the next message you send.'}</span>
          <button className="btn ghost sm" onClick={close}>
            Close
          </button>
          <button className="btn solid sm" disabled={!ready || !dirty} onClick={() => void save().then((ok) => ok && onClose(true))}>
            Save
          </button>
        </>
      }
    >
      <div ref={host} className="extend-editor" />
    </Modal>
  )
}

export function ExtendSection(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const [state, setState] = useState<ExtendState | null>(null)
  const [form, setForm] = useState<{ kind: Kind; name: string; scope: Scope } | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)

  const reload = useCallback((): void => {
    void prism.extend.list().then(setState).catch(toastError)
  }, [])
  useEffect(() => {
    reload()
    return prism.extend.onChanged(reload)
  }, [reload, workspace])

  const create = async (): Promise<void> => {
    if (!form || !form.name.trim()) return
    try {
      const path = await prism.extend.create(form.kind, form.name, form.scope)
      setForm(null)
      reload()
      setEditing({ kind: form.kind, path, scope: form.scope, title: fileName(path) })
    } catch (e) {
      toastError(e)
    }
  }

  const remove = async (kind: Kind, path: string, scope: Scope, label: string): Promise<void> => {
    if (!window.confirm(`Delete the ${kind} "${label}"? The file is removed.`)) return
    try {
      await prism.extend.remove(kind, path, scope)
      reload()
    } catch (e) {
      toastError(e)
    }
  }

  const newForm = (kind: Kind): React.JSX.Element | null =>
    form?.kind === kind ? (
      <div className="card" style={{ padding: 12 }}>
        <div className="form-grid">
          <label className="field">
            <span>Name</span>
            <input
              className="input"
              value={form.name}
              placeholder={kind === 'skill' ? 'release-notes' : 'count_lines'}
              autoFocus
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
            />
          </label>
          <label className="field">
            <span>Available in</span>
            <div className="seg" style={{ alignSelf: 'flex-start' }}>
              <button className={form.scope === 'project' ? 'on' : ''} disabled={!workspace} onClick={() => setForm({ ...form, scope: 'project' })}>
                This project
              </button>
              <button className={form.scope === 'personal' ? 'on' : ''} onClick={() => setForm({ ...form, scope: 'personal' })}>
                All my projects
              </button>
            </div>
          </label>
        </div>
        <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
          <button className="btn ghost sm" onClick={() => setForm(null)}>
            Cancel
          </button>
          <button className="btn solid sm" disabled={form.name.trim().length < 2} onClick={() => void create()}>
            Create and edit
          </button>
        </div>
      </div>
    ) : null

  const actions = (kind: Kind, path: string, scope: Scope, label: string): React.JSX.Element => (
    <>
      <button className="icon-btn" title="Edit" onClick={() => setEditing({ kind, path, scope, title: fileName(path) })}>
        <Pencil size={14} />
      </button>
      <button className="icon-btn" title="Delete" onClick={() => void remove(kind, path, scope, label)}>
        <Trash2 size={14} />
      </button>
    </>
  )

  const skill = (s: SkillInfo): React.JSX.Element => (
    <div key={`${s.scope}:${s.path}`} className="card ep-card">
      <BookOpen size={16} className="extend-icon" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ep-name">
          {s.name} <span className="faint small">{where(s.scope)}</span>
        </div>
        <div className="small" style={{ color: 'var(--text-2)' }}>{s.description}</div>
        <div className="extend-chips">
          {s.scope === 'builtin' ? (
            <span className="chip">Joins when you ask for a new skill or tool</span>
          ) : s.always ? (
            <span className="chip mint">In every session</span>
          ) : s.when.length ? (
            <>
              {s.when.slice(0, 8).map((w) => (
                <span key={w} className="chip">
                  {w}
                </span>
              ))}
              {s.when.length > 8 && <span className="faint xs">+{s.when.length - 8} more</span>}
            </>
          ) : (
            <span className="chip amber" title='Add a "when:" line to the file to have it load by itself'>
              Only when the agent asks for it
            </span>
          )}
        </div>
      </div>
      {s.scope !== 'builtin' && actions('skill', s.path, s.scope, s.name)}
    </div>
  )

  const allow = async (t: CustomToolInfo): Promise<void> => {
    try {
      await prism.extend.allow(t.file, t.scope)
      reload()
    } catch (e) {
      toastError(e)
    }
  }

  /** A tool file the agent may not use yet: it has to be looked at first. */
  const waiting = (t: CustomToolInfo): React.JSX.Element => (
    <div key={`${t.scope}:${t.file}`} className="card ep-card extend-waiting">
      <ShieldCheck size={16} className="extend-icon" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ep-name">
          {fileName(t.file)} <span className="faint small">{where(t.scope)}</span>
        </div>
        <div className="small" style={{ color: 'var(--text-2)' }}>
          {t.waiting === 'changed' ? 'This tool has changed since you allowed it.' : 'This tool was not made here in Settings.'} The agent cannot use it until you have looked at it and allowed it.
        </div>
      </div>
      <button className="btn sm" onClick={() => setEditing({ kind: 'tool', path: t.file, scope: t.scope, title: fileName(t.file) })}>
        <Eye size={12} /> Look
      </button>
      <button className="btn sm solid" onClick={() => void allow(t)}>
        Allow
      </button>
      <button className="icon-btn" title="Delete" onClick={() => void remove('tool', t.file, t.scope, fileName(t.file))}>
        <Trash2 size={14} />
      </button>
    </div>
  )

  const tool = (t: CustomToolInfo): React.JSX.Element => (
    <div key={`${t.scope}:${t.file}`} className="card ep-card">
      <Wrench size={16} className="extend-icon" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ep-name">
          {t.name || fileName(t.file)} <span className="faint small">{where(t.scope)}</span>
        </div>
        {t.description && <div className="small" style={{ color: 'var(--text-2)' }}>{t.description}</div>}
        {t.error ? (
          <div className="rose xs selectable" style={{ whiteSpace: 'pre-wrap' }}>
            The agent cannot use this one. {t.name ? '' : 'The file has a mistake: '}
            {t.error}
            {!t.name && (
              <button
                className="btn sm"
                style={{ marginLeft: 8 }}
                onClick={() =>
                  void prism.extend
                    .repair(t.file, t.scope, t.error ?? '')
                    .then((id) => {
                      if (!id) return
                      useLayout.getState().openAgent()
                      void useSessions.getState().select(id)
                    })
                    .catch(toastError)
                }
              >
                Fix it
              </button>
            )}
          </div>
        ) : (
          <div className="extend-chips">
            <span className="chip">Project files</span>
            {t.uses.includes('shell') && (
              <span className="chip amber">
                <Terminal size={11} /> Runs commands
              </span>
            )}
            {t.uses.includes('network') && (
              <span className="chip violet">
                <Globe size={11} /> Uses the internet
              </span>
            )}
            {t.risk === 'none' && <span className="chip mint">Never asks first</span>}
          </div>
        )}
      </div>
      {actions('tool', t.file, t.scope, t.name || fileName(t.file))}
    </div>
  )

  return (
    <>
      <h2>Skills, tools & rules</h2>
      <div className="lead">Teach the agent how things are done here, and give it abilities of your own making.</div>

      <div className="settings-section">
        <div className="theme-bar">
          <h3>Skills</h3>
          <span className="grow" />
          <button className="btn sm ghost" onClick={() => void prism.extend.openFolder('skill').catch(toastError)} title="The folder of skills that work in every project">
            <FolderOpen size={12} /> My skills folder
          </button>
          <button className="btn sm" onClick={() => setForm({ kind: 'skill', name: '', scope: workspace ? 'project' : 'personal' })}>
            <Plus size={12} /> New skill
          </button>
        </div>
        <div className="extend-note">
          A skill is a page of instructions: how releases are done, how tests are written, what a good commit looks like. It joins the conversation by itself when your message contains one of its words, and the agent can fetch one when it sees the need. The rest of the time it stays out of the way.
        </div>
        {newForm('skill')}
        {state && [...state.skills].sort((a, b) => Number(a.scope === 'builtin') - Number(b.scope === 'builtin')).map(skill)}
      </div>

      <div className="settings-section">
        <div className="theme-bar">
          <h3>Your own tools</h3>
          <span className="grow" />
          <button className="btn sm ghost" onClick={() => void prism.extend.openFolder('tool').catch(toastError)} title="The folder of tools that work in every project">
            <FolderOpen size={12} /> My tools folder
          </button>
          <button className="btn sm" onClick={() => setForm({ kind: 'tool', name: '', scope: workspace ? 'project' : 'personal' })}>
            <Plus size={12} /> New tool
          </button>
        </div>
        <div className="extend-note">
          A tool is a small TypeScript file that gives the agent a new ability. It runs shut off from the rest of the computer: it can read and write this project's files and nothing else, and it can run commands or reach the internet only if its file says so, which shows here.
        </div>
        {newForm('tool')}
        {state?.tools.map((t) => (t.waiting ? waiting(t) : tool(t)))}
        {state && state.tools.length === 0 && !form && <div className="faint small">No tools yet.</div>}
      </div>

      <RulesSection />

      {editing && (
        <FileEditor
          file={editing}
          onClose={(saved) => {
            setEditing(null)
            reload()
            if (saved && editing.kind === 'tool') useUi.getState().toast('success', 'Tools reloaded', 'The agent has the new version from your next message.')
          }}
        />
      )}
    </>
  )
}
