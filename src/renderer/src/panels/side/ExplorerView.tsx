import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pinForAgent } from '@/shell/Dock'
import { ChevronDown, ChevronRight, FilePlus, FolderPlus, RefreshCw, FoldVertical, Radar } from 'lucide-react'
import { useSessions } from '@/state/sessions'
import { agentMap, pathsOf } from './agentMap'
import type { FsEntry, GitFile } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { useEditor } from '@/state/editor'
import { useLayout } from '@/state/layout'
import { useRefactor } from '@/state/refactor'
import { toastError, useUi } from '@/state/ui'
import { opensInPreview } from '@/lib/languages'
import { basename, cx, dirname } from '@/lib/format'
import { FileIcon } from '@/components/FileIcon'
import { ContextMenu, type MenuEntry } from '@/components/ContextMenu'
import { copyText } from '@/lib/copy'
import { registerSurface, report } from '@/demo/bus'

interface Row {
  entry: FsEntry
  depth: number
}

export function ExplorerView(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const openWorkspace = useApp((s) => s.openWorkspace)
  const touched = useEditor((s) => s.touched)
  // the agent's map: where the active session has read and changed, and where it is right now
  const mapOn = useApp((s) => s.settings?.assist?.agentMap !== false)
  const setMapOn = (on: boolean): void => void useApp.getState().updateSettings({ assist: { agentMap: on } })
  const active = useSessions((s) => s.active)
  const sessionItems = useSessions((s) => (s.active ? s.items[s.active] : undefined))
  const pending = useSessions((s) => (s.active ? s.live[s.active]?.pendingTools : undefined))
  const heat = useMemo(() => (mapOn && sessionItems ? agentMap(sessionItems) : null), [mapOn, sessionItems])
  const maxHeat = useMemo(() => {
    let m = 1
    for (const [p, h] of heat ?? []) if (!p.includes('/')) m = Math.max(m, h.reads + h.writes)
    return m
  }, [heat])
  const touchedAt = useEditor((s) => s.touchedAt)
  const running = useSessions((s) => (s.active ? !!s.live[s.active]?.running : false))
  // a file the agent just touched glows for a moment, so the map visibly follows it
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!running || !mapOn) return
    const t = setInterval(() => setTick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [running, mapOn])
  const now = useMemo(() => {
    const set = new Set<string>()
    for (const t of pending ?? []) {
      for (const p of pathsOf(t.call)) {
        const parts = p.split('/')
        for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'))
      }
    }
    for (const [p, at] of Object.entries(touchedAt)) {
      if (Date.now() - at > 3000) continue
      const parts = p.split('/')
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'))
    }
    return set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, touchedAt, tick])
  const docs = useEditor((s) => s.docs)
  const activeDoc = useEditor((s) => s.active)
  const openEditor = useLayout((s) => s.openEditor)
  const openPreview = useLayout((s) => s.openPreview)
  const [cache, setCache] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['.']))
  const [git, setGit] = useState<Map<string, GitFile>>(new Map())
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsEntry | null } | null>(null)
  const [editing, setEditing] = useState<{ kind: 'rename' | 'new-file' | 'new-dir'; path: string; parent: string } | null>(null)
  /** A row a demo is pointing at. */
  const [marked, setMarked] = useState<string | null>(null)
  /** Files and folders picked with Ctrl and Shift, to act on together; `anchor` is where a Shift range starts. */
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  /** The folder a dragged selection is over, so it can show it will land there. */
  const [dropOn, setDropOn] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (dir: string) => {
    try {
      const entries = await prism.fs.list(dir)
      setCache((c) => ({ ...c, [dir]: entries }))
    } catch (e) {
      toastError(e, `Could not read ${dir}`)
    }
  }, [])

  const refreshGit = useCallback(() => {
    void prism.git
      .status()
      .then((s) => setGit(new Map(s.files.map((f) => [f.path, f]))))
      .catch(() => setGit(new Map()))
  }, [])

  useEffect(() => {
    setCache({})
    setExpanded(new Set(['.']))
    if (workspace) {
      void load('.')
      refreshGit()
    }
  }, [workspace, load, refreshGit])

  useEffect(() => {
    return prism.fs.onChanged((changes) => {
      const dirs = new Set<string>()
      for (const c of changes) {
        const d = dirname(c.path) || '.'
        dirs.add(d)
        if (c.type === 'delete') dirs.add(c.path)
      }
      setCache((cur) => {
        for (const d of dirs) if (cur[d] !== undefined) void load(d)
        return cur
      })
      refreshGit()
    })
  }, [load, refreshGit])

  // folders Prism skips (Settings, Files) are shown greyed out
  const hidden = useApp((s) => s.settings?.files?.hidden.join('\n') ?? '')
  const skipped = useMemo(() => new Set(hidden.split('\n').filter(Boolean)), [hidden])

  useEffect(() => {
    if (editing) {
      setDraft(editing.kind === 'rename' ? basename(editing.path) : '')
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 10)
    }
  }, [editing])

  const toggle = (path: string): void => {
    if (!expanded.has(path)) report({ surface: 'tree', what: 'expanded', detail: path })
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        if (!cache[path]) void load(path)
      }
      return next
    })
  }

  // one click looks at a file (the tab is reused by the next look); two clicks keep it open
  const openFile = (path: string, keep = false): void => {
    if (opensInPreview(path)) openPreview(path)
    else openEditor(path, null, { preview: !keep })
    report({ surface: 'tree', what: 'opened', detail: path })
  }

  // a demo drives the tree through these, so what it does is what your click does
  const drive = useRef<{ expand(path: string): void; open(path: string, keep?: boolean): void }>({ expand: () => {}, open: () => {} })
  useEffect(() => {
    drive.current = {
      expand: (path) => {
        if (!expanded.has(path)) toggle(path)
      },
      open: (path, keep) => openFile(path, keep ?? false)
    }
  })
  useEffect(
    () =>
      registerSurface('tree', {
        expand: (p) => drive.current.expand(p),
        open: (p, keep) => drive.current.open(p, keep),
        mark: setMarked
      }),
    []
  )

  const rows = useMemo(() => {
    const out: Row[] = []
    const walk = (dir: string, depth: number): void => {
      const entries = cache[dir]
      if (!entries) return
      for (const e of entries) {
        out.push({ entry: e, depth })
        if (e.kind === 'dir' && expanded.has(e.path)) walk(e.path, depth + 1)
        if (editing && editing.kind !== 'rename' && editing.parent === e.path && e.kind === 'dir' && expanded.has(e.path)) {
          out.push({ entry: { name: '', path: `${e.path}/__new__`, kind: editing.kind === 'new-dir' ? 'dir' : 'file', size: null, mtime: null }, depth: depth + 1 })
        }
      }
    }
    if (editing && editing.kind !== 'rename' && editing.parent === '.') {
      out.push({ entry: { name: '', path: '__new__', kind: editing.kind === 'new-dir' ? 'dir' : 'file', size: null, mtime: null }, depth: 0 })
    }
    walk('.', 0)
    return out
  }, [cache, expanded, editing])

  const gitBadge = (path: string): { cls: string; ch: string } | null => {
    const f = git.get(path)
    if (f) return { cls: f.status === '?' || f.status === 'A' ? 'git-a' : f.status === 'D' ? 'git-d' : 'git-m', ch: f.status === '?' ? 'U' : f.status }
    for (const [p, g] of git) {
      if (p.startsWith(path + '/')) return { cls: g.status === '?' || g.status === 'A' ? 'git-a' : 'git-m', ch: '•' }
    }
    return null
  }

  const commitEdit = async (): Promise<void> => {
    if (!editing) return
    const name = draft.trim()
    const ed = editing
    setEditing(null)
    if (!name) return
    try {
      if (ed.kind === 'rename') {
        const to = (dirname(ed.path) ? dirname(ed.path) + '/' : '') + name
        if (to === ed.path) return
        // other files may import this one: show what would change before moving it
        const handled = await useRefactor.getState().move(ed.path, to).catch(() => false)
        if (handled) return
        await prism.fs.rename(ed.path, to)
        useEditor.getState().rename(ed.path, to)
      } else {
        const p = (ed.parent === '.' ? '' : ed.parent + '/') + name
        await prism.fs.create(p, ed.kind === 'new-dir' ? 'dir' : 'file')
        if (ed.kind === 'new-file') openEditor(p)
      }
      void load(ed.parent === '.' && ed.kind !== 'rename' ? '.' : dirname(ed.kind === 'rename' ? ed.path : ed.parent + '/x') || '.')
    } catch (e) {
      toastError(e)
    }
  }

  const startNew = (kind: 'new-file' | 'new-dir', target: FsEntry | null): void => {
    const parent = !target ? '.' : target.kind === 'dir' ? target.path : dirname(target.path) || '.'
    if (parent !== '.' && !expanded.has(parent)) toggle(parent)
    setEditing({ kind, path: '', parent })
  }

  /** Moves files and folders into a folder ('.' for the top), skipping any that would land inside themselves. */
  const moveInto = async (paths: string[], folder: string): Promise<void> => {
    const going = paths.filter((p) => folder !== p && !folder.startsWith(p + '/') && (dirname(p) || '.') !== folder)
    if (!going.length) return
    let moved = 0
    for (const p of going) {
      const to = (folder === '.' ? '' : folder + '/') + basename(p)
      try {
        await prism.fs.rename(p, to)
        useEditor.getState().rename(p, to)
        moved++
      } catch (e) {
        toastError(e, `${p} could not be moved`)
      }
    }
    setPicked(new Set())
    for (const d of new Set([...going.map((p) => dirname(p) || '.'), folder])) void load(d)
    if (moved) useUi.getState().toast('success', `Moved ${moved} item${moved === 1 ? '' : 's'}`, `Into ${folder === '.' ? 'the top of the project' : folder}.`)
  }

  /** What a right-click on a selection of several offers: things that make sense for all of them at once. */
  const selectionMenu = (paths: string[]): MenuEntry[] => {
    const files = paths.filter((p) => rows.find((r) => r.entry.path === p)?.entry.kind === 'file')
    return [
      { label: `Copy ${paths.length} paths`, onClick: () => void copyText(paths.join('\n')) },
      ...(files.length ? [{ label: `Pin ${files.length} file${files.length === 1 ? '' : 's'} for the agent (this session)`, onClick: () => void (async () => { for (const f of files) await pinForAgent(f) })() }] : []),
      { sep: true },
      {
        label: `Delete ${paths.length} items`,
        danger: true,
        onClick: () => {
          if (!window.confirm(`Delete these ${paths.length}?\n\n${paths.slice(0, 12).join('\n')}${paths.length > 12 ? '\n…' : ''}`)) return
          void (async () => {
            for (const p of paths) {
              try {
                await prism.fs.delete(p)
                if (docs[p]) useEditor.getState().close(p)
              } catch (e) {
                toastError(e, `${p} could not be deleted`)
              }
            }
            setPicked(new Set())
            for (const d of new Set(paths.map((p) => dirname(p) || '.'))) void load(d)
          })()
        }
      },
      { sep: true },
      { label: 'Clear the selection', hint: 'Esc', onClick: () => setPicked(new Set()) }
    ]
  }

  /** A click: Ctrl adds or takes away one, Shift picks everything from the last one, a plain click opens as before. */
  const clickRow = (e: React.MouseEvent, entry: FsEntry): void => {
    if (e.ctrlKey || e.metaKey) {
      setPicked((prev) => {
        const next = new Set(prev)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
      anchor.current = entry.path
      return
    }
    if (e.shiftKey && anchor.current) {
      const order = rows.filter((r) => r.entry.name !== '').map((r) => r.entry.path)
      const a = order.indexOf(anchor.current)
      const b = order.indexOf(entry.path)
      if (a >= 0 && b >= 0) {
        setPicked(new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1)))
        return
      }
    }
    anchor.current = entry.path
    setPicked(new Set())
    if (entry.kind === 'dir') toggle(entry.path)
    else openFile(entry.path)
  }

  const menuEntries = (entry: FsEntry | null): MenuEntry[] => {
    if (entry && picked.size > 1 && picked.has(entry.path)) return selectionMenu([...picked])
    const items: MenuEntry[] = [
      { label: 'New file', icon: <FilePlus size={14} />, onClick: () => startNew('new-file', entry) },
      { label: 'New folder', icon: <FolderPlus size={14} />, onClick: () => startNew('new-dir', entry) }
    ]
    if (entry) {
      items.push(
        { sep: true },
        { label: 'Rename', hint: 'F2', onClick: () => setEditing({ kind: 'rename', path: entry.path, parent: dirname(entry.path) || '.' }) },
        { label: 'Copy path', onClick: () => void copyText(entry.path) },
        ...(entry.kind === 'file' ? [{ label: 'Pin for the agent (this session)', onClick: () => void pinForAgent(entry.path) }] : []),
        ...(entry.kind === 'file' && /\.html?$/i.test(entry.path) ? [{ label: 'Open in the browser', onClick: () => useLayout.getState().openBrowser(entry.path) }] : []),
        { label: 'Reveal in file manager', onClick: () => void prism.app.reveal(entry.path) },
        { sep: true },
        {
          label: 'Delete',
          danger: true,
          onClick: () => {
            if (!window.confirm(`Delete ${entry.path}?`)) return
            void prism.fs.delete(entry.path).then(() => {
              if (docs[entry.path]) useEditor.getState().close(entry.path)
              void load(dirname(entry.path) || '.')
            }).catch(toastError)
          }
        }
      )
    }
    return items
  }

  if (!workspace) {
    return (
      <div className="side-view">
        <div className="side-head">
          <span className="hud-label">Explorer</span>
        </div>
        <div className="empty">
          <div>No folder open</div>
          <button className="btn primary" onClick={() => void openWorkspace()}>
            Open folder
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="side-view" onContextMenu={(e) => {
      if ((e.target as HTMLElement).closest('.tree-row')) return
      e.preventDefault()
      setMenu({ x: e.clientX, y: e.clientY, entry: null })
    }}>
      <div className="side-head">
        <span className="hud-label truncate" title={workspace}>
          {basename(workspace)}
        </span>
        <span className="grow" />
        <button className="icon-btn sm" title="New file" onClick={() => startNew('new-file', null)}>
          <FilePlus size={14} />
        </button>
        <button className="icon-btn sm" title="New folder" onClick={() => startNew('new-dir', null)}>
          <FolderPlus size={14} />
        </button>
        <button
          className={cx('icon-btn sm', mapOn && 'on')}
          title={mapOn ? 'Agent map on: where the agent has read (blue) and changed (warm) in this session' : 'Agent map off'}
          disabled={!active}
          onClick={() => setMapOn(!mapOn)}
        >
          <Radar size={14} />
        </button>
        <button className="icon-btn sm" title="Collapse all" onClick={() => setExpanded(new Set(['.']))}>
          <FoldVertical size={14} />
        </button>
        <button className="icon-btn sm" title="Refresh" onClick={() => {
          setCache({})
          void load('.')
          refreshGit()
        }}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div
        className={cx('side-body tree', dropOn === '.' && 'drop-on')}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('application/x-prism-paths') || (e.target as HTMLElement).closest('.tree-row')) return
          e.preventDefault()
          if (dropOn !== '.') setDropOn('.')
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDropOn(null)}
        onDrop={(e) => {
          setDropOn(null)
          const raw = e.dataTransfer.getData('application/x-prism-paths')
          if (!raw || (e.target as HTMLElement).closest('.tree-row')) return
          e.preventDefault()
          void moveInto(JSON.parse(raw) as string[], '.')
        }}
      >
        {picked.size > 1 && (
          <div className="tree-picked faint small">
            {picked.size} selected · right-click for what to do with them · Esc to clear
          </div>
        )}
        {rows.map(({ entry, depth }) => {
          const isNew = entry.name === ''
          const isEditing = isNew || (editing?.kind === 'rename' && editing.path === entry.path)
          const badge = !isNew ? gitBadge(entry.path) : null
          const t = touched[entry.path]
          const h = heat?.get(entry.path)
          const busy = mapOn && now.has(entry.path)
          return (
            <div
              key={entry.path}
              className={cx('tree-row', entry.kind === 'dir' && 'dir', entry.kind === 'dir' && skipped.has(entry.name) && 'skipped', activeDoc === entry.path && 'sel', t && t !== 'read' && 'touched', busy && 'agent-here', marked === entry.path && 'demo-mark', picked.size > 1 && picked.has(entry.path) && 'picked', dropOn === entry.path && 'drop-on')}
              data-demo={`tree:${entry.path}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              title={h ? `${entry.path}\nThis session: read ${h.reads} time${h.reads === 1 ? '' : 's'}, changed ${h.writes} time${h.writes === 1 ? '' : 's'}${busy ? '\nThe agent is working here now' : ''}` : entry.path}
              draggable={!isEditing}
              onDragStart={(e) => {
                // a picked row carries the whole selection with it
                const many = picked.size > 1 && picked.has(entry.path) ? [...picked] : [entry.path]
                e.dataTransfer.setData('application/x-prism-path', entry.path)
                e.dataTransfer.setData('application/x-prism-paths', JSON.stringify(many))
                e.dataTransfer.setData('text/plain', many.map((p) => `@${p} `).join(''))
                e.dataTransfer.effectAllowed = 'copyMove'
              }}
              onDragOver={(e) => {
                if (entry.kind !== 'dir' || !e.dataTransfer.types.includes('application/x-prism-paths')) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (dropOn !== entry.path) setDropOn(entry.path)
              }}
              onDragLeave={() => dropOn === entry.path && setDropOn(null)}
              onDrop={(e) => {
                setDropOn(null)
                const raw = e.dataTransfer.getData('application/x-prism-paths')
                if (entry.kind !== 'dir' || !raw) return
                e.preventDefault()
                e.stopPropagation()
                void moveInto(JSON.parse(raw) as string[], entry.path)
              }}
              onClick={(e) => !isEditing && clickRow(e, entry)}
              onDoubleClick={() => !isEditing && entry.kind !== 'dir' && openFile(entry.path, true)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMenu({ x: e.clientX, y: e.clientY, entry })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && picked.size) setPicked(new Set())
                if (e.key === 'F2' && !isEditing) setEditing({ kind: 'rename', path: entry.path, parent: dirname(entry.path) || '.' })
              }}
              tabIndex={0}
            >
              <span className="chev">{entry.kind === 'dir' ? expanded.has(entry.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}</span>
              <span className="ficon">
                <FileIcon name={entry.name || (entry.kind === 'dir' ? 'folder' : 'file')} dir={entry.kind === 'dir'} open={expanded.has(entry.path)} />
              </span>
              {isEditing ? (
                <input
                  ref={inputRef}
                  className="rename"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void commitEdit()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitEdit()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className={cx('name', docs[entry.path] && docs[entry.path]!.content !== docs[entry.path]!.savedContent && 'amber')}>{entry.name}</span>
              )}
              {badge && <span className={cx('meta', badge.cls)}>{badge.ch}</span>}
              {h && (
                <span className="heat" aria-hidden>
                  <i className="heat-r" style={{ width: `${Math.min(100, (h.reads / maxHeat) * 100)}%` }} />
                  <i className="heat-w" style={{ width: `${Math.min(100, (h.writes / maxHeat) * 100)}%` }} />
                </span>
              )}
            </div>
          )
        })}
        {rows.length === 0 && <div className="faint small" style={{ padding: 10 }}>Empty folder</div>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.entry)} onClose={() => setMenu(null)} />}
    </div>
  )
}
