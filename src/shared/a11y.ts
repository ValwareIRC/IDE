// What an accessibility check finds (main/a11y.ts runs it), shared by the Browser
// panel, the agent's tool and the phone.

export interface A11yNode {
  /** A CSS selector for the element. */
  target: string
  html: string
  /** Where it is on the page, in CSS pixels, when it is visible. */
  rect: { x: number; y: number; width: number; height: number } | null
  /** axe's own account of what is wrong with this one. */
  detail: string
}

export interface A11yFinding {
  id: string
  impact: 'critical' | 'serious' | 'moderate' | 'minor'
  /** What is wrong, in plain words. */
  what: string
  /** Who it shuts out or gets in the way of. */
  who: string
  help: string
  helpUrl: string
  nodes: A11yNode[]
}

export interface A11yReport {
  url: string
  title: string
  findings: A11yFinding[]
  passed: number
  at: number
}

const WEIGHT = { critical: 'shuts people out', serious: 'makes it hard', moderate: 'gets in the way', minor: 'small' } as const

/** The report as the agent reads it. */
export function reportText(r: A11yReport): string {
  if (!r.findings.length) return `${r.title || r.url}: no accessibility problems found (${r.passed} checks passed). Automatic checks catch about half of the problems people meet; try the page with the keyboard alone, and with a screen reader, too.`
  const lines = [`${r.title || r.url}: ${r.findings.length} kind(s) of accessibility problem, ${r.passed} checks passed.`]
  let n = 0
  for (const f of r.findings) {
    lines.push(`\n[${f.impact}: ${WEIGHT[f.impact]}] ${f.what}${f.who ? `, for ${f.who}` : ''} (${f.id}, ${f.nodes.length} place${f.nodes.length === 1 ? '' : 's'})`)
    for (const node of f.nodes.slice(0, 6)) {
      n++
      lines.push(`  ${node.rect ? `#${n} ` : ''}${node.target}${node.detail ? `: ${node.detail.split('\n').map((s) => s.trim()).filter(Boolean).join('; ')}` : ''}`)
    }
    if (f.nodes.length > 6) lines.push(`  …and ${f.nodes.length - 6} more`)
    lines.push(`  How to fix: ${f.helpUrl}`)
  }
  return lines.join('\n')
}
