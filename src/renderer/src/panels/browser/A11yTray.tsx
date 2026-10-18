import { useEffect, useState } from 'react'
import { RotateCw, Wrench, X } from 'lucide-react'
import { reportText, type A11yFinding, type A11yReport } from '@shared/a11y'
import { prism } from '@/lib/ipc'
import { cx } from '@/lib/format'

const WEIGHT: Record<A11yFinding['impact'], string> = { critical: 'shuts people out', serious: 'makes it hard', moderate: 'gets in the way', minor: 'small' }

/**
 * The page's accessibility problems, under the page like the console. Clicking one
 * points at where it is on the page; "Fix with Prism" hands the whole list, with a
 * picture of where each one is, to the agent.
 */
export function A11yTray({ url, onFix, onClose }: { url: string; onFix: (text: string, image: { mime: string; base64: string } | null) => void; onClose: () => void }): React.JSX.Element {
  const [result, setResult] = useState<{ report: A11yReport; image: { mime: string; base64: string } | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    setTrouble(null)
    try {
      setResult(await prism.preview.audit())
    } catch (e) {
      setTrouble(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    } finally {
      setBusy(false)
    }
  }

  // a new page is a new check
  useEffect(() => {
    void run()
  }, [url])

  const findings = result?.report.findings ?? []
  return (
    <div className="browser-console a11y-tray">
      <div className="browser-console-bar">
        <span className="hud-label">Accessibility</span>
        <span className="faint xs">
          {busy ? 'Checking…' : trouble ? trouble : result ? (findings.length ? `${findings.length} kind${findings.length === 1 ? '' : 's'} of problem · ${result.report.passed} checks passed` : `No problems found · ${result.report.passed} checks passed`) : ''}
        </span>
        <span className="grow" />
        <button className="icon-btn sm" title="Check again" disabled={busy} onClick={() => void run()}>
          <RotateCw size={13} />
        </button>
        <button className="btn sm primary" disabled={!findings.length || busy} onClick={() => result && onFix(reportText(result.report), result.image)} title="Put the problems, and a picture of where they are, in the message box">
          <Wrench size={12} /> Fix with Prism
        </button>
        <button className="icon-btn sm" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="browser-console-body a11y-body">
        {result && !findings.length && !busy && <div className="faint small a11y-none">Automatic checks catch about half of what people meet. Try the page with the keyboard alone, and with a screen reader, too.</div>}
        {findings.map((f) => (
          <div key={f.id} className={cx('a11y-row', open === f.id && 'open')}>
            <button
              className="a11y-head"
              title="Show where on the page"
              onClick={() => {
                setOpen(open === f.id ? null : f.id)
                void prism.preview.highlight(f.nodes.map((n) => n.target))
              }}
            >
              <span className={cx('a11y-impact', f.impact)}>{WEIGHT[f.impact]}</span>
              <span className="a11y-what">{f.what}</span>
              <span className="faint xs a11y-count">
                {f.nodes.length} place{f.nodes.length === 1 ? '' : 's'}
              </span>
            </button>
            {open === f.id && (
              <div className="a11y-detail">
                {f.who && <div className="small faint">Affects {f.who}.</div>}
                {f.nodes.slice(0, 8).map((n, i) => (
                  <button key={i} className="a11y-node" onClick={() => void prism.preview.highlight([n.target])} title="Point at this one">
                    <span className="mono xs">{n.target}</span>
                    {n.detail && <span className="xs faint">{n.detail.split('\n')[0]}</span>}
                  </button>
                ))}
                <a className="xs" href={f.helpUrl} target="_blank" rel="noreferrer">
                  How to fix it
                </a>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
