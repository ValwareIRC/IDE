import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useUi } from '@/state/ui'

export function Toasts(): React.JSX.Element {
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismiss)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' ? <AlertCircle size={16} className="rose" /> : t.kind === 'success' ? <CheckCircle2 size={16} className="mint" /> : <Info size={16} className="accent" />}
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{t.title}</div>
            {t.detail && (
              <div className="dim small selectable" style={{ marginTop: 2, whiteSpace: 'pre-wrap' }}>
                {t.detail}
              </div>
            )}
          </div>
          <button className="icon-btn sm" onClick={() => dismiss(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
