import { useEffect, useState } from 'react'
import { Check, Copy, WrapText } from 'lucide-react'
import { highlight, normalizeLang } from '@/lib/shiki'
import { cx } from '@/lib/format'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function CodeBlock({ code, lang, file, maxHeight }: { code: string; lang?: string; file?: string; maxHeight?: number }): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(false)
  const l = normalizeLang(lang)

  useEffect(() => {
    let alive = true
    setHtml(null)
    if (code.length > 200_000) return
    void highlight(code, l).then((h) => {
      if (alive) setHtml(h)
    })
    return () => {
      alive = false
    }
  }, [code, l])

  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="cb">
      <div className="cb-head">
        <span className="lang">{l === 'text' ? 'text' : l}</span>
        {file && <span className="file">{file}</span>}
        <span className="sp" />
        <button className={cx('icon-btn sm', wrap && 'on')} title="Wrap lines" onClick={() => setWrap((v) => !v)}>
          <WrapText size={13} />
        </button>
        <button className="icon-btn sm" title="Copy" onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <div className={cx('cb-body', wrap && 'wrap')} style={maxHeight ? { maxHeight } : undefined}>
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>
            <code className="cb-code" dangerouslySetInnerHTML={{ __html: escapeHtml(code) }} />
          </pre>
        )}
      </div>
    </div>
  )
}
