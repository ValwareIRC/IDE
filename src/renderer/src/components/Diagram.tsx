// Mermaid diagrams in the conversation (```mermaid blocks), drawn in the theme's colours. The library
// is large, so it loads the first time a diagram appears. A diagram that does not parse shows its source.
import { useEffect, useState } from 'react'
import { onTheme } from '@/theme/apply'
import { CodeBlock } from './CodeBlock'

let ready: Promise<typeof import('mermaid')['default']> | null = null
let n = 0

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

async function mermaid(): Promise<typeof import('mermaid')['default']> {
  ready ??= import('mermaid').then((m) => m.default)
  const mm = await ready
  const dark = document.documentElement.dataset['kind'] !== 'light'
  mm.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: css('--font-ui') || 'sans-serif',
    themeVariables: {
      darkMode: dark,
      background: 'transparent',
      primaryColor: css('--bg-3'),
      primaryTextColor: css('--text'),
      primaryBorderColor: css('--accent'),
      secondaryColor: css('--bg-2'),
      tertiaryColor: css('--bg-1'),
      lineColor: css('--text-3'),
      textColor: css('--text-2'),
      noteBkgColor: css('--bg-2'),
      noteTextColor: css('--text'),
      fontSize: '13px'
    }
  })
  return mm
}

export function Diagram({ code }: { code: string }): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [themeTick, setThemeTick] = useState(0)
  useEffect(() => onTheme(() => setThemeTick((t) => t + 1)), [])
  useEffect(() => {
    let gone = false
    void (async () => {
      try {
        const mm = await mermaid()
        const { svg } = await mm.render(`prism-diagram-${++n}`, code)
        if (!gone) {
          setSvg(svg)
          setFailed(false)
        }
      } catch {
        if (!gone) setFailed(true)
      }
    })()
    return () => {
      gone = true
    }
  }, [code, themeTick])
  if (failed) return <CodeBlock code={code} lang="mermaid" />
  if (!svg) return <div className="diagram loading faint small">Drawing the diagram…</div>
  return <div className="diagram" dangerouslySetInnerHTML={{ __html: svg }} />
}
