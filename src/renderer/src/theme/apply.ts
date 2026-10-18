// Puts a theme on screen. The interface reads CSS variables (styles/tokens.css
// holds the defaults); the code editor and the terminals have their own theme
// objects, built here from the same colours and refreshed through onTheme().
import type { Settings } from '@shared/types'
import type { Theme, ThemeColors, ThemeLook } from '@shared/theme'
import { alpha, isHex, mix } from '@shared/color'
import { DEFAULT_LOOK, DEFAULT_THEME, PRESETS, sanitize } from '@shared/themePresets'

let current: Theme = DEFAULT_THEME
const listeners = new Set<(t: Theme) => void>()

export function currentTheme(): Theme {
  return current
}

/** Called now and after every change. Returns the unsubscribe. */
export function onTheme(cb: (t: Theme) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export { sanitize }

/** Built-in themes first, then the user's own. */
export function allThemes(s: Settings | null): Theme[] {
  const own = (s?.appearance.themes ?? []).map(sanitize).filter((t): t is Theme => !!t && !PRESETS.some((p) => p.id === t.id))
  return [...PRESETS, ...own]
}

export function activeTheme(s: Settings | null): Theme {
  // before themes existed the choice was only an accent colour; the six classic themes carry those names
  const id = s?.appearance.theme || s?.appearance.accent || DEFAULT_THEME.id
  return allThemes(s).find((t) => t.id === id) ?? DEFAULT_THEME
}

const UI_FALLBACK = `'Inter Variable', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif`
const MONO_FALLBACK = `'JetBrains Mono Variable', 'Cascadia Code', Consolas, ui-monospace, monospace`

export function fontStack(name: string, mono: boolean): string {
  return `'${name.replace(/'/g, '')}', ${mono ? MONO_FALLBACK : UI_FALLBACK}`
}

// where the last click landed: a new theme spreads out from there
let origin: { x: number; y: number } | null = null
// the theme on screen or on its way there, so a repeat call mid-switch does not start another
let shown: string | null = null
// a switch waiting for its first frame paints whatever arrived last
let waiting: { theme: Theme; prefs: { glow: boolean } } | null = null
addEventListener('pointerdown', (e) => (origin = { x: e.clientX, y: e.clientY }), true)

export function applyTheme(theme: Theme, prefs: { glow: boolean }): void {
  const root = document.documentElement
  const switching = shown !== null && shown !== theme.id
  shown = theme.id
  const still = root.dataset['motion'] === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } }
  if (waiting && !switching) {
    waiting = { theme, prefs }
    return
  }
  if (!switching || still || !doc.startViewTransition) return paint(theme, prefs)
  waiting = { theme, prefs }
  const at = origin ?? { x: innerWidth / 2, y: 0 }
  const r = Math.hypot(Math.max(at.x, innerWidth - at.x), Math.max(at.y, innerHeight - at.y))
  doc
    .startViewTransition(() => {
      const w = waiting ?? { theme, prefs }
      waiting = null
      paint(w.theme, w.prefs)
    })
    .ready.then(() => {
      root.animate({ clipPath: [`circle(0px at ${at.x}px ${at.y}px)`, `circle(${r}px at ${at.x}px ${at.y}px)`] }, { duration: 700, easing: 'cubic-bezier(0.22, 0.8, 0.25, 1)', pseudoElement: '::view-transition-new(root)' })
    })
    .catch(() => {})
}

function paint(theme: Theme, prefs: { glow: boolean }): void {
  current = theme
  const c = theme.colors
  const k = theme.look
  const dark = k.kind === 'dark'
  const tint = dark ? '#ffffff' : mix(c.text, '#000000', 0.35)
  const lineK = k.lines * (dark ? 1 : 1.7)
  const glow = prefs.glow ? k.glow : 0
  const pct = (n: number): string => `${Math.max(0, Math.min(100, n)).toFixed(1)}%`
  const acc = (n: number): string => `color-mix(in srgb, ${c.accent} ${pct(n)}, transparent)`
  const amb = k.ambienceStrength
  const vars: Record<string, string> = {
    '--bg-0': c.bg0,
    '--bg-1': c.bg1,
    '--bg-2': c.bg2,
    '--bg-3': c.bg3,
    '--bg-4': c.bg4,
    '--glass': alpha(c.bg1, 1 - k.glass * 0.56),
    '--glass-strong': alpha(c.bg2, 1 - k.glass * 0.2),
    '--tint': tint,
    '--shade': dark ? '#000000' : mix(c.text, c.bg0, 0.45),
    '--line': alpha(tint, 0.065 * lineK),
    '--line-strong': alpha(tint, 0.12 * lineK),
    '--line-faint': alpha(tint, 0.035 * lineK),
    '--text': c.text,
    '--text-2': c.text2,
    '--text-3': c.text3,
    '--text-4': c.text4,
    '--accent': c.accent,
    '--accent-2': c.accent2,
    '--mint': c.mint,
    '--amber': c.amber,
    '--rose': c.rose,
    '--violet': c.violet,
    '--on-accent': c.onAccent,
    '--glow': glow > 0 ? `0 0 0 1px ${acc(30)}, 0 0 ${Math.round(28 * glow)}px ${acc(16 * glow)}` : `0 0 0 1px ${acc(30)}`,
    // how much decoration the theme wants: flat themes (no glow, no glass) get none
    '--fx': String(Math.min(1.6, glow)),
    '--accent-grad': `linear-gradient(135deg, ${c.accent}, ${mix(c.accent, c.accent2, 0.6)})`,
    '--glow-soft': glow > 0 ? `0 0 ${Math.round(22 * glow)}px ${acc(10 * glow)}` : 'none',
    '--shadow-1': dark ? '0 2px 10px rgba(0, 0, 0, 0.35)' : '0 2px 10px rgba(40, 50, 70, 0.12)',
    '--shadow-2': dark ? '0 12px 40px rgba(0, 0, 0, 0.5)' : '0 12px 40px rgba(40, 50, 70, 0.2)',
    '--round': String(k.radius),
    '--r-xs': `${(5 * k.radius).toFixed(1)}px`,
    '--r-sm': `${(7 * k.radius).toFixed(1)}px`,
    '--r-md': `${(10 * k.radius).toFixed(1)}px`,
    '--r-lg': `${(14 * k.radius).toFixed(1)}px`,
    '--font-ui': fontStack(k.fontUi, false),
    '--font-mono': fontStack(k.fontMono, true),
    '--blur': k.blur > 0 && k.glass > 0 ? `blur(${k.blur}px) saturate(1.3)` : 'none',
    '--amb-a': pct(9 * amb * (dark ? 1 : 1.6)),
    '--amb-b': pct(8 * amb * (dark ? 1 : 1.6)),
    '--amb-grid': (0.022 * amb * (dark ? 1 : 2)).toFixed(4),
    '--amb-k': String(Math.min(1, amb)),
    '--picture': k.ambience === 'picture' && k.picture ? `url("prism://theme/${k.picture}")` : 'none',
    '--picture-dim': String(k.pictureDim),
    '--picture-blur': `${k.pictureBlur}px`,
    // code blocks in chat (shiki's css-variables theme)
    '--shiki-foreground': c.synVariable,
    '--shiki-background': 'transparent',
    '--shiki-token-constant': c.synNumber,
    '--shiki-token-string': c.synString,
    '--shiki-token-comment': c.synComment,
    '--shiki-token-keyword': c.synKeyword,
    '--shiki-token-parameter': c.synVariable,
    '--shiki-token-function': c.synFunction,
    '--shiki-token-string-expression': c.synString,
    '--shiki-token-punctuation': c.synOperator,
    '--shiki-token-link': c.accent
  }
  const root = document.documentElement
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
  root.style.setProperty('color-scheme', k.kind)
  root.dataset['kind'] = k.kind
  root.dataset['ambience'] = k.ambience === 'picture' && !k.picture ? 'plain' : k.ambience
  root.dataset['labels'] = k.labels
  root.dataset['theme'] = theme.id
  root.dataset['fx'] = glow > 0 || k.glass > 0 ? 'on' : 'off'
  for (const l of listeners) l(theme)
}

const bare = (hex: string): string => hex.slice(1)

/** The code editor's theme (Monaco's format). */
export function editorTheme(t: Theme): { base: 'vs-dark' | 'vs'; inherit: boolean; rules: Array<{ token: string; foreground: string; fontStyle?: string }>; colors: Record<string, string> } {
  const c = t.colors
  const dark = t.look.kind === 'dark'
  const tint = dark ? '#ffffff' : '#000000'
  const a = (hex: string, n: number): string => `${hex}${Math.round(n * 255).toString(16).padStart(2, '0')}`
  return {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: bare(c.synVariable) },
      { token: 'comment', foreground: bare(c.synComment), fontStyle: 'italic' },
      { token: 'keyword', foreground: bare(c.synKeyword) },
      { token: 'keyword.control', foreground: bare(c.synKeyword) },
      { token: 'storage', foreground: bare(c.synKeyword) },
      { token: 'string', foreground: bare(c.synString) },
      { token: 'string.escape', foreground: bare(c.synNumber) },
      { token: 'number', foreground: bare(c.synNumber) },
      { token: 'constant', foreground: bare(c.synNumber) },
      { token: 'regexp', foreground: bare(c.synTag) },
      { token: 'type', foreground: bare(c.synType) },
      { token: 'type.identifier', foreground: bare(c.synType) },
      { token: 'identifier', foreground: bare(c.synVariable) },
      { token: 'variable', foreground: bare(c.synVariable) },
      { token: 'function', foreground: bare(c.synFunction) },
      { token: 'delimiter', foreground: bare(mix(c.synOperator, c.text3, 0.4)) },
      { token: 'operator', foreground: bare(c.synOperator) },
      { token: 'tag', foreground: bare(c.synTag) },
      { token: 'attribute.name', foreground: bare(c.synKeyword) },
      { token: 'attribute.value', foreground: bare(c.synString) },
      { token: 'metatag', foreground: bare(c.synType) },
      { token: 'key', foreground: bare(c.synFunction) },
      { token: 'string.key.json', foreground: bare(c.synFunction) },
      { token: 'string.value.json', foreground: bare(c.synString) },
      { token: 'invalid', foreground: bare(c.rose) }
    ],
    colors: {
      'editor.background': '#00000000',
      'editor.foreground': c.synVariable,
      'editorLineNumber.foreground': c.text4,
      'editorLineNumber.activeForeground': c.accent,
      'editorCursor.foreground': c.accent,
      'editor.selectionBackground': a(c.accent, 0.2),
      'editor.inactiveSelectionBackground': a(c.accent, 0.1),
      'editor.lineHighlightBackground': a(tint, 0.03),
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': a(tint, 0.05),
      'editorIndentGuide.activeBackground1': a(tint, 0.13),
      'editorWhitespace.foreground': a(tint, 0.08),
      'editor.wordHighlightBackground': a(tint, 0.07),
      'editor.wordHighlightStrongBackground': a(tint, 0.1),
      'editor.selectionHighlightBackground': a(c.accent, 0.12),
      'editorBracketMatch.background': a(c.accent, 0.13),
      'editorBracketMatch.border': a(c.accent, 0.4),
      'editorGutter.background': '#00000000',
      'editorWidget.background': c.bg2,
      'editorWidget.border': a(tint, 0.12),
      'editorSuggestWidget.background': c.bg2,
      'editorSuggestWidget.border': a(tint, 0.12),
      'editorSuggestWidget.selectedBackground': a(c.accent, 0.15),
      'editorHoverWidget.background': c.bg2,
      'editorHoverWidget.border': a(tint, 0.12),
      'input.background': c.bg1,
      'input.border': a(tint, 0.12),
      'scrollbarSlider.background': a(tint, 0.08),
      'scrollbarSlider.hoverBackground': a(tint, 0.16),
      'scrollbarSlider.activeBackground': a(tint, 0.24),
      'minimap.background': '#00000000',
      'editorOverviewRuler.border': '#00000000',
      'diffEditor.insertedTextBackground': a(c.mint, 0.12),
      'diffEditor.removedTextBackground': a(c.rose, 0.15),
      'diffEditor.insertedLineBackground': a(c.mint, 0.08),
      'diffEditor.removedLineBackground': a(c.rose, 0.09),
      'editorGhostText.foreground': c.text3,
      'editorGhostText.border': '#00000000',
      'editor.findMatchBackground': a(c.amber, 0.33),
      'editor.findMatchHighlightBackground': a(c.amber, 0.16),
      'editorBracketHighlight.foreground1': c.accent,
      'editorBracketHighlight.foreground2': c.accent2,
      'editorBracketHighlight.foreground3': c.mint,
      'focusBorder': a(c.accent, 0.4)
    }
  }
}

/** The terminal's colours (xterm's format). */
export function terminalTheme(t: Theme): Record<string, string> {
  const c = t.colors
  const dark = t.look.kind === 'dark'
  const bright = (hex: string): string => mix(hex, dark ? '#ffffff' : '#000000', 0.22)
  return {
    // see-through, but in the panel's own colour: letter edges are smoothed towards this, and towards black they look heavy on a light theme
    background: c.bg1 + '00',
    foreground: c.text,
    cursor: c.accent,
    cursorAccent: c.bg0,
    selectionBackground: `${c.accent}33`,
    black: c.termBlack,
    red: c.termRed,
    green: c.termGreen,
    yellow: c.termYellow,
    blue: c.termBlue,
    magenta: c.termMagenta,
    cyan: c.termCyan,
    white: c.termWhite,
    brightBlack: c.text3,
    brightRed: bright(c.termRed),
    brightGreen: bright(c.termGreen),
    brightYellow: bright(c.termYellow),
    brightBlue: bright(c.termBlue),
    brightMagenta: bright(c.termMagenta),
    brightCyan: bright(c.termCyan),
    brightWhite: dark ? '#ffffff' : c.text
  }
}
