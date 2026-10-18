// A theme is everything about how Prism looks: every colour, the fonts, the
// shape of corners and borders, and the effects behind the panels. Built-in
// themes live in shared/themePresets.ts; the user's own are stored
// whole in settings.appearance.themes, and a theme file is this same object.

export interface ThemeColors {
  /** Surfaces, from the window backdrop (0) to the most raised element (4). */
  bg0: string
  bg1: string
  bg2: string
  bg3: string
  bg4: string
  /** Text, from the main colour to the faintest. */
  text: string
  text2: string
  text3: string
  text4: string
  accent: string
  accent2: string
  /** Status colours: good, warning, problem, extra. */
  mint: string
  amber: string
  rose: string
  violet: string
  /** Text on top of an accent-filled button. */
  onAccent: string
  synComment: string
  synKeyword: string
  synString: string
  synNumber: string
  synFunction: string
  synType: string
  synVariable: string
  synOperator: string
  synTag: string
  termBlack: string
  termRed: string
  termGreen: string
  termYellow: string
  termBlue: string
  termMagenta: string
  termCyan: string
  termWhite: string
}

export type Ambience = 'aurora' | 'grid' | 'mesh' | 'stars' | 'scanlines' | 'plain' | 'picture'

export interface ThemeLook {
  kind: 'dark' | 'light'
  /** Font family names; fallbacks are added when applied. */
  fontUi: string
  fontMono: string
  /** 0 = square corners, 1 = the default, 2 = very round. */
  radius: number
  /** Border strength: 0 = none, 1 = the default. */
  lines: number
  /** Glow strength: 0 = none, 1 = the default. */
  glow: number
  /** How see-through panels are: 0 = solid, 1 = very. */
  glass: number
  /** Blur behind see-through panels, in pixels. */
  blur: number
  ambience: Ambience
  /** 0 = barely there, 1 = the default, 2 = strong. */
  ambienceStrength: number
  /** File name of the background picture (kept in the app's data folder), when ambience is 'picture'. */
  picture: string | null
  /** How much the picture is darkened (or lightened, in a light theme): 0..1. */
  pictureDim: number
  pictureBlur: number
  /** Small headings: spaced capitals, or ordinary text. */
  labels: 'caps' | 'plain'
}

export interface Theme {
  id: string
  name: string
  builtin?: boolean
  /** The built-in theme a custom one started from, for "start over". */
  base?: string
  colors: ThemeColors
  look: ThemeLook
}

export const THEME_FILE_KIND = 'prism-theme'
export const THEME_PACK_KIND = 'prism-theme-pack'

/** What a theme file holds. */
export interface ThemeFile {
  kind: typeof THEME_FILE_KIND
  version: 1
  theme: Theme
  /** The background picture, when the theme has one, so the file is complete by itself. */
  picture?: { name: string; base64: string }
}

/** Several themes in one file, each as complete as a single theme file. */
export interface ThemePackFile {
  kind: typeof THEME_PACK_KIND
  version: 1
  themes: Array<{ theme: Theme; picture?: { name: string; base64: string } }>
}
