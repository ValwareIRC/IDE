import type { Theme, ThemeColors, ThemeLook } from '@shared/theme'
import type { Settings, SettingsPatch } from '@shared/types'
import { contrast, isHex, luminance } from '@shared/color'
import { DEFAULT_THEME, PRESETS, buildColors, sanitize } from '@shared/themePresets'
import { err, str, type AgentTool } from './types'

export interface ThemeHost {
  active(): Theme
  all(): Array<Theme & { own: boolean }>
  /** Store it with the user's own themes (replacing one with the same id) and switch to it. */
  save(theme: Theme): void
  use(id: string): void
}

export function settingsThemeHost(store: { get(): Settings; update(p: SettingsPatch): unknown }): ThemeHost {
  const own = (): Theme[] => store.get().appearance.themes.map(sanitize).filter((t): t is Theme => !!t && !PRESETS.some((p) => p.id === t.id))
  const all = (): Array<Theme & { own: boolean }> => [...PRESETS.map((t) => ({ ...t, own: false })), ...own().map((t) => ({ ...t, own: true }))]
  return {
    all,
    active: () => all().find((t) => t.id === store.get().appearance.theme) ?? DEFAULT_THEME,
    save: (theme) => store.update({ appearance: { themes: [...own().filter((t) => t.id !== theme.id), theme], theme: theme.id, bg: theme.colors.bg0 } }),
    use: (id) => {
      const t = all().find((x) => x.id === id)
      if (t) store.update({ appearance: { theme: t.id, bg: t.colors.bg0 } })
    }
  }
}

const SEED_KEYS = ['accent', 'accent2', 'text', 'mint', 'amber', 'rose', 'violet'] as const
const LOOK_KEYS: Array<keyof ThemeLook> = ['fontUi', 'fontMono', 'radius', 'lines', 'glow', 'glass', 'blur', 'ambience', 'ambienceStrength', 'labels']

export function createThemeTool(host: ThemeHost): AgentTool {
  return {
    spec: {
      name: 'set_theme',
      description:
        "Change how Prism itself looks. Either switch to an existing theme (`use`: an id or name; `use: \"list\"` lists them all), or design a new one and switch to it. To design one: give a name and a backdrop colour `bg`, `accent` and `accent2`; every other colour is worked out from those, and `text`, `mint` (good), `amber` (warning), `rose` (problem) and `violet` can be set too. `base` starts from an existing theme instead of the current one. `colors` sets any of the 33 colours exactly (bg0-bg4 backdrop to most raised, text/text2/text3/text4, accent, accent2, mint, amber, rose, violet, onAccent, synComment, synKeyword, synString, synNumber, synFunction, synType, synVariable, synOperator, synTag, termBlack, termRed, termGreen, termYellow, termBlue, termMagenta, termCyan, termWhite). `look` sets the feel: fontUi, fontMono (font names; bundled: Inter Variable, Nunito Variable, Space Grotesk Variable, JetBrains Mono Variable), radius (0 square to 2.5 very round, 1 default), lines (border strength 0-3), glow (0-2.5), glass (0 solid to 1 see-through), blur (0-48 px), ambience (aurora, grid, mesh, stars, scanlines, plain), ambienceStrength (0-2.5), labels (caps or plain). All colours are #rrggbb. Calling again with the same name replaces that theme.",
      parameters: {
        type: 'object',
        properties: {
          use: { type: 'string', description: 'Switch to this existing theme (id or name), or "list"' },
          name: { type: 'string' },
          base: { type: 'string', description: 'Existing theme to start from (id or name)' },
          kind: { type: 'string', enum: ['dark', 'light'] },
          bg: { type: 'string' },
          accent: { type: 'string' },
          accent2: { type: 'string' },
          text: { type: 'string' },
          mint: { type: 'string' },
          amber: { type: 'string' },
          rose: { type: 'string' },
          violet: { type: 'string' },
          colors: { type: 'object', description: 'Exact colours by name' },
          look: { type: 'object', description: 'fontUi, fontMono, radius, lines, glow, glass, blur, ambience, ambienceStrength, labels' }
        }
      }
    },
    primaryArg: 'name',
    readOnly: false,
    risk: () => null,
    summary: (a) => (str(a, 'use') ? `theme: ${str(a, 'use')}` : `theme: ${str(a, 'name') || 'new'}`),
    async execute(args) {
      const all = host.all()
      const find = (q: string): (Theme & { own: boolean }) | undefined => {
        const k = q.trim().toLowerCase()
        return all.find((t) => t.id === k) ?? all.find((t) => t.name.toLowerCase() === k)
      }
      const use = str(args, 'use').trim()
      if (use.toLowerCase() === 'list') {
        const active = host.active().id
        return { content: all.map((t) => `${t.id === active ? '* ' : '  '}${t.id} · ${t.name} (${t.look.kind}${t.own ? ', the user\'s own' : ''})`).join('\n'), isError: false }
      }
      if (use) {
        const t = find(use)
        if (!t) return err(`No theme called "${use}". Call set_theme with use: "list" to see them.`)
        host.use(t.id)
        return { content: `Switched Prism to ${t.name}.`, isError: false }
      }

      const name = str(args, 'name').trim().slice(0, 40)
      if (!name) return err('Give the new theme a name, or use: "<theme>" to switch to an existing one.')
      const baseQ = str(args, 'base').trim()
      const start = baseQ ? find(baseQ) : host.active()
      if (!start) return err(`No theme called "${baseQ}" to start from.`)
      const bad: string[] = []
      const hex = (k: string, v: unknown): string | undefined => {
        if (v === undefined || v === null || v === '') return undefined
        const s = String(v).trim().toLowerCase()
        const full = /^#[0-9a-f]{3}$/.test(s) ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s
        if (isHex(full)) return full
        bad.push(`${k}: "${String(v)}" is not a #rrggbb colour`)
        return undefined
      }

      let colors: ThemeColors = { ...start.colors }
      const bg = hex('bg', args['bg'])
      const seed = Object.fromEntries(SEED_KEYS.map((k) => [k, hex(k, args[k])]).filter(([, v]) => v)) as Partial<Record<(typeof SEED_KEYS)[number], string>>
      const kindArg = str(args, 'kind')
      const kind: 'dark' | 'light' = kindArg === 'dark' || kindArg === 'light' ? kindArg : bg ? (luminance(bg) > 0.4 ? 'light' : 'dark') : start.look.kind
      if (bg || Object.keys(seed).length || kind !== start.look.kind) {
        colors = buildColors({ kind, bg: bg ?? colors.bg0, accent: seed.accent ?? colors.accent, accent2: seed.accent2 ?? colors.accent2, text: seed.text, mint: seed.mint, amber: seed.amber, rose: seed.rose, violet: seed.violet })
      }
      const exact = args['colors'] && typeof args['colors'] === 'object' ? (args['colors'] as Record<string, unknown>) : {}
      for (const [k, v] of Object.entries(exact)) {
        if (!(k in colors)) bad.push(`colors.${k}: there is no colour by that name`)
        else {
          const h = hex(`colors.${k}`, v)
          if (h) colors[k as keyof ThemeColors] = h
        }
      }
      const lookArg = args['look'] && typeof args['look'] === 'object' ? (args['look'] as Record<string, unknown>) : {}
      for (const k of Object.keys(lookArg)) if (!LOOK_KEYS.includes(k as keyof ThemeLook)) bad.push(`look.${k}: not something a theme can set`)
      if (bad.length) return err(`Nothing was changed. Fix these and call set_theme again:\n${bad.join('\n')}`)

      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'theme'
      const theme = sanitize({ id: `ai-${slug}`, name, base: PRESETS.some((p) => p.id === start.id) ? start.id : start.base, colors, look: { ...start.look, picture: null, ...(start.look.ambience === 'picture' ? { ambience: 'aurora' } : {}), ...lookArg, kind } })
      if (!theme) return err('That theme could not be made.')
      host.save(theme)

      const c = theme.colors
      const notes: string[] = []
      const check = (what: string, fg: string, bgc: string, min: number): void => {
        const r = contrast(fg, bgc)
        if (r < min) notes.push(`${what} is hard to read (${r.toFixed(1)}:1, aim for ${min}:1)`)
      }
      check('main text on panels', c.text, c.bg1, 7)
      check('secondary text', c.text2, c.bg1, 4.5)
      check('the accent', c.accent, c.bg1, 3)
      check('text on accent buttons', c.onAccent, c.accent, 4.5)
      check('code', c.synVariable, c.bg1, 4.5)
      check('comments', c.synComment, c.bg1, 2.5)
      return {
        content: `Prism now uses "${theme.name}" (${theme.look.kind}). It is saved with the user's own themes in Settings, Appearance, where they can change anything about it.${notes.length ? `\nWorth fixing:\n- ${notes.join('\n- ')}` : '\nEverything is easy to read.'}`,
        isError: false
      }
    }
  }
}
