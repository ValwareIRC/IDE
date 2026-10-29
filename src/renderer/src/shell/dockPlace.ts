// Where a new tab goes, and what is open where (for the agent's tabs_look).
// A tab goes beside its own sort: files with files, gadgets with gadgets. Someone who keeps a gadget in
// one group and files in another wants a file the agent opens to land among the files, not over the gadget.
import type { DockviewApi, DockviewGroupPanel } from 'dockview'

type Kinded = { params?: unknown }
const kindOf = (p: Kinded): string => ((p.params as { kind?: string } | undefined)?.kind ?? '')

/** Tabs of one sort, which belong together. */
function sortOf(kind: string): string {
  if (['editor', 'preview', 'diff', 'conflict'].includes(kind)) return 'files'
  if (kind === 'gadget' || kind === 'browser') return kind
  if (kind === 'agent') return 'agent'
  if (['terminal', 'problems', 'references'].includes(kind)) return 'bottom'
  return 'pages'
}

/** A page that is usually kept on its own, and not buried under other tabs. */
const LIVES_ALONE = new Set(['gadget', 'browser'])

const lastUsed = new Map<string, number>()

/** Called when a group comes to the front, so the one used last is preferred. */
export function noteGroupUsed(group: DockviewGroupPanel | undefined): void {
  if (group) lastUsed.set(group.id, Date.now())
}

/** The group a new tab of this kind should join; null when there is none in the middle area. */
export function pickGroup(api: DockviewApi, kind: string): DockviewGroupPanel | null {
  const mine = sortOf(kind)
  const middle = api.groups.filter((g) => g.panels.every((p) => !['agent', 'bottom'].includes(sortOf(kindOf(p)))))
  let best: DockviewGroupPanel | null = null
  let bestScore = -Infinity
  for (const g of middle) {
    const sorts = new Set(g.panels.map((p) => sortOf(kindOf(p))))
    let score = 0
    if (sorts.has(mine)) score += 100
    // a group given over to a gadget or the browser is left to it
    if (sorts.size && [...sorts].every((s) => LIVES_ALONE.has(s)) && !sorts.has(mine)) score -= 50
    // between equals, the one used most recently
    score += (lastUsed.get(g.id) ?? 0) / 1e13
    if (score > bestScore) {
      bestScore = score
      best = g
    }
  }
  return best
}

export interface TabsReport {
  groups: Array<{
    group: number
    where: string
    inFront: boolean
    tabs: Array<{ title: string; kind: string; file?: string; gadget?: string; showing: boolean }>
  }>
}

/** Every group and its tabs, where each group sits on screen, and which tab is showing in each. */
export function describeTabs(api: DockviewApi): TabsReport {
  const all = api.groups.map((g) => ({ g, r: g.element.getBoundingClientRect() }))
  const left = Math.min(...all.map((x) => x.r.left))
  const top = Math.min(...all.map((x) => x.r.top))
  const right = Math.max(...all.map((x) => x.r.right))
  const bottom = Math.max(...all.map((x) => x.r.bottom))
  const third = (at: number, lo: number, hi: number, words: [string, string, string]): string => {
    const f = hi > lo ? (at - lo) / (hi - lo) : 0.5
    return f < 0.4 ? words[0] : f > 0.6 ? words[2] : words[1]
  }
  return {
    groups: all.map(({ g, r }, i) => {
      const across = third((r.left + r.right) / 2, left, right, ['left', 'middle', 'right'])
      const down = third((r.top + r.bottom) / 2, top, bottom, ['top', 'middle', 'bottom'])
      const where = r.width >= (right - left) * 0.9 && r.height >= (bottom - top) * 0.9 ? 'whole area' : down === 'middle' ? across : across === 'middle' ? down : `${down} ${across}`
      return {
        group: i + 1,
        where: r.width && r.height ? where : 'hidden',
        inFront: api.activeGroup?.id === g.id,
        tabs: g.panels.map((p) => {
          const params = (p.params ?? {}) as { kind?: string; path?: string; gadgetId?: string }
          return {
            title: p.title ?? p.id,
            kind: params.kind ?? '',
            ...(params.path ? { file: params.path } : {}),
            ...(params.gadgetId ? { gadget: params.gadgetId } : {}),
            showing: g.activePanel?.id === p.id
          }
        })
      }
    })
  }
}
