import { Accessibility, Activity, Check, Cpu, Database, Dumbbell, Gauge, Palette, Puzzle, Rocket, Scale, Server, ShieldCheck, Smartphone, Ticket, Wrench, type LucideIcon } from 'lucide-react'
import type { GadgetInfo } from '@shared/ipc'

const ICONS: Record<string, LucideIcon> = { smartphone: Smartphone, rocket: Rocket, server: Server, shield: ShieldCheck, wrench: Wrench, palette: Palette, database: Database, gauge: Gauge, cpu: Cpu, dumbbell: Dumbbell, ticket: Ticket, activity: Activity, accessibility: Accessibility, scale: Scale }

/**
 * The first time a gadget that comes with Prism is opened in a project: what it is, how
 * it helps and an everyday example, and the choice to turn it on. Nothing of it runs
 * before the user says yes.
 */
export function GadgetIntro({ info, onTurnOn, onLater }: { info: GadgetInfo; onTurnOn: () => void; onLater: () => void }): React.JSX.Element {
  const intro = info.intro!
  const Icon = ICONS[intro.icon ?? ''] ?? Puzzle
  const colour = intro.colour ?? '#f6c7d4'
  return (
    <div className="gadget-intro" style={{ ['--gi' as string]: colour }}>
      <div className="gi-card">
        <div className="gi-icon">
          <Icon size={30} strokeWidth={1.8} />
        </div>
        <div className="gi-name">{info.name}</div>
        <div className="gi-tagline">{intro.tagline}</div>
        <div className="gi-section">
          <div className="gi-label">What it is</div>
          <p>{intro.what}</p>
        </div>
        {intro.helps.length > 0 && (
          <div className="gi-section">
            <div className="gi-label">How it helps you</div>
            <ul>
              {intro.helps.map((h) => (
                <li key={h}>
                  <Check size={14} className="gi-tick" />
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="gi-example">
          <div className="gi-label">For example</div>
          <p>{intro.example}</p>
        </div>
        <div className="gi-actions">
          <button className="btn solid gi-on" onClick={onTurnOn}>
            Turn it on
          </button>
          <button className="btn ghost" onClick={onLater}>
            Not now
          </button>
        </div>
        <div className="gi-small">It is turned on for this project only, and nothing of it runs until you do.</div>
      </div>
    </div>
  )
}
