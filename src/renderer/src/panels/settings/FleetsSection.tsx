import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { Fleet, FleetMember, ModelRef } from '@shared/types'
import { useApp, isClaude, modelKey, refFromKey } from '@/state/app'
import { toastError } from '@/state/ui'
import { cx } from '@/lib/format'

/**
 * Fleets: saved teams of helpers, each on its own model with its own instructions. Either
 * agent runs one by name (fleet_run); Claude only when "Let Claude use Prism's other models
 * as helpers" is on. Kept in Prism's settings, so every project has them.
 */
export function FleetsSection(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const models = useApp((s) => s.models)
  const fleets = settings?.fleets ?? []
  const [open, setOpen] = useState<number | null>(null)

  // every model from every provider; a Claude member runs through Claude Code, the rest through Prism's agent
  const usable = models
  const firstModel: ModelRef | null = usable[0] ? { endpointId: usable[0].endpointId, modelId: usable[0].modelId } : null
  const nameOf = (m: (typeof models)[number]): string => `${m.label ?? m.modelId} · ${isClaude({ endpointId: m.endpointId }) ? 'Claude' : m.endpointName}`

  const save = (next: Fleet[]): void => void update({ fleets: next }).catch(toastError)
  const change = (i: number, f: Fleet): void => save(fleets.map((x, j) => (j === i ? f : x)))

  const add = (): void => {
    if (!firstModel) return
    const n = fleets.length + 1
    save([...fleets, { name: `fleet-${n}`, description: '', members: [{ name: 'researcher', model: firstModel, persona: '', canEdit: false }], combine: null }])
    setOpen(fleets.length)
  }

  const modelPicker = (value: ModelRef, onChange: (m: ModelRef) => void, label: string): React.JSX.Element => (
    <select className="input sm" aria-label={label} value={modelKey(value)} onChange={(e) => { const r = refFromKey(e.target.value); if (r) onChange(r) }}>
      {!usable.some((m) => modelKey({ endpointId: m.endpointId, modelId: m.modelId }) === modelKey(value)) && <option value={modelKey(value)}>{value.modelId} (not available now)</option>}
      {usable.map((m) => (
        <option key={modelKey({ endpointId: m.endpointId, modelId: m.modelId })} value={modelKey({ endpointId: m.endpointId, modelId: m.modelId })}>
          {nameOf(m)}
        </option>
      ))}
    </select>
  )

  return (
    <>
      <h2>Fleets</h2>
      <div className="lead">
        Teams of helpers, each on its own model with its own instructions. Ask the agent to “run the reviewers fleet on this” and every member works on it at once; one more can then write a single answer from all their reports. Claude can use them when “Let Claude use Prism’s other models as helpers” is on (Settings, Claude Agent).
      </div>

      {!firstModel && <div className="settings-section faint">Add a model under Providers, or turn on Claude Agent, first.</div>}

      {fleets.map((f, i) => (
        <div key={i} className="settings-section fleet-card">
          <div className="fleet-head" onClick={() => setOpen(open === i ? null : i)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(open === i ? null : i) }}>
            <b>{f.name}</b>
            <span className="faint small truncate grow">{f.description || `${f.members.length} member${f.members.length === 1 ? '' : 's'}`}</span>
            <span className="faint small">{f.members.map((m) => m.model.modelId).join(', ')}{f.combine ? ` → ${f.combine.model.modelId}` : ''}</span>
          </div>
          {open === i && (
            <div className="fleet-body">
              <label className="fleet-field">
                <span>Name (what you call it: “run the {f.name || '…'} fleet”)</span>
                <input className="input" value={f.name} onChange={(e) => change(i, { ...f, name: e.target.value.replace(/\s+/g, '-').toLowerCase() })} />
              </label>
              <label className="fleet-field">
                <span>What it’s for</span>
                <input className="input" value={f.description} placeholder="Reviews a change from three angles" onChange={(e) => change(i, { ...f, description: e.target.value })} />
              </label>

              <h3>Members</h3>
              {f.members.map((m, k) => {
                const setM = (next: Partial<FleetMember>): void => change(i, { ...f, members: f.members.map((x, j) => (j === k ? { ...x, ...next } : x)) })
                return (
                  <div key={k} className="fleet-member">
                    <div className="fleet-row">
                      <input className="input sm" aria-label="Member name" value={m.name} onChange={(e) => setM({ name: e.target.value })} />
                      {modelPicker(m.model, (model) => setM({ model }), `${m.name}'s model`)}
                      <label className="faint small fleet-check">
                        <input type="checkbox" checked={m.canEdit} onChange={(e) => setM({ canEdit: e.target.checked })} /> may change files
                      </label>
                      <button className="icon-btn sm" title="Remove this member" aria-label={`Remove ${m.name}`} onClick={() => change(i, { ...f, members: f.members.filter((_, j) => j !== k) })}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <textarea className="input" rows={2} aria-label={`${m.name}'s instructions`} placeholder="Who it is and how it works: “You are a security reviewer. Look only for ways this could be abused.”" value={m.persona} onChange={(e) => setM({ persona: e.target.value })} />
                  </div>
                )
              })}
              <div>
                <button className="btn sm" disabled={!firstModel} onClick={() => firstModel && change(i, { ...f, members: [...f.members, { name: `member-${f.members.length + 1}`, model: firstModel, persona: '', canEdit: false }] })}>
                  <Plus size={13} /> Add a member
                </button>
              </div>

              <h3>One answer at the end</h3>
              <label className="faint small fleet-check">
                <input type="checkbox" checked={!!f.combine} onChange={(e) => change(i, { ...f, combine: e.target.checked && firstModel ? { model: firstModel, persona: '' } : null })} /> A last helper reads every report and writes one answer
              </label>
              {f.combine && (
                <div className="fleet-member">
                  <div className="fleet-row">{modelPicker(f.combine.model, (model) => change(i, { ...f, combine: { ...f.combine!, model } }), 'Combiner model')}</div>
                  <textarea className="input" rows={2} aria-label="Combiner instructions" placeholder="Leave empty for: where they agree, where they differ, and what you would do." value={f.combine.persona} onChange={(e) => change(i, { ...f, combine: { ...f.combine!, persona: e.target.value } })} />
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                <button className={cx('btn sm', 'danger')} onClick={() => { save(fleets.filter((_, j) => j !== i)); setOpen(null) }}>
                  <Trash2 size={13} /> Delete this fleet
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      <div className="settings-section">
        <button className="btn primary" disabled={!firstModel} onClick={add}>
          <Plus size={14} /> New fleet
        </button>
      </div>
    </>
  )
}
