import { useEffect, useState } from 'react'
import { CircleAlert, GitBranch, Glasses, Wand2, Lock, Map as MapIcon, ShieldCheck, Sparkles, TriangleAlert, Unlock } from 'lucide-react'
import type { GitStatus } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp, modelLabel } from '@/state/app'
import { useSessions } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { useEditor } from '@/state/editor'
import { useRefactor } from '@/state/refactor'
import { useUi } from '@/state/ui'
import { humanCost, humanTokens } from '@/lib/format'
import { useProblems, allProblems } from '@/state/problems'

export function StatusBar(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const info = useApp((s) => s.info)
  const models = useApp((s) => s.models)
  const active = useSessions((s) => s.active)
  const session = useSessions((s) => s.sessions.find((x) => x.id === s.active))
  const live = useSessions((s) => (s.active ? s.live[s.active] : undefined))
  const openUsage = useLayout((s) => s.openUsage)
  const setSide = useUi((s) => s.setSide)
  const [git, setGit] = useState<GitStatus | null>(null)
  const suggestion = useEditor((s) => s.suggestion)
  const pairNote = useEditor((s) => s.pairNote)
  const pEditor = useProblems((s) => s.editor)
  const pResults = useProblems((s) => s.results)
  const problems = allProblems({ editor: pEditor, results: pResults })
  const nErr = problems.filter((p) => p.severity === 'error').length
  const nWarn = problems.filter((p) => p.severity === 'warning').length

  useEffect(() => {
    if (!workspace) {
      setGit(null)
      return
    }
    let alive = true
    const tick = (): void => {
      void prism.git.status().then((g) => alive && setGit(g)).catch(() => {})
    }
    tick()
    const t = setInterval(tick, 6000)
    const off = prism.fs.onChanged(() => tick())
    return () => {
      alive = false
      clearInterval(t)
      off()
    }
  }, [workspace])

  const ctx = live?.contextTokens ?? 0
  const win = live?.contextWindow ?? null
  const pct = win ? Math.min(100, Math.round((ctx / win) * 100)) : 0
  const changed = git?.files.length ?? 0

  return (
    <footer className="statusbar">
      {git?.isRepo && (
        <button className="sb-item clickable" onClick={() => setSide('git')} title="Source control">
          <GitBranch size={12} />
          {git.branch ?? 'detached'}
          {changed > 0 && <span className="amber">· {changed}</span>}
          {git.ahead > 0 && <span className="faint">↑{git.ahead}</span>}
          {git.behind > 0 && <span className="faint">↓{git.behind}</span>}
        </button>
      )}
      <button className="sb-item clickable" onClick={() => useLayout.getState().openProblems()} title="Problems">
        <CircleAlert size={12} className={nErr ? 'rose' : undefined} />
        {nErr}
        <TriangleAlert size={12} className={nWarn ? 'amber' : undefined} />
        {nWarn}
      </button>
      <span className="sb-item">
        <span className={`dot ${live?.running ? 'live' : ''}`} />
        {live?.running ? (live.status ?? 'working') : active ? 'idle' : 'no session'}
      </span>
      {suggestion && (
        <button
          className="sb-item clickable sb-suggest"
          title={suggestion.plan.note ?? undefined}
          onClick={() => {
            const plan = useEditor.getState().takeSuggestion()
            if (plan) useRefactor.getState().show(plan)
          }}
        >
          <Wand2 size={12} /> {suggestion.plan.title}
        </button>
      )}
      {pairNote && (
        <span className="sb-item sb-pair" title={`${pairNote.path}: ${pairNote.text}`}>
          <Glasses size={12} />
          <button
            className="clickable"
            onClick={() => {
              useLayout.getState().openEditor(pairNote.path)
              useLayout.getState().openAgent()
              const st = useSessions.getState()
              const draft = `In ${pairNote.path}, about the change I just saved: ${pairNote.text} Check it and fix it if it is a real bug.`
              if (st.active) st.setDraft(st.active, draft)
              useEditor.getState().dismissPairNote()
            }}
          >
            {pairNote.text.length > 70 ? `${pairNote.text.slice(0, 70)}…` : pairNote.text}
          </button>
          <button className="bg-x" title="Dismiss" onClick={() => useEditor.getState().dismissPairNote()}>
            ×
          </button>
        </span>
      )}
      <span className="sb-spacer" />
      {session && (
        <button className="sb-item clickable" data-demo="status:usage" onClick={openUsage} title="Session tokens and cost. Click for usage.">
          <Sparkles size={12} />
          {modelLabel(models, session.model)}
          <span className="faint">
            · {humanTokens(session.inputTokens)}↑ {humanTokens(session.outputTokens)}↓ · {humanCost(session.cost)}
          </span>
        </button>
      )}
      {win !== null && (
        <button className="sb-item clickable" onClick={() => useLayout.getState().openContext()} title={`Context: ${humanTokens(ctx)} of ${humanTokens(win)} tokens. Click to see what is in it.`}>
          <span className={`meter ${pct > 85 ? 'hot' : pct > 65 ? 'warn' : ''}`}>
            <i style={{ width: `${pct}%` }} />
          </span>
          {pct}%
        </button>
      )}
      {session && (
        <span className="sb-item" title="Permission mode">
          {session.mode === 'auto' ? <Unlock size={12} className="amber" /> : session.mode === 'auto-edit' ? <ShieldCheck size={12} className="accent" /> : session.mode === 'plan' ? <MapIcon size={12} className="accent" /> : <Lock size={12} />}
          {session.mode === 'auto' ? 'full auto' : session.mode === 'auto-edit' ? 'edit freely' : session.mode === 'plan' ? 'plan first' : 'ask first'}
        </span>
      )}
      <span className="sb-item" title={info?.encryptionAvailable ? 'API keys are encrypted with the OS keychain' : 'API keys are stored without OS encryption'}>
        {info?.encryptionAvailable ? 'vault' : 'vault (plain)'}
      </span>
    </footer>
  )
}
