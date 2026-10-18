import { useEffect, useRef, useState } from 'react'
import { currentTheme, fontStack, onTheme, terminalTheme } from '@/theme/apply'
import { Eraser, Plus, SendHorizonal, Sparkles, Trash2 } from 'lucide-react'
import { ContextMenu, type MenuEntry } from '@/components/ContextMenu'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { prism } from '@/lib/ipc'
import { consoleBuffer, consoleClear, consoleSubscribe } from '@/lib/agentConsole'
import { useTerminals } from '@/state/terminals'
import { useSessions } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { useApp } from '@/state/app'
import { cx } from '@/lib/format'
import { report } from '@/demo/bus'
import { fontReady } from '@/lib/fonts'

const AGENT_TAB = '__agent__'
const liveTerminals = new Map<string, Terminal>()

/** The last screenful of a terminal, trimmed, for handing to the agent. */
function tailOf(term: Terminal, lines = 60): string {
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = Math.max(0, buf.length - lines); i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '')
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function sendTerminalToAgent(id: string): void {
  const term = liveTerminals.get(id)
  if (!term) return
  const text = tailOf(term)
  if (!text) return
  const draft = `Here is my terminal output. Explain what went wrong and fix it if it is in this project.\n\n\`\`\`\n${text.slice(-6000)}\n\`\`\`\n`
  useLayout.getState().openAgent()
  const st = useSessions.getState()
  if (st.active) st.setDraft(st.active, draft)
}

/** The terminal's font: its own setting, else the theme's code font. */
function terminalFont(): string {
  return useApp.getState().settings?.terminal.fontFamily?.trim() || currentTheme().look.fontMono
}

// every open terminal follows the app's theme
onTheme((theme) => {
  for (const term of liveTerminals.values()) {
    term.options.theme = terminalTheme(theme)
    term.options.fontFamily = fontStack(terminalFont(), true)
    // the drawn letters are cached per colour and font
    term.clearTextureAtlas()
    term.refresh(0, term.rows - 1)
  }
})

function makeTerminal(fontSize: number, interactive: boolean): Terminal {
  const t = useApp.getState().settings?.terminal
  return new Terminal({
    fontFamily: fontStack(terminalFont(), true),
    fontSize,
    lineHeight: Math.max(0.8, Math.min(2, t?.lineHeight ?? 1)),
    cursorBlink: interactive && (t?.cursorBlink ?? true),
    cursorStyle: t?.cursorStyle ?? 'bar',
    cursorInactiveStyle: interactive ? 'outline' : 'none',
    disableStdin: !interactive,
    scrollback: Math.max(100, Math.min(200_000, t?.scrollback ?? 8000)),
    allowProposedApi: true,
    theme: terminalTheme(currentTheme())
  })
}

export function TerminalPanel(): React.JSX.Element {
  const list = useTerminals((s) => s.list)
  const active = useTerminals((s) => s.active)
  const refresh = useTerminals((s) => s.refresh)
  const create = useTerminals((s) => s.create)
  const kill = useTerminals((s) => s.kill)
  const setActive = useTerminals((s) => s.setActive)
  const workspace = useApp((s) => s.workspace)
  const agentRunning = useSessions((s) => Object.values(s.live).some((l) => l.running))

  useEffect(() => {
    void refresh().then(() => {
      if (useTerminals.getState().list.length === 0) void create()
    })
  }, [refresh, create])

  const current = active ?? (list[0]?.id ?? AGENT_TAB)

  return (
    <div className="term-panel">
      <div className="term-tabs">
        <button className={cx('term-tab', current === AGENT_TAB && 'on')} onClick={() => setActive(AGENT_TAB)} title="Everything the agent runs, live">
          <Sparkles size={12} className={agentRunning ? 'accent' : undefined} />
          agent
          {agentRunning && <span className="dot live" style={{ width: 5, height: 5 }} />}
        </button>
        {list.map((t) => (
          <button key={t.id} className={cx('term-tab', t.id === current && 'on')} onClick={() => setActive(t.id)} title={t.cwd}>
            <span className="dot" />
            {t.title}
            <span
              className="term-tab-x"
              onClick={(e) => {
                e.stopPropagation()
                void kill(t.id)
              }}
            >
              <Trash2 size={11} />
            </span>
          </button>
        ))}
        <button className="icon-btn sm" title="New terminal" onClick={() => void create({ cwd: workspace ? '.' : undefined })}>
          <Plus size={14} />
        </button>
        <span className="grow" />
        {current === AGENT_TAB ? (
          <button className="icon-btn sm" title="Clear" onClick={consoleClear}>
            <Eraser size={13} />
          </button>
        ) : (
          <button className="btn sm ghost" title="Send the last screen of this terminal to the agent" onClick={() => sendTerminalToAgent(current)}>
            <SendHorizonal size={12} /> to agent
          </button>
        )}
      </div>
      <div className="term-body">
        <AgentConsole visible={current === AGENT_TAB} />
        {list.map((t) => (
          <XtermView key={t.id} id={t.id} visible={t.id === current} />
        ))}
      </div>
    </div>
  )
}

function useFit(host: React.RefObject<HTMLDivElement | null>, termRef: React.RefObject<Terminal | null>, fitRef: React.RefObject<FitAddon | null>, visible: boolean): void {
  useEffect(() => {
    if (!host.current) return
    const ro = new ResizeObserver(() => {
      if (host.current && host.current.offsetWidth > 0) {
        try {
          fitRef.current?.fit()
        } catch {
          /* hidden */
        }
      }
    })
    ro.observe(host.current)
    return () => ro.disconnect()
  }, [host, fitRef])
  useEffect(() => {
    if (!visible) return
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
        termRef.current?.scrollToBottom()
      } catch {
        /* hidden */
      }
    }, 20)
    return () => clearTimeout(t)
  }, [visible, fitRef, termRef])
}

/** Read-only mirror of the agent's shell activity. */
function AgentConsole({ visible }: { visible: boolean }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const settings = useApp((s) => s.settings)
  useFit(host, termRef, fitRef, visible)

  useEffect(() => {
    if (!host.current) return
    const term = makeTerminal(settings?.terminal.fontSize ?? 13, false)
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    termRef.current = term
    fitRef.current = fit
    const buf = consoleBuffer()
    term.write(buf || '\x1b[90mThe agent has not run anything yet. Commands it runs will appear here.\x1b[0m\r\n')
    const off = consoleSubscribe((chunk) => term.write(chunk))
    setTimeout(() => {
      try {
        fit.fit()
      } catch {
        /* not laid out */
      }
    }, 30)
    return () => {
      off()
      term.dispose()
      termRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={host} className="xterm-host" style={{ display: visible ? 'block' : 'none' }} />
}

function XtermView({ id, visible }: { id: string; visible: boolean }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const settings = useApp((s) => s.settings)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useFit(host, termRef, fitRef, visible)

  const menuEntries = (): MenuEntry[] => {
    const term = termRef.current
    const sel = term?.getSelection() ?? ''
    return [
      { label: 'Copy', hint: 'Ctrl+Shift+C', disabled: !sel, onClick: () => void navigator.clipboard.writeText(sel) },
      { label: 'Paste', hint: 'Ctrl+Shift+V', onClick: () => void navigator.clipboard.readText().then((t) => prism.terminals.write(id, t)) },
      { label: 'Select all', onClick: () => term?.selectAll() },
      { label: 'Clear', onClick: () => term?.clear() },
      { sep: true },
      {
        label: sel ? 'Send selection to agent' : 'Send last screen to agent',
        onClick: () => {
          if (sel) {
            const draft = `From my terminal:\n\n\`\`\`\n${sel.slice(-6000)}\n\`\`\`\n`
            useLayout.getState().openAgent()
            const st = useSessions.getState()
            if (st.active) st.setDraft(st.active, draft)
          } else sendTerminalToAgent(id)
        }
      },
      { sep: true },
      { label: 'Kill terminal', danger: true, onClick: () => void useTerminals.getState().kill(id) }
    ]
  }

  useEffect(() => {
    if (!host.current) return
    const term = makeTerminal(settings?.terminal.fontSize ?? 13, true)
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    void import('@xterm/addon-webgl')
      .then((m) => {
        const gl = new m.WebglAddon()
        gl.onContextLoss(() => gl.dispose())
        term.loadAddon(gl)
      })
      .catch(() => {})
    termRef.current = term
    fitRef.current = fit
    liveTerminals.set(id, term)
    const offData = prism.terminals.onData(id, (d) => term.write(d))
    const offExit = prism.terminals.onExit(id, (code) => {
      term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`)
      setTimeout(() => void useTerminals.getState().refresh(), 300)
    })
    // the line being typed, so a recorded lesson can type the same command; a line
    // fetched from history with the arrow keys cannot be known, so it is not reported
    let line = ''
    let known = true
    term.onData((d) => {
      prism.terminals.write(id, d)
      for (const ch of d) {
        if (ch === '\r') {
          if (known && line.trim()) report({ surface: 'terminal', what: 'ran', detail: line })
          line = ''
          known = true
        } else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1)
        else if (ch === '\x1b' || ch === '\t') known = false
        else if (ch === '\x03' || ch === '\x15') {
          line = ''
          known = true
        } else if (ch >= ' ') line += ch
      }
    })
    term.onResize(({ cols, rows }) => prism.terminals.resize(id, cols, rows))
    term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel && useApp.getState().settings?.terminal.copyOnSelect) void navigator.clipboard.writeText(sel)
    })
    setTimeout(() => {
      try {
        fit.fit()
      } catch {
        /* not yet laid out */
      }
    }, 30)
    return () => {
      offData()
      offExit()
      liveTerminals.delete(id)
      term.dispose()
      termRef.current = null
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (visible) setTimeout(() => termRef.current?.focus(), 30)
  }, [visible])

  useEffect(() => {
    const term = termRef.current
    if (!term || !settings) return
    const t = settings.terminal
    term.options.fontSize = t.fontSize
    term.options.cursorStyle = t.cursorStyle ?? 'bar'
    term.options.cursorBlink = t.cursorBlink ?? true
    term.options.scrollback = Math.max(100, Math.min(200_000, t.scrollback ?? 8000))
    term.options.lineHeight = Math.max(0.8, Math.min(2, t.lineHeight ?? 1))
    // a new font has to be loaded before the cells are measured again
    const family = terminalFont()
    void fontReady(family, t.fontSize).then(() => {
      term.options.fontFamily = fontStack(family, true)
      term.clearTextureAtlas()
      try {
        fitRef.current?.fit()
      } catch {
        /* hidden */
      }
      term.refresh(0, term.rows - 1)
    })
  }, [settings?.terminal]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div
        ref={host}
        className="xterm-host"
        style={{ display: visible ? 'block' : 'none' }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries()} onClose={() => setMenu(null)} />}
    </>
  )
}
