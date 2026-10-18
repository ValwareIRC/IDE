import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Download, FolderOpen, ImagePlus, Minus, Package, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { Ambience, Theme, ThemeColors, ThemeLook } from '@shared/theme'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { toastError, useUi } from '@/state/ui'
import { Select, type SelectOption } from '@/components/Select'
import { activeTheme, allThemes, applyTheme, sanitize } from '@/theme/apply'
import { isHex } from '@shared/color'
import { PRESETS, PRESET_GROUPS, PRESET_HINTS, buildColors } from '@shared/themePresets'
import { fontOptions as listFonts } from '@/lib/fonts'
import { cx } from '@/lib/format'

type ColorKey = keyof ThemeColors

const SURFACES: Array<[ColorKey, string]> = [
  ['bg0', 'Window'],
  ['bg1', 'Panels'],
  ['bg2', 'Boxes and menus'],
  ['bg3', 'Hovered'],
  ['bg4', 'Raised']
]
const TEXTS: Array<[ColorKey, string]> = [
  ['text', 'Main text'],
  ['text2', 'Softer text'],
  ['text3', 'Faint text'],
  ['text4', 'Faintest']
]
const ACCENTS: Array<[ColorKey, string]> = [
  ['accent', 'Main accent'],
  ['accent2', 'Second accent'],
  ['onAccent', 'Text on buttons'],
  ['mint', 'Good'],
  ['amber', 'Warning'],
  ['rose', 'Problem'],
  ['violet', 'Extra']
]
const CODE: Array<[ColorKey, string]> = [
  ['synVariable', 'Plain code'],
  ['synKeyword', 'Keywords'],
  ['synFunction', 'Functions'],
  ['synType', 'Types'],
  ['synString', 'Text in quotes'],
  ['synNumber', 'Numbers'],
  ['synComment', 'Comments'],
  ['synOperator', 'Symbols'],
  ['synTag', 'Tags']
]
const TERMINAL: Array<[ColorKey, string]> = [
  ['termBlack', 'Black'],
  ['termRed', 'Red'],
  ['termGreen', 'Green'],
  ['termYellow', 'Yellow'],
  ['termBlue', 'Blue'],
  ['termMagenta', 'Magenta'],
  ['termCyan', 'Cyan'],
  ['termWhite', 'White']
]
const AMBIENCES: Array<{ value: Ambience; label: string; sub: string }> = [
  { value: 'aurora', label: 'Aurora', sub: 'Two soft lights and a faint grid' },
  { value: 'mesh', label: 'Colour pools', sub: 'Every theme colour, blended in the corners' },
  { value: 'grid', label: 'Floor grid', sub: 'Lines running to the horizon' },
  { value: 'stars', label: 'Stars', sub: 'A scattering of small lights' },
  { value: 'scanlines', label: 'Screen lines', sub: 'Like an old monitor' },
  { value: 'picture', label: 'A picture', sub: 'Any image of yours' },
  { value: 'plain', label: 'Nothing', sub: 'Just the window colour' }
]

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): React.JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <label className="color-field">
      <span className="chip-color" style={{ background: value }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      </span>
      <span className="cf-label">{label}</span>
      <input
        className="cf-hex mono"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value.trim()
          setText(v)
          const full = v.startsWith('#') ? v : `#${v}`
          if (isHex(full)) onChange(full.toLowerCase())
        }}
        onBlur={() => setText(value)}
      />
    </label>
  )
}

function Slider({ label, hint, value, min, max, step, show, onChange }: { label: string; hint?: string; value: number; min: number; max: number; step: number; show?: (v: number) => string; onChange: (v: number) => void }): React.JSX.Element {
  return (
    <div className="setting-row">
      <div className="l">
        <div className="t">{label}</div>
        {hint && <div className="d">{hint}</div>}
      </div>
      <input className="range" type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="range-value mono">{show ? show(value) : value}</span>
    </div>
  )
}

function Group({ title, hint, open, onToggle, children }: { title: string; hint: string; open: boolean; onToggle: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={cx('theme-group', open && 'open')}>
      <button className="theme-group-head" onClick={onToggle}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="t">{title}</span>
        <span className="d">{hint}</span>
      </button>
      {open && <div className="theme-group-body">{children}</div>}
    </div>
  )
}

/** A small drawing of the app in a theme's colours. */
function Mini({ t }: { t: Theme }): React.JSX.Element {
  const c = t.colors
  const r = Math.round(4 * t.look.radius)
  const line = t.look.kind === 'dark' ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.11)'
  return (
    <div className="theme-mini" style={{ background: c.bg0 }}>
      <div className="tm-rail">
        <i style={{ background: c.accent }} />
        <i style={{ background: c.text3 }} />
        <i style={{ background: c.text3 }} />
      </div>
      <div className="tm-panel" style={{ background: c.bg1, borderColor: line, borderRadius: r }}>
        <b style={{ background: c.synKeyword, width: '34%' }} />
        <b style={{ background: c.synFunction, width: '58%' }} />
        <b style={{ background: c.synString, width: '46%' }} />
        <b style={{ background: c.text3, width: '30%' }} />
      </div>
      <div className="tm-panel side" style={{ background: c.bg1, borderColor: line, borderRadius: r }}>
        <b style={{ background: c.text, width: '70%' }} />
        <b style={{ background: c.text2, width: '50%' }} />
        <em style={{ background: c.accent, borderRadius: Math.max(2, r) }} />
      </div>
      <div className="tm-dots">
        <i style={{ background: c.accent }} />
        <i style={{ background: c.accent2 }} />
        <i style={{ background: c.mint }} />
        <i style={{ background: c.amber }} />
        <i style={{ background: c.rose }} />
      </div>
    </div>
  )
}

export function ThemeStudio(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const themes = useMemo(() => allThemes(settings), [settings])
  const saved = useMemo(() => activeTheme(settings), [settings])
  // what is on screen while a slider or colour is being dragged; written to settings a moment later
  const [draft, setDraft] = useState<Theme>(saved)
  const [open, setOpen] = useState<string>('quick')
  const [fonts, setFonts] = useState<string[]>([])
  const [zoom, setZoom] = useState<number | null>(null)
  const timer = useRef<number | null>(null)
  const pending = useRef<Theme | null>(null)

  useEffect(() => {
    if (!pending.current) setDraft(saved)
  }, [saved])

  useEffect(() => {
    void prism.themes.fonts().then(setFonts).catch(() => {})
    void prism.win.zoom(Number.NaN).then((z) => setZoom(Math.round(z))).catch(() => {})
    return () => flush()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!settings) return <></>
  const own = themes.filter((t) => !t.builtin)
  const glowOn = settings.appearance.glow

  const store = (t: Theme, list: Theme[] = own): Promise<void> => update({ appearance: { theme: t.id, themes: t.builtin ? list : [...list.filter((x) => x.id !== t.id), t], bg: t.colors.bg0 } })

  function flush(): void {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    const t = pending.current
    pending.current = null
    if (t) void store(t).catch(toastError)
  }

  /** Change the theme on screen. A built-in theme is never changed itself: the first edit makes a copy of it. */
  const edit = (change: (t: Theme) => Theme): void => {
    const from = draft.builtin ? { ...draft, builtin: undefined, id: `my-${Date.now().toString(36)}`, name: `My ${draft.name}`, base: draft.id } : draft
    const next = change(from)
    setDraft(next)
    applyTheme(next, { glow: glowOn })
    pending.current = next
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, 350)
  }
  const color = (k: ColorKey, v: string): void => edit((t) => ({ ...t, colors: { ...t.colors, [k]: v } }))
  const look = (p: Partial<ThemeLook>): void => edit((t) => ({ ...t, look: { ...t.look, ...p } }))
  /** The quick picks: everything else is worked out again from these. */
  const rebuild = (p: { kind?: 'dark' | 'light'; bg?: string; accent?: string; accent2?: string }): void =>
    edit((t) => {
      const kind = p.kind ?? t.look.kind
      // switching between dark and light needs a backdrop of the other sort
      const bg = p.bg ?? (p.kind && p.kind !== t.look.kind ? (p.kind === 'light' ? '#eceef2' : '#07080c') : t.colors.bg0)
      return { ...t, colors: buildColors({ kind, bg, accent: p.accent ?? t.colors.accent, accent2: p.accent2 ?? t.colors.accent2 }), look: { ...t.look, kind } }
    })

  const choose = (t: Theme): void => {
    flush()
    setDraft(t)
    applyTheme(t, { glow: glowOn })
    void update({ appearance: { theme: t.id, bg: t.colors.bg0 } }).catch(toastError)
  }

  const duplicate = (): void => {
    flush()
    const copy: Theme = { ...draft, builtin: undefined, id: `my-${Date.now().toString(36)}`, name: draft.builtin ? `My ${draft.name}` : `${draft.name} copy`, base: draft.base ?? (draft.builtin ? draft.id : undefined) }
    setDraft(copy)
    void store(copy).catch(toastError)
  }

  const remove = (): void => {
    if (draft.builtin || !window.confirm(`Delete the theme "${draft.name}"?`)) return
    pending.current = null
    if (timer.current) window.clearTimeout(timer.current)
    const back = PRESETS.find((p) => p.id === draft.base) ?? PRESETS[0]!
    setDraft(back)
    applyTheme(back, { glow: glowOn })
    void update({ appearance: { theme: back.id, themes: own.filter((x) => x.id !== draft.id), bg: back.colors.bg0 } }).catch(toastError)
  }

  const startOver = (): void => {
    const base = PRESETS.find((p) => p.id === draft.base)
    if (!base || draft.builtin) return
    edit((t) => ({ ...t, colors: base.colors, look: base.look }))
  }

  const importTheme = async (): Promise<void> => {
    try {
      const raw = await prism.themes.import()
      if (!raw) return
      const stamp = Date.now().toString(36)
      const got = raw.map((r, i) => sanitize({ ...r, id: `my-${stamp}${i || ''}`, builtin: undefined })).filter((t): t is Theme => !!t)
      const t = got[0]
      if (!t) throw new Error('That file is not a Prism theme.')
      flush()
      setDraft(t)
      applyTheme(t, { glow: glowOn })
      // a pack brings several at once; the first one is put on
      await update({ appearance: { theme: t.id, themes: [...own, ...got], bg: t.colors.bg0 } })
      useUi.getState().toast('success', got.length === 1 ? `Added "${t.name}"` : `Added ${got.length} themes`, got.length === 1 ? 'It is in Your themes.' : 'They are in Your themes.')
    } catch (e) {
      toastError(e)
    }
  }

  const exportTheme = async (): Promise<void> => {
    try {
      flush()
      if (await prism.themes.export(draft)) useUi.getState().toast('success', 'Theme saved', 'Anyone with Prism can open this file from the same page.')
    } catch (e) {
      toastError(e)
    }
  }

  const exportPack = async (): Promise<void> => {
    try {
      flush()
      const mine = [...own.filter((t) => t.id !== draft.id), ...(draft.builtin ? [] : [draft])]
      if (await prism.themes.exportAll(mine)) useUi.getState().toast('success', `Saved ${mine.length} themes as a pack`, 'Opening that file in Prism adds them all.')
    } catch (e) {
      toastError(e)
    }
  }

  const pickPicture = async (): Promise<void> => {
    try {
      const name = await prism.themes.pickPicture()
      if (name) look({ ambience: 'picture', picture: name })
    } catch (e) {
      toastError(e)
    }
  }

  const fontOptions = (mono: boolean): Array<SelectOption<string>> => listFonts(fonts, mono)

  const c = draft.colors
  const k = draft.look
  const toggle = (id: string) => () => setOpen((o) => (o === id ? '' : id))
  const pct = (v: number): string => `${Math.round(v * 100)}%`
  const grid = (list: Array<[ColorKey, string]>): React.JSX.Element => (
    <div className="color-grid">
      {list.map(([key, label]) => (
        <ColorField key={key} label={label} value={c[key]} onChange={(v) => color(key, v)} />
      ))}
    </div>
  )
  const card = (t: Theme): React.JSX.Element => (
    <button key={t.id} className={cx('theme-card', draft.id === t.id && 'on')} onClick={() => choose(t)} title={t.name}>
      <Mini t={draft.id === t.id ? draft : t} />
      <span className="theme-name">{draft.id === t.id ? draft.name : t.name}</span>
      {PRESET_HINTS[t.id] && <span className="theme-hint">like {PRESET_HINTS[t.id]}</span>}
    </button>
  )

  return (
    <>
      <h2>Appearance</h2>
      <div className="lead">Pick a theme, then change anything about it. Changing a built-in theme makes your own copy; the original stays as it is.</div>

      <div className="settings-section">
        <div className="theme-bar">
          <h3>Your themes</h3>
          <span className="grow" />
          <button className="btn sm" onClick={duplicate}>
            <Plus size={12} /> New from this one
          </button>
          <button className="btn sm" onClick={() => void importTheme()} title="A single theme, or a pack of several">
            <FolderOpen size={12} /> Open a theme file
          </button>
          {own.filter((t) => t.id !== draft.id).length + (draft.builtin ? 0 : 1) > 1 && (
            <button className="btn sm" onClick={() => void exportPack()} title="All of your themes in one file, to share or move to another computer">
              <Package size={12} /> Save all as a pack
            </button>
          )}
        </div>
        {own.length || !draft.builtin ? (
          <div className="theme-grid">{[...own.filter((t) => t.id !== draft.id), ...(draft.builtin ? [] : [draft])].sort((a, b) => a.name.localeCompare(b.name)).map(card)}</div>
        ) : (
          <div className="faint small" style={{ padding: '2px 2px 10px' }}>
            None yet. Change anything below and your first one appears here.
          </div>
        )}
        {PRESET_GROUPS.map((g) => (
          <Fragment key={g.title}>
            <h3>{g.title}</h3>
            <div className="theme-grid">{g.ids.map((id) => PRESETS.find((t) => t.id === id)).filter((t): t is Theme => !!t).map(card)}</div>
          </Fragment>
        ))}
      </div>

      <div className="settings-section">
        <div className="theme-bar">
          <h3>Make it yours</h3>
          <input className="input sm theme-rename" value={draft.name} disabled={!!draft.builtin} title={draft.builtin ? 'Change something below first; that makes your own copy to name' : 'Name of this theme'} onChange={(e) => edit((t) => ({ ...t, name: e.target.value.slice(0, 40) }))} />
          <span className="grow" />
          {!draft.builtin && draft.base && (
            <button className="btn sm" onClick={startOver} title={`Back to how ${PRESETS.find((p) => p.id === draft.base)?.name ?? 'the original'} looks`}>
              <RotateCcw size={12} /> Start over
            </button>
          )}
          <button className="btn sm" onClick={duplicate}>
            <Copy size={12} /> Duplicate
          </button>
          <button className="btn sm" onClick={() => void exportTheme()}>
            <Download size={12} /> Save as a file
          </button>
          {!draft.builtin && (
            <button className="btn sm danger" onClick={remove}>
              <Trash2 size={12} /> Delete
            </button>
          )}
        </div>

        <Group title="Quick colours" hint="Three picks; every other colour is worked out from them" open={open === 'quick'} onToggle={toggle('quick')}>
          <div className="setting-row">
            <div className="l">
              <div className="t">Dark or light</div>
            </div>
            <div className="seg">
              {(['dark', 'light'] as const).map((d) => (
                <button key={d} className={cx(k.kind === d && 'on')} onClick={() => k.kind !== d && rebuild({ kind: d })}>
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div className="color-grid">
            <ColorField label="Background" value={c.bg0} onChange={(v) => rebuild({ bg: v })} />
            <ColorField label="Main accent" value={c.accent} onChange={(v) => rebuild({ accent: v })} />
            <ColorField label="Second accent" value={c.accent2} onChange={(v) => rebuild({ accent2: v })} />
          </div>
          <div className="faint small">These three replace every colour in the sections below, so use them first and fine-tune afterwards.</div>
        </Group>

        <Group title="Surfaces and text" hint="The window, panels, boxes, and the four strengths of text" open={open === 'surfaces'} onToggle={toggle('surfaces')}>
          {grid(SURFACES)}
          {grid(TEXTS)}
        </Group>

        <Group title="Accents and signals" hint="Highlights, buttons, and the colours for good, warning and problem" open={open === 'accents'} onToggle={toggle('accents')}>
          {grid(ACCENTS)}
          <div className="theme-sample">
            <button className="btn sm solid">A button</button>
            <span className="chip accent">accent</span>
            <span className="chip violet">extra</span>
            <span className="mint">good</span>
            <span className="amber">warning</span>
            <span className="rose">problem</span>
          </div>
        </Group>

        <Group title="Code colours" hint="The editor and code in the conversation" open={open === 'code'} onToggle={toggle('code')}>
          {grid(CODE)}
          <pre className="theme-sample code mono" style={{ color: c.synVariable }}>
            <span style={{ color: c.synComment, fontStyle: 'italic' }}>{'// greet someone by name\n'}</span>
            <span style={{ color: c.synKeyword }}>function</span> <span style={{ color: c.synFunction }}>greet</span>
            <span style={{ color: c.synOperator }}>(</span>name<span style={{ color: c.synOperator }}>:</span> <span style={{ color: c.synType }}>string</span>
            <span style={{ color: c.synOperator }}>{') {\n'}</span>
            {'  '}
            <span style={{ color: c.synKeyword }}>return</span> <span style={{ color: c.synString }}>'Hello, '</span> <span style={{ color: c.synOperator }}>+</span> name <span style={{ color: c.synOperator }}>+</span>{' '}
            <span style={{ color: c.synNumber }}>42</span>
            {'\n'}
            <span style={{ color: c.synOperator }}>{'}'}</span>
            {'\n'}
            <span style={{ color: c.synOperator }}>{'<'}</span>
            <span style={{ color: c.synTag }}>button</span>
            <span style={{ color: c.synOperator }}>{'>'}</span>
          </pre>
        </Group>

        <Group title="Terminal colours" hint="The eight colours programs use in the terminal" open={open === 'terminal'} onToggle={toggle('terminal')}>
          {grid(TERMINAL)}
          <pre className="theme-sample code mono" style={{ color: c.text }}>
            <span style={{ color: c.termGreen }}>valerie</span>
            <span style={{ color: c.text3 }}>@</span>
            <span style={{ color: c.termBlue }}>prism</span> <span style={{ color: c.termMagenta }}>~/project</span> <span style={{ color: c.termYellow }}>(main)</span>
            {'\n$ npm test\n'}
            <span style={{ color: c.termGreen }}>✓ 12 passed</span> <span style={{ color: c.termRed }}>✗ 1 failed</span> <span style={{ color: c.termCyan }}>3 skipped</span>
          </pre>
        </Group>

        <Group title="Fonts and size" hint="Lettering for the interface and for code" open={open === 'fonts'} onToggle={toggle('fonts')}>
          <div className="setting-row">
            <div className="l">
              <div className="t">Interface font</div>
              <div className="d">Menus, panels and the conversation.</div>
            </div>
            <Select value={k.fontUi} options={fontOptions(false)} searchable width={300} align="right" onChange={(v) => look({ fontUi: v })} />
          </div>
          <div className="setting-row">
            <div className="l">
              <div className="t">Code font</div>
              <div className="d">The editor, the terminal and code in the conversation.</div>
            </div>
            <Select value={k.fontMono} options={fontOptions(true)} searchable width={300} align="right" onChange={(v) => look({ fontMono: v })} />
          </div>
          <div className="setting-row">
            <div className="l">
              <div className="t">Size of everything</div>
              <div className="d">Makes the whole window larger or smaller. The editor's own text size is under Editor & terminal.</div>
            </div>
            <div className="zoomer">
              <button className="icon-btn sm" title="Smaller" onClick={() => void prism.win.zoom(-1).then(setZoom)}>
                <Minus size={13} />
              </button>
              <span className="mono small">{zoom === null ? '' : `${Math.round(100 * 1.2 ** zoom)}%`}</span>
              <button className="icon-btn sm" title="Larger" onClick={() => void prism.win.zoom(1).then(setZoom)}>
                <Plus size={13} />
              </button>
              <button className="btn sm" onClick={() => void prism.win.zoom(0).then(setZoom)}>
                Reset
              </button>
            </div>
          </div>
        </Group>

        <Group title="Shape" hint="Corners, borders, headings and spacing" open={open === 'shape'} onToggle={toggle('shape')}>
          <Slider label="Corners" hint="From square to very round." value={k.radius} min={0} max={2.5} step={0.05} show={(v) => (v === 0 ? 'square' : pct(v))} onChange={(v) => look({ radius: v })} />
          <Slider label="Borders" hint="How strongly panels and boxes are outlined." value={k.lines} min={0} max={3} step={0.05} show={(v) => (v === 0 ? 'none' : pct(v))} onChange={(v) => look({ lines: v })} />
          <div className="setting-row">
            <div className="l">
              <div className="t">Small headings</div>
            </div>
            <div className="seg">
              <button className={cx(k.labels === 'caps' && 'on')} onClick={() => look({ labels: 'caps' })}>
                CAPITALS
              </button>
              <button className={cx(k.labels === 'plain' && 'on')} onClick={() => look({ labels: 'plain' })}>
                Plain
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div className="l">
              <div className="t">Spacing</div>
              <div className="d">Applies to every theme.</div>
            </div>
            <div className="seg">
              {(['comfortable', 'compact'] as const).map((d) => (
                <button key={d} className={cx(settings.appearance.density === d && 'on')} onClick={() => void update({ appearance: { density: d } }).catch(toastError)}>
                  {d}
                </button>
              ))}
            </div>
          </div>
        </Group>

        <Group title="Light and background" hint="Glow, see-through panels, and what sits behind them" open={open === 'effects'} onToggle={toggle('effects')}>
          <Slider label="Glow" hint="Soft light around what is active or focused." value={k.glow} min={0} max={2.5} step={0.05} show={(v) => (v === 0 ? 'off' : pct(v))} onChange={(v) => {
            look({ glow: v })
            if (!glowOn && v > 0) void update({ appearance: { glow: true } }).catch(toastError)
          }} />
          <Slider label="See-through panels" hint="How much of the background shows through." value={k.glass} min={0} max={1} step={0.02} show={(v) => (v === 0 ? 'solid' : pct(v))} onChange={(v) => look({ glass: v })} />
          <Slider label="Blur behind panels" value={k.blur} min={0} max={48} step={1} show={(v) => (v === 0 ? 'none' : `${v}px`)} onChange={(v) => look({ blur: v })} />
          <div className="setting-row">
            <div className="l">
              <div className="t">Background</div>
              <div className="d">What sits behind all the panels.</div>
            </div>
            <Select value={k.ambience} options={AMBIENCES} width={300} align="right" onChange={(v) => (v === 'picture' && !k.picture ? void pickPicture() : look({ ambience: v }))} />
          </div>
          {k.ambience === 'picture' ? (
            <>
              <div className="setting-row">
                <div className="l">
                  <div className="t">Picture</div>
                  <div className="d">Prism keeps its own copy, so the original can be moved or deleted.</div>
                </div>
                <button className="btn sm" onClick={() => void pickPicture()}>
                  <ImagePlus size={12} /> Choose another
                </button>
              </div>
              <Slider label="Wash" hint="Fades the picture towards the window colour so text stays readable." value={k.pictureDim} min={0} max={0.95} step={0.01} show={pct} onChange={(v) => look({ pictureDim: v })} />
              <Slider label="Picture blur" value={k.pictureBlur} min={0} max={40} step={1} show={(v) => (v === 0 ? 'sharp' : `${v}px`)} onChange={(v) => look({ pictureBlur: v })} />
            </>
          ) : (
            k.ambience !== 'plain' && <Slider label="Background strength" value={k.ambienceStrength} min={0} max={2.5} step={0.05} show={pct} onChange={(v) => look({ ambienceStrength: v })} />
          )}
          <div className="setting-row">
            <div className="l">
              <div className="t">Motion</div>
              <div className="d">Transitions and live pulses. Applies to every theme.</div>
            </div>
            <button className={cx('switch', settings.appearance.motion && 'on')} role="switch" aria-checked={settings.appearance.motion} onClick={() => void update({ appearance: { motion: !settings.appearance.motion } }).catch(toastError)} />
          </div>
        </Group>
      </div>
    </>
  )
}
