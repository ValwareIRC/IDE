// The built-in themes. Each is a few chosen colours (a "seed") from which the
// rest are worked out, plus whatever it wants to set by hand.
import type { Theme, ThemeColors, ThemeLook } from './theme'
import { contrast, hsl, hslOf, isHex, mix, readable } from './color'

export interface Seed {
  kind: 'dark' | 'light'
  /** The window backdrop; every other surface is derived from it. */
  bg: string
  accent: string
  accent2: string
  text?: string
  mint?: string
  amber?: string
  rose?: string
  violet?: string
}

const clamp = (n: number, a: number, b: number): number => Math.max(a, Math.min(b, n))

/** A full set of colours from a handful. This is also what "Rebuild colours" in the theme editor runs. */
export function buildColors(seed: Seed): ThemeColors {
  const dark = seed.kind === 'dark'
  const b = hslOf(seed.bg)
  // dark: each raised surface is a little lighter. light: panels are lighter than the backdrop, raised parts a little darker.
  const steps = dark ? [0, 2.3, 4.7, 7.7, 11.2] : [0, 3.4, 1.2, -2.2, -6]
  const [bg0, bg1, bg2, bg3, bg4] = steps.map((d) => hsl(b.h, b.s, clamp(b.l + d, 0, 100))) as [string, string, string, string, string]
  const ts = Math.min(b.s, 26)
  const text = seed.text ?? (dark ? hsl(b.h, ts * 0.6, 93) : hsl(b.h, ts, 13))
  const t = hslOf(text)
  const text2 = dark ? hsl(t.h, Math.min(t.s, 18), 70) : hsl(t.h, Math.min(t.s, 22), 33)
  const text3 = dark ? hsl(t.h, Math.min(t.s, 16), 48) : hsl(t.h, Math.min(t.s, 16), 47)
  const text4 = dark ? hsl(t.h, Math.min(t.s, 16), 34) : hsl(t.h, Math.min(t.s, 14), 63)
  // on a light surface the bright status colours of a dark theme would wash out
  const tone = (c: string): string => readable(c, bg1, dark ? 3 : 3.4)
  const accent = tone(seed.accent)
  const accent2 = tone(seed.accent2)
  const mint = tone(seed.mint ?? (dark ? '#7ee8c3' : '#17946a'))
  const amber = tone(seed.amber ?? (dark ? '#ffc46b' : '#b27214'))
  const rose = tone(seed.rose ?? (dark ? '#ff7b93' : '#d43a62'))
  const violet = tone(seed.violet ?? (dark ? '#b9a7ff' : '#6f55d8'))
  const onAccent = contrast(accent, '#0b0d13') >= contrast(accent, '#ffffff') ? '#0b0d13' : '#ffffff'
  return {
    bg0,
    bg1,
    bg2,
    bg3,
    bg4,
    text,
    text2,
    text3,
    text4,
    accent,
    accent2,
    mint,
    amber,
    rose,
    violet,
    onAccent,
    synComment: text3,
    synKeyword: accent2,
    synString: mint,
    synNumber: amber,
    synFunction: accent,
    synType: mix(accent, accent2, 0.35),
    synVariable: text,
    synOperator: text2,
    synTag: rose,
    termBlack: dark ? bg3 : text,
    termRed: rose,
    termGreen: mint,
    termYellow: amber,
    termBlue: accent,
    termMagenta: violet,
    termCyan: mix(accent, mint, 0.5),
    termWhite: dark ? text : text2
  }
}

export const DEFAULT_LOOK: ThemeLook = {
  kind: 'dark',
  fontUi: 'Inter Variable',
  fontMono: 'JetBrains Mono Variable',
  radius: 1,
  lines: 1,
  glow: 1,
  glass: 0.6,
  blur: 18,
  ambience: 'aurora',
  ambienceStrength: 1,
  picture: null,
  pictureDim: 0.55,
  pictureBlur: 0,
  labels: 'caps'
}

function make(id: string, name: string, seed: Seed, look: Partial<ThemeLook> = {}, colors: Partial<ThemeColors> = {}): Theme {
  return { id, name, builtin: true, colors: { ...buildColors(seed), ...colors }, look: { ...DEFAULT_LOOK, kind: seed.kind, ...look } }
}

// the original Prism surfaces and text, kept exact for the six classic themes
const CLASSIC: Partial<ThemeColors> = { bg0: '#07080c', bg1: '#0b0d13', bg2: '#10131b', bg3: '#161a25', bg4: '#1d2230', text: '#e9ecf4', text2: '#a7aec0', text3: '#6d7489', text4: '#4a5064', termBlack: '#10131b' }
const classic = (id: string, name: string, accent: string, accent2: string): Theme =>
  make(id, name, { kind: 'dark', bg: '#07080c', accent, accent2 }, {}, { ...CLASSIC, synType: accent, synKeyword: id === 'aurora' ? '#b9a7ff' : accent2 })

const LIGHT: Partial<ThemeLook> = { glow: 0.35, glass: 0.25, ambienceStrength: 0.8 }

export const PRISM_PRESETS: Theme[] = [
  classic('aurora', 'Aurora', '#8ad8ff', '#b9a7ff'),
  classic('lilac', 'Lilac', '#b9a7ff', '#8ad8ff'),
  classic('mint', 'Mint', '#7ee8c3', '#8ad8ff'),
  classic('ember', 'Ember', '#ffb27a', '#ff8fab'),
  classic('rose', 'Rose', '#ff8fab', '#b9a7ff'),
  classic('gold', 'Gold', '#f2d27a', '#8ad8ff'),

  make('midnight', 'Midnight', { kind: 'dark', bg: '#050916', accent: '#6aa5ff', accent2: '#7de3ff' }, { ambience: 'stars' }),
  make('nebula', 'Nebula', { kind: 'dark', bg: '#0d0718', accent: '#d58cff', accent2: '#ff8fd0' }, { ambience: 'mesh', ambienceStrength: 1.2 }),
  make('synthwave', 'Synthwave', { kind: 'dark', bg: '#120822', accent: '#ff4fd8', accent2: '#33e6ff', mint: '#5dfdcb', amber: '#ffd166', rose: '#ff5c8a' }, { glow: 1.7, ambience: 'grid', ambienceStrength: 1.8, radius: 0.6 }),
  make('deepsea', 'Deep sea', { kind: 'dark', bg: '#04121a', accent: '#3fe0d0', accent2: '#5aa9ff' }, { ambience: 'mesh' }),
  make('forest', 'Forest', { kind: 'dark', bg: '#08110c', accent: '#9be36b', accent2: '#f2c66d' }),
  make('campfire', 'Campfire', { kind: 'dark', bg: '#140c08', accent: '#ff9d5c', accent2: '#ffd27a', text: '#f5e9df' }, { ambience: 'mesh' }),
  make('bloodmoon', 'Blood moon', { kind: 'dark', bg: '#100607', accent: '#ff5c6c', accent2: '#ffb07a', text: '#f4e6e6' }),
  make('candy', 'Cotton candy', { kind: 'dark', bg: '#150f1f', accent: '#ff9ed8', accent2: '#8fd3ff', violet: '#c9a8ff' }, { radius: 1.6, fontUi: 'Nunito Variable', ambience: 'mesh', ambienceStrength: 1.2 }),
  make('vampire', 'Vampire', { kind: 'dark', bg: '#16141f', accent: '#bd93f9', accent2: '#ff79c6', mint: '#50fa7b', amber: '#f1fa8c', rose: '#ff5555' }, { glow: 0.7 }),
  make('frost', 'Frost', { kind: 'dark', bg: '#10151e', accent: '#88c0d0', accent2: '#b48ead', mint: '#a3be8c', amber: '#ebcb8b', rose: '#bf616a', text: '#e5e9f0' }, { glow: 0.5, ambience: 'plain' }),
  make('obsidian', 'Obsidian and gold', { kind: 'dark', bg: '#0a0a0a', accent: '#e8c56a', accent2: '#f1e3b5' }, { glow: 0.6, radius: 0.7, ambience: 'plain' }),
  make('graphite', 'Graphite', { kind: 'dark', bg: '#191a1e', accent: '#4da3ff', accent2: '#b48cff' }, { glow: 0, glass: 0, radius: 0.7, ambience: 'plain', labels: 'plain' }),
  make('mono', 'Monochrome', { kind: 'dark', bg: '#0b0b0b', accent: '#f2f2f2', accent2: '#a8a8a8', mint: '#cfcfcf', amber: '#e0e0e0', rose: '#ffffff', violet: '#b5b5b5' }, { glow: 0, ambience: 'plain' }),
  make('phosphor', 'Phosphor', { kind: 'dark', bg: '#020a04', accent: '#39ff88', accent2: '#b6ff5c', text: '#b8f5c9', mint: '#39ff88', violet: '#7dffb0' }, { fontUi: 'JetBrains Mono Variable', ambience: 'scanlines', radius: 0.2, glow: 1.4 }),
  make('contrast', 'High contrast', { kind: 'dark', bg: '#000000', accent: '#ffe14d', accent2: '#5ce1ff', text: '#ffffff' }, { lines: 2.4, glow: 0, glass: 0, ambience: 'plain' }, { text2: '#e6e6e6', text3: '#bdbdbd', text4: '#8f8f8f' }),

  make('paper', 'Paper', { kind: 'light', bg: '#e9ecf1', accent: '#2f6feb', accent2: '#7a4fd6' }, { ...LIGHT, ambience: 'plain', labels: 'plain' }),
  make('cream', 'Cream', { kind: 'light', bg: '#f3eadb', accent: '#dd6f8c', accent2: '#6f93d6', mint: '#3f9e83', amber: '#c98a2b', rose: '#d1495b', violet: '#8b78d6', text: '#3b3228' }, { ...LIGHT, radius: 1.6, fontUi: 'Nunito Variable', ambience: 'mesh' }),
  make('sakura', 'Sakura', { kind: 'light', bg: '#f7e6ee', accent: '#d94f8a', accent2: '#8a6fd1', text: '#3a2630' }, { ...LIGHT, radius: 1.5, fontUi: 'Nunito Variable', ambience: 'mesh' }),
  make('matcha', 'Matcha', { kind: 'light', bg: '#e6f0e6', accent: '#2f9e6a', accent2: '#5a8fd6', text: '#22302a' }, { ...LIGHT, ambience: 'mesh' }),
  make('daylight', 'Daylight', { kind: 'light', bg: '#e6f0fa', accent: '#1f7fd6', accent2: '#12a3a3' }, { ...LIGHT, ambience: 'aurora' }),
  make('sand', 'Sand', { kind: 'light', bg: '#f1e7d2', accent: '#cb6a2b', accent2: '#2a8f98', text: '#463d2e' }, { ...LIGHT, ambience: 'plain' })
]

/** Every colour given by hand, for themes copied from somewhere else. */
interface Palette {
  /** Backdrop, panels, then raised parts. */
  bg: [string, string, string, string, string]
  text: [string, string, string, string]
  accent: string
  accent2: string
  mint: string
  amber: string
  rose: string
  violet: string
  onAccent?: string
  /** comment, keyword, string, number, function, type, variable, operator, tag */
  syn: [string, string, string, string, string, string, string, string, string]
  /** black, red, green, yellow, blue, magenta, cyan, white */
  term: [string, string, string, string, string, string, string, string]
}

function exact(id: string, name: string, kind: 'dark' | 'light', p: Palette, look: Partial<ThemeLook> = {}): Theme {
  const [bg0, bg1, bg2, bg3, bg4] = p.bg
  const [text, text2, text3, text4] = p.text
  const [synComment, synKeyword, synString, synNumber, synFunction, synType, synVariable, synOperator, synTag] = p.syn
  const [termBlack, termRed, termGreen, termYellow, termBlue, termMagenta, termCyan, termWhite] = p.term
  const onAccent = p.onAccent ?? (contrast(p.accent, '#0b0d13') >= contrast(p.accent, '#ffffff') ? '#0b0d13' : '#ffffff')
  return {
    id,
    name,
    builtin: true,
    colors: { bg0, bg1, bg2, bg3, bg4, text, text2, text3, text4, accent: p.accent, accent2: p.accent2, mint: p.mint, amber: p.amber, rose: p.rose, violet: p.violet, onAccent, synComment, synKeyword, synString, synNumber, synFunction, synType, synVariable, synOperator, synTag, termBlack, termRed, termGreen, termYellow, termBlue, termMagenta, termCyan, termWhite },
    look: { ...DEFAULT_LOOK, kind, ...look }
  }
}

// flat and solid, the way ordinary editors look
const FLAT: Partial<ThemeLook> = { glow: 0, glass: 0, blur: 0, ambience: 'plain', labels: 'plain', radius: 0.55 }
const EDITOR: Partial<ThemeLook> = { glow: 0.3, glass: 0.12, ambience: 'plain', labels: 'plain', radius: 0.8 }
const SEGOE: Partial<ThemeLook> = { fontUi: 'Segoe UI', fontMono: 'Cascadia Code' }

const DARK_PLUS_SYN: Palette['syn'] = ['#6a9955', '#569cd6', '#ce9178', '#b5cea8', '#dcdcaa', '#4ec9b0', '#9cdcfe', '#d4d4d4', '#569cd6']
const VS_TERM: Palette['term'] = ['#3c3c3c', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5']
const SOLAR = { yellow: '#b58900', orange: '#cb4b16', red: '#dc322f', magenta: '#d33682', violet: '#6c71c4', blue: '#268bd2', cyan: '#2aa198', green: '#859900' }

export const EDITOR_PRESETS: Theme[] = [
  exact('vscode-dark-modern', 'Dark Modern', 'dark', { bg: ['#181818', '#1f1f1f', '#252526', '#2b2b2b', '#3c3c3c'], text: ['#cccccc', '#9d9d9d', '#868686', '#5a5a5a'], accent: '#0078d4', accent2: '#c586c0', onAccent: '#ffffff', mint: '#2ea043', amber: '#cca700', rose: '#f85149', violet: '#c586c0', syn: DARK_PLUS_SYN, term: VS_TERM }, { ...FLAT, ...SEGOE }),
  exact('vscode-dark-plus', 'Dark+', 'dark', { bg: ['#1e1e1e', '#252526', '#2d2d2d', '#37373d', '#454545'], text: ['#d4d4d4', '#bbbbbb', '#858585', '#5a5a5a'], accent: '#007acc', accent2: '#c586c0', onAccent: '#ffffff', mint: '#89d185', amber: '#cca700', rose: '#f48771', violet: '#c586c0', syn: DARK_PLUS_SYN, term: VS_TERM }, { ...FLAT, ...SEGOE, radius: 0.3 }),
  exact('vscode-light-modern', 'Light Modern', 'light', { bg: ['#f8f8f8', '#ffffff', '#f8f8f8', '#ebebeb', '#dddddd'], text: ['#3b3b3b', '#616161', '#868686', '#b0b0b0'], accent: '#005fb8', accent2: '#af00db', onAccent: '#ffffff', mint: '#2ea043', amber: '#bf8803', rose: '#e51400', violet: '#af00db', syn: ['#008000', '#0000ff', '#a31515', '#098658', '#795e26', '#267f99', '#001080', '#3b3b3b', '#800000'], term: ['#000000', '#cd3131', '#107c10', '#949800', '#0451a5', '#bc05bc', '#0598bc', '#555555'] }, { ...FLAT, ...SEGOE }),
  exact('github-dark', 'GitHub Dark', 'dark', { bg: ['#010409', '#0d1117', '#151b23', '#212830', '#3d444d'], text: ['#f0f6fc', '#9198a1', '#7d8590', '#4e5661'], accent: '#4493f8', accent2: '#ab7df8', onAccent: '#ffffff', mint: '#3fb950', amber: '#d29922', rose: '#f85149', violet: '#ab7df8', syn: ['#9198a1', '#ff7b72', '#a5d6ff', '#79c0ff', '#d2a8ff', '#ffa657', '#f0f6fc', '#ff7b72', '#7ee787'], term: ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4'] }, { ...FLAT, radius: 0.75, fontUi: 'Segoe UI' }),
  exact('github-dimmed', 'GitHub Dark Dimmed', 'dark', { bg: ['#1c2128', '#22272e', '#2d333b', '#373e47', '#444c56'], text: ['#d1d7e0', '#adbac7', '#768390', '#545d68'], accent: '#539bf5', accent2: '#b083f0', mint: '#57ab5a', amber: '#c69026', rose: '#e5534b', violet: '#b083f0', syn: ['#768390', '#f47067', '#96d0ff', '#6cb6ff', '#dcbdfb', '#f69d50', '#adbac7', '#f47067', '#8ddb8c'], term: ['#545d68', '#f47067', '#57ab5a', '#c69026', '#539bf5', '#b083f0', '#39c5cf', '#909dab'] }, { ...FLAT, radius: 0.75, fontUi: 'Segoe UI' }),
  exact('github-light', 'GitHub Light', 'light', { bg: ['#f6f8fa', '#ffffff', '#f6f8fa', '#eff2f5', '#d1d9e0'], text: ['#1f2328', '#59636e', '#6e7781', '#a0a8b1'], accent: '#0969da', accent2: '#8250df', onAccent: '#ffffff', mint: '#1a7f37', amber: '#9a6700', rose: '#d1242f', violet: '#8250df', syn: ['#59636e', '#cf222e', '#0a3069', '#0550ae', '#8250df', '#953800', '#1f2328', '#cf222e', '#116329'], term: ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781'] }, { ...FLAT, radius: 0.75, fontUi: 'Segoe UI' }),

  exact('one-dark', 'One Dark', 'dark', { bg: ['#21252b', '#282c34', '#2c313a', '#333842', '#3e4451'], text: ['#d7dae0', '#abb2bf', '#7f848e', '#5c6370'], accent: '#61afef', accent2: '#c678dd', mint: '#98c379', amber: '#e5c07b', rose: '#e06c75', violet: '#c678dd', syn: ['#7f848e', '#c678dd', '#98c379', '#d19a66', '#61afef', '#e5c07b', '#e06c75', '#56b6c2', '#e06c75'], term: ['#3f4451', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d7dae0'] }, EDITOR),
  exact('monokai', 'Monokai', 'dark', { bg: ['#1e1f1c', '#272822', '#2e2f29', '#3e3d32', '#49483e'], text: ['#f8f8f2', '#cfcfc2', '#90908a', '#75715e'], accent: '#a6e22e', accent2: '#f92672', mint: '#a6e22e', amber: '#e6db74', rose: '#f92672', violet: '#ae81ff', syn: ['#88846f', '#f92672', '#e6db74', '#ae81ff', '#a6e22e', '#66d9ef', '#f8f8f2', '#f92672', '#f92672'], term: ['#49483e', '#f92672', '#a6e22e', '#e6db74', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2'] }, EDITOR),
  exact('solarized-dark', 'Solarized Dark', 'dark', { bg: ['#00212b', '#002b36', '#073642', '#0b4050', '#174a57'], text: ['#93a1a1', '#839496', '#657b83', '#4a5f66'], accent: SOLAR.blue, accent2: SOLAR.magenta, mint: SOLAR.green, amber: SOLAR.yellow, rose: SOLAR.red, violet: SOLAR.violet, syn: ['#586e75', SOLAR.green, SOLAR.cyan, SOLAR.magenta, SOLAR.blue, SOLAR.yellow, '#93a1a1', SOLAR.green, SOLAR.blue], term: ['#073642', SOLAR.red, SOLAR.green, SOLAR.yellow, SOLAR.blue, SOLAR.magenta, SOLAR.cyan, '#eee8d5'] }, EDITOR),
  exact('solarized-light', 'Solarized Light', 'light', { bg: ['#eee8d5', '#fdf6e3', '#f7f0dc', '#eee8d5', '#e3dcc6'], text: ['#586e75', '#657b83', '#839496', '#a3aeae'], accent: SOLAR.blue, accent2: SOLAR.magenta, mint: SOLAR.green, amber: SOLAR.yellow, rose: SOLAR.red, violet: SOLAR.violet, syn: ['#93a1a1', SOLAR.green, SOLAR.cyan, SOLAR.magenta, SOLAR.blue, SOLAR.yellow, '#586e75', SOLAR.green, SOLAR.blue], term: ['#073642', SOLAR.red, SOLAR.green, SOLAR.yellow, SOLAR.blue, SOLAR.magenta, SOLAR.cyan, '#586e75'] }, EDITOR),
  exact('tokyo-night', 'Tokyo Night', 'dark', { bg: ['#16161e', '#1a1b26', '#1f2335', '#292e42', '#3b4261'], text: ['#c0caf5', '#a9b1d6', '#737aa2', '#545c7e'], accent: '#7aa2f7', accent2: '#bb9af7', mint: '#9ece6a', amber: '#e0af68', rose: '#f7768e', violet: '#bb9af7', syn: ['#565f89', '#bb9af7', '#9ece6a', '#ff9e64', '#7aa2f7', '#2ac3de', '#c0caf5', '#89ddff', '#f7768e'], term: ['#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6'] }, { ...EDITOR, glow: 0.6, ambience: 'stars', ambienceStrength: 0.5 }),
  exact('catppuccin-mocha', 'Catppuccin Mocha', 'dark', { bg: ['#11111b', '#1e1e2e', '#262637', '#313244', '#45475a'], text: ['#cdd6f4', '#bac2de', '#7f849c', '#585b70'], accent: '#cba6f7', accent2: '#89b4fa', mint: '#a6e3a1', amber: '#f9e2af', rose: '#f38ba8', violet: '#b4befe', syn: ['#9399b2', '#cba6f7', '#a6e3a1', '#fab387', '#89b4fa', '#f9e2af', '#cdd6f4', '#89dceb', '#f38ba8'], term: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de'] }, { ...EDITOR, radius: 1.2, glow: 0.5 }),
  exact('catppuccin-latte', 'Catppuccin Latte', 'light', { bg: ['#e6e9ef', '#eff1f5', '#e9ecf2', '#dce0e8', '#ccd0da'], text: ['#4c4f69', '#5c5f77', '#7c7f93', '#9ca0b0'], accent: '#8839ef', accent2: '#1e66f5', onAccent: '#ffffff', mint: '#40a02b', amber: '#df8e1d', rose: '#d20f39', violet: '#7287fd', syn: ['#7c7f93', '#8839ef', '#40a02b', '#fe640b', '#1e66f5', '#df8e1d', '#4c4f69', '#04a5e5', '#d20f39'], term: ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#6c6f85'] }, { ...EDITOR, radius: 1.2 }),
  exact('gruvbox', 'Gruvbox', 'dark', { bg: ['#1d2021', '#282828', '#32302f', '#3c3836', '#504945'], text: ['#ebdbb2', '#d5c4a1', '#a89984', '#7c6f64'], accent: '#fe8019', accent2: '#83a598', mint: '#b8bb26', amber: '#fabd2f', rose: '#fb4934', violet: '#d3869b', syn: ['#928374', '#fb4934', '#b8bb26', '#d3869b', '#8ec07c', '#fabd2f', '#83a598', '#fe8019', '#fb4934'], term: ['#3c3836', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'] }, EDITOR),
  exact('night-owl', 'Night Owl', 'dark', { bg: ['#010e1a', '#011627', '#0b2942', '#13344f', '#1d3b53'], text: ['#d6deeb', '#a7b8cc', '#5f7e97', '#3f5a72'], accent: '#82aaff', accent2: '#c792ea', mint: '#22da6e', amber: '#ecc48d', rose: '#ef5350', violet: '#c792ea', syn: ['#637777', '#c792ea', '#ecc48d', '#f78c6c', '#82aaff', '#ffcb8b', '#d6deeb', '#7fdbca', '#7fdbca'], term: ['#1d3b53', '#ef5350', '#22da6e', '#c5e478', '#82aaff', '#c792ea', '#21c7a8', '#d6deeb'] }, { ...EDITOR, glow: 0.6, ambience: 'stars', ambienceStrength: 0.6 }),
  exact('rose-pine', 'Rosé Pine', 'dark', { bg: ['#191724', '#1f1d2e', '#26233a', '#2a2740', '#403d52'], text: ['#e0def4', '#908caa', '#6e6a86', '#524f67'], accent: '#ebbcba', accent2: '#c4a7e7', mint: '#9ccfd8', amber: '#f6c177', rose: '#eb6f92', violet: '#c4a7e7', syn: ['#6e6a86', '#3e8fb0', '#f6c177', '#eb6f92', '#ebbcba', '#9ccfd8', '#e0def4', '#908caa', '#9ccfd8'], term: ['#26233a', '#eb6f92', '#3e8fb0', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4'] }, { ...EDITOR, radius: 1.2, glow: 0.6, ambience: 'mesh', ambienceStrength: 0.45 }),
  exact('rose-pine-dawn', 'Rosé Pine Dawn', 'light', { bg: ['#faf4ed', '#fffaf3', '#fcf6ef', '#f2e9e1', '#dfdad9'], text: ['#575279', '#797593', '#9893a5', '#bdb8c8'], accent: '#d7827e', accent2: '#907aa9', mint: '#56949f', amber: '#ea9d34', rose: '#b4637a', violet: '#907aa9', syn: ['#9893a5', '#286983', '#ea9d34', '#b4637a', '#d7827e', '#56949f', '#575279', '#797593', '#56949f'], term: ['#575279', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#797593'] }, { ...EDITOR, radius: 1.2, ambience: 'mesh', ambienceStrength: 0.5 }),
  exact('ayu-light', 'Ayu Light', 'light', { bg: ['#f3f4f5', '#fcfcfc', '#f8f9fa', '#eceef0', '#dcdfe3'], text: ['#5c6166', '#787b80', '#8a9199', '#adb1b8'], accent: '#ff9940', accent2: '#399ee6', mint: '#86b300', amber: '#f2ae49', rose: '#f07171', violet: '#a37acc', syn: ['#999a9e', '#fa8d3e', '#86b300', '#a37acc', '#f2ae49', '#399ee6', '#5c6166', '#ed9366', '#55b4d4'], term: ['#5c6166', '#f07171', '#86b300', '#e6ba7e', '#399ee6', '#a37acc', '#4cbf99', '#787b80'] }, EDITOR),
  exact('kanagawa', 'Kanagawa', 'dark', { bg: ['#16161d', '#1f1f28', '#2a2a37', '#363646', '#54546d'], text: ['#dcd7ba', '#c8c093', '#727169', '#54546d'], accent: '#7e9cd8', accent2: '#957fb8', mint: '#98bb6c', amber: '#e6c384', rose: '#e46876', violet: '#957fb8', syn: ['#727169', '#957fb8', '#98bb6c', '#d27e99', '#7e9cd8', '#7aa89f', '#dcd7ba', '#c0a36e', '#e46876'], term: ['#363646', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#c8c093'] }, EDITOR)
]

// in the spirit of the AI apps people know: their colours and shapes, nothing else
export const AI_PRESETS: Theme[] = [
  exact('clay', 'Clay', 'light', { bg: ['#f0eee6', '#faf9f5', '#f5f4ed', '#ebe9df', '#dedbcf'], text: ['#1f1e1d', '#3d3d3a', '#73726c', '#a3a199'], accent: '#c96442', accent2: '#5b7fb5', onAccent: '#ffffff', mint: '#4f8a5b', amber: '#b07a1f', rose: '#c2453e', violet: '#7d63b8', syn: ['#8c8a82', '#c96442', '#5c8a4f', '#b07a1f', '#3d6aa6', '#8a5bb0', '#2b2a27', '#73726c', '#b8473d'], term: ['#3d3d3a', '#c2453e', '#4f8a5b', '#b07a1f', '#3d6aa6', '#8a5bb0', '#3f8a8a', '#73726c'] }, { glow: 0.25, glass: 0.1, ambience: 'plain', labels: 'plain', radius: 1.15 }),
  exact('clay-night', 'Clay night', 'dark', { bg: ['#1f1e1d', '#262624', '#2b2a27', '#30302e', '#3e3e38'], text: ['#f0eee6', '#c2c0b6', '#9c9a92', '#6b6a65'], accent: '#d97757', accent2: '#9fb0d9', mint: '#8fbf8a', amber: '#e0b25e', rose: '#e5786d', violet: '#b7a2e0', syn: ['#7d7b74', '#d97757', '#a8c49a', '#e0b25e', '#8fb3e0', '#c8a8e0', '#f0eee6', '#b0aea5', '#e5786d'], term: ['#3e3e38', '#e5786d', '#8fbf8a', '#e0b25e', '#8fb3e0', '#c8a8e0', '#86c2bd', '#c2c0b6'] }, { glow: 0.45, glass: 0.12, ambience: 'plain', labels: 'plain', radius: 1.15 }),
  exact('charcoal', 'Charcoal', 'dark', { bg: ['#171717', '#212121', '#2a2a2a', '#2f2f2f', '#424242'], text: ['#ececec', '#b4b4b4', '#8f8f8f', '#5d5d5d'], accent: '#ffffff', accent2: '#10a37f', onAccent: '#0d0d0d', mint: '#10a37f', amber: '#e9950c', rose: '#f25555', violet: '#ab68ff', syn: ['#8f8f8f', '#2e95d3', '#00a67d', '#df3079', '#f22c3d', '#e9950c', '#ececec', '#b4b4b4', '#f22c3d'], term: ['#424242', '#f25555', '#10a37f', '#e9950c', '#2e95d3', '#ab68ff', '#3cb3c2', '#ececec'] }, { ...FLAT, radius: 1.5 }),
  exact('caret', 'Caret', 'dark', { bg: ['#141414', '#181818', '#1e1e1e', '#262626', '#313131'], text: ['#e4e4e4', '#a8a8ae', '#6d6d73', '#4a4a4f'], accent: '#228df2', accent2: '#e394dc', onAccent: '#ffffff', mint: '#3fa266', amber: '#ebc88d', rose: '#f14c4c', violet: '#aa9bf5', syn: ['#6d6d6d', '#82d2ce', '#e394dc', '#ebc88d', '#efb080', '#87c3ff', '#d6d6dd', '#d6d6dd', '#87c3ff'], term: ['#313131', '#f14c4c', '#3fa266', '#ebc88d', '#228df2', '#e394dc', '#82d2ce', '#d6d6dd'] }, { ...FLAT, radius: 0.7 }),
  exact('indigo', 'Indigo', 'dark', { bg: ['#08090a', '#0f1011', '#141516', '#1c1d1f', '#28282c'], text: ['#f7f8f8', '#d0d6e0', '#8a8f98', '#62666d'], accent: '#7170ff', accent2: '#e2a8ff', onAccent: '#ffffff', mint: '#4cb782', amber: '#f2c94c', rose: '#eb5757', violet: '#a5a8ff', syn: ['#62666d', '#a5a8ff', '#4cb782', '#f2994a', '#7aa8ff', '#e2a8ff', '#f7f8f8', '#8a8f98', '#eb5757'], term: ['#28282c', '#eb5757', '#4cb782', '#f2c94c', '#7aa8ff', '#a5a8ff', '#5ec5d6', '#d0d6e0'] }, { glow: 0.7, glass: 0.35, ambience: 'aurora', ambienceStrength: 0.5, labels: 'plain', radius: 0.9 }),
  exact('pitch', 'Pitch', 'dark', { bg: ['#000000', '#0a0a0a', '#111111', '#1a1a1a', '#2e2e2e'], text: ['#ededed', '#a1a1a1', '#7c7c7c', '#4d4d4d'], accent: '#ffffff', accent2: '#52a8ff', onAccent: '#000000', mint: '#62c073', amber: '#f2a600', rose: '#ff6166', violet: '#bf7af0', syn: ['#6e6e6e', '#f75f8f', '#62c073', '#52a8ff', '#bf7af0', '#52a8ff', '#ededed', '#a1a1a1', '#62c073'], term: ['#2e2e2e', '#ff6166', '#62c073', '#f2a600', '#52a8ff', '#bf7af0', '#0ac7b4', '#ededed'] }, { ...FLAT, radius: 0.7, ambience: 'grid', ambienceStrength: 0.35 }),
  exact('twilight', 'Twilight', 'dark', { bg: ['#0e0e10', '#131314', '#1e1f20', '#282a2c', '#333537'], text: ['#e3e3e3', '#c4c7c5', '#8e918f', '#5f6368'], accent: '#8ab4f8', accent2: '#c58af9', mint: '#81c995', amber: '#fdd663', rose: '#f28b82', violet: '#c58af9', syn: ['#8e918f', '#c58af9', '#81c995', '#fcad70', '#8ab4f8', '#78d9ec', '#e3e3e3', '#c4c7c5', '#f28b82'], term: ['#333537', '#f28b82', '#81c995', '#fdd663', '#8ab4f8', '#c58af9', '#78d9ec', '#e3e3e3'] }, { glow: 1, glass: 0.4, ambience: 'mesh', ambienceStrength: 1, labels: 'plain', radius: 1.5 }),
  exact('lagoon', 'Lagoon', 'dark', { bg: ['#151616', '#191a1a', '#202222', '#2a2c2c', '#353838'], text: ['#e8e8e6', '#b5b5b0', '#8d8d88', '#5c5e5d'], accent: '#20b8cd', accent2: '#e0a96d', mint: '#5fbf8f', amber: '#e0a96d', rose: '#e8706a', violet: '#a99cf0', syn: ['#7a7a76', '#20b8cd', '#9cc98f', '#e0a96d', '#7fc1f0', '#e8b4d8', '#e8e8e6', '#b5b5b0', '#e8706a'], term: ['#353838', '#e8706a', '#5fbf8f', '#e0a96d', '#7fc1f0', '#a99cf0', '#20b8cd', '#e8e8e6'] }, { glow: 0.4, glass: 0.2, ambience: 'plain', labels: 'plain', radius: 1 }),
  exact('spotlight', 'Spotlight', 'dark', { bg: ['#070707', '#0c0c0d', '#141416', '#1c1c1f', '#2a2a2e'], text: ['#ededee', '#b4b4b8', '#7c7c82', '#4f4f55'], accent: '#ff6363', accent2: '#ffb35c', mint: '#59d499', amber: '#ffc531', rose: '#ff6363', violet: '#cf9cff', syn: ['#6c6c72', '#ff6363', '#59d499', '#ffc531', '#56c2ff', '#cf9cff', '#ededee', '#b4b4b8', '#ff8a8a'], term: ['#2a2a2e', '#ff6363', '#59d499', '#ffc531', '#56c2ff', '#cf9cff', '#3fd5d5', '#ededee'] }, { glow: 1.1, glass: 0.65, blur: 28, ambience: 'aurora', ambienceStrength: 0.8, labels: 'plain', radius: 1.1 })
]

export const PRESETS: Theme[] = [...PRISM_PRESETS, ...EDITOR_PRESETS, ...AI_PRESETS]

/** How the gallery is laid out, and the one-line hint under some cards. */
export const PRESET_GROUPS: Array<{ title: string; ids: string[] }> = [
  { title: 'Prism, dark', ids: PRISM_PRESETS.filter((t) => t.look.kind === 'dark').map((t) => t.id) },
  { title: 'Prism, light', ids: PRISM_PRESETS.filter((t) => t.look.kind === 'light').map((t) => t.id) },
  { title: 'VS Code and GitHub', ids: EDITOR_PRESETS.slice(0, 6).map((t) => t.id) },
  { title: 'Editor favourites', ids: EDITOR_PRESETS.slice(6).map((t) => t.id) },
  { title: 'Like the AI apps', ids: AI_PRESETS.map((t) => t.id) }
]

export const PRESET_HINTS: Record<string, string> = {
  'vscode-dark-modern': 'VS Code',
  'vscode-dark-plus': 'VS Code, classic',
  'vscode-light-modern': 'VS Code',
  clay: 'Claude',
  'clay-night': 'Claude, dark',
  charcoal: 'ChatGPT',
  caret: 'Cursor',
  indigo: 'Linear',
  pitch: 'Vercel',
  twilight: 'Gemini',
  lagoon: 'Perplexity',
  spotlight: 'Raycast'
}

export const DEFAULT_THEME = PRISM_PRESETS[0]!

/** A stored theme may come from an older version or a hand-edited file: fill every gap from the default. */
export function sanitize(raw: unknown): Theme | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<Theme>
  if (typeof r.id !== 'string' || !r.id) return null
  const base = PRESETS.find((p) => p.id === r.base) ?? DEFAULT_THEME
  const colors = { ...base.colors }
  for (const k of Object.keys(colors) as Array<keyof ThemeColors>) {
    const v = (r.colors as Partial<ThemeColors> | undefined)?.[k]
    if (isHex(v)) colors[k] = v.toLowerCase()
  }
  const l = (r.look ?? {}) as Partial<ThemeLook>
  const num = (v: unknown, d: number, a: number, b: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d)
  const font = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() && !/[;{}<>]/.test(v) ? v.trim().slice(0, 80) : d)
  const look: ThemeLook = {
    kind: l.kind === 'light' ? 'light' : 'dark',
    fontUi: font(l.fontUi, DEFAULT_LOOK.fontUi),
    fontMono: font(l.fontMono, DEFAULT_LOOK.fontMono),
    radius: num(l.radius, 1, 0, 2.5),
    lines: num(l.lines, 1, 0, 3),
    glow: num(l.glow, 1, 0, 2.5),
    glass: num(l.glass, 0.5, 0, 1),
    blur: num(l.blur, 18, 0, 48),
    ambience: (['aurora', 'grid', 'mesh', 'stars', 'scanlines', 'plain', 'picture'] as const).includes(l.ambience as never) ? l.ambience! : 'aurora',
    ambienceStrength: num(l.ambienceStrength, 1, 0, 2.5),
    picture: typeof l.picture === 'string' && /^[\w.-]+$/.test(l.picture) ? l.picture : null,
    pictureDim: num(l.pictureDim, 0.55, 0, 0.95),
    pictureBlur: num(l.pictureBlur, 0, 0, 40),
    labels: l.labels === 'plain' ? 'plain' : 'caps'
  }
  return { id: r.id, name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : 'My theme', ...(typeof r.base === 'string' ? { base: r.base } : {}), colors, look }
}
