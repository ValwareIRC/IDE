// Mark up the page: runs inside the page shown in the Browser panel. Clicking things gives each a numbered
// badge (click again to take it off); the panel reads the list, lets the user note what they want and try
// style changes live, then hands everything to the agent with a picture of the numbered page.

export interface Mark {
  n: number
  selector: string
  tag: string
  text: string
  html: string
  rect: { x: number; y: number; width: number; height: number }
  /** The element's current styles, as the page computes them. */
  styles: Record<string, string>
  /** Style changes tried in the page. */
  tried: Record<string, string>
}

export const STYLE_KEYS = ['color', 'background-color', 'font-size', 'font-weight', 'line-height', 'padding', 'margin', 'gap', 'border-radius', 'border', 'width', 'height', 'opacity', 'box-shadow']

/** Installed once per page; later calls just switch selecting back on. */
export const MARKUP_SCRIPT = `(() => {
  if (window.__prismMarkup) { window.__prismMarkup.select(true); return true }
  const KEYS = ${JSON.stringify(STYLE_KEYS)}
  const accent = '#ff7bd5'
  const layer = document.createElement('div')
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none'
  const hover = document.createElement('div')
  hover.style.cssText = 'position:fixed;pointer-events:none;border:2px dashed ' + accent + ';border-radius:3px;display:none'
  layer.append(hover)
  document.documentElement.append(layer)
  const marks = []
  let selecting = true
  const path = (el) => {
    const parts = []
    let e = el
    while (e && e.nodeType === 1 && parts.length < 5) {
      let s = e.tagName.toLowerCase()
      if (e.id) { parts.unshift(s + '#' + CSS.escape(e.id)); break }
      s += [...e.classList].filter((c) => !c.startsWith('__prism')).slice(0, 2).map((c) => '.' + CSS.escape(c)).join('')
      const p = e.parentElement
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === e.tagName)
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')'
      }
      parts.unshift(s)
      e = e.parentElement
    }
    return parts.join(' > ')
  }
  const draw = () => {
    marks.forEach((m, i) => {
      m.n = i + 1
      const r = m.el.getBoundingClientRect()
      Object.assign(m.box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
      m.badge.textContent = String(m.n)
      Object.assign(m.badge.style, { left: Math.max(0, r.left - 9) + 'px', top: Math.max(0, r.top - 9) + 'px' })
    })
    raf = requestAnimationFrame(draw)
  }
  let raf = requestAnimationFrame(draw)
  const add = (el) => {
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;pointer-events:none;border:2px solid ' + accent + ';border-radius:3px;background:rgba(255,123,213,.08)'
    const badge = document.createElement('div')
    badge.style.cssText = 'position:fixed;pointer-events:none;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:' + accent + ';color:#1a0612;font:700 11px/18px system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.4)'
    layer.append(box, badge)
    marks.push({ el, box, badge, n: marks.length + 1, original: el.getAttribute('style'), tried: {} })
  }
  const remove = (m) => {
    if (m.original === null) m.el.removeAttribute('style'); else m.el.setAttribute('style', m.original)
    m.box.remove(); m.badge.remove()
    marks.splice(marks.indexOf(m), 1)
  }
  const target = (ev) => { const el = document.elementFromPoint(ev.clientX, ev.clientY); return el && !layer.contains(el) ? el : null }
  const move = (ev) => {
    if (!selecting) return
    const el = target(ev)
    if (!el) return
    const r = el.getBoundingClientRect()
    Object.assign(hover.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
  }
  const swallow = (ev) => { if (selecting) { ev.preventDefault(); ev.stopPropagation() } }
  const click = (ev) => {
    if (!selecting) return
    ev.preventDefault(); ev.stopPropagation()
    const el = target(ev)
    if (!el) return
    const had = marks.find((m) => m.el === el)
    if (had) remove(had); else add(el)
  }
  const key = (ev) => { if (ev.key === 'Escape' && selecting) { ev.preventDefault(); api.select(false) } }
  document.addEventListener('mousemove', move, true)
  document.addEventListener('mousedown', swallow, true)
  document.addEventListener('mouseup', swallow, true)
  document.addEventListener('click', click, true)
  document.addEventListener('keydown', key, true)
  const api = {
    select(on) { selecting = on; hover.style.display = 'none'; document.documentElement.style.cursor = on ? 'crosshair' : '' ; return on },
    selecting() { return selecting },
    list() {
      return marks.map((m) => {
        const r = m.el.getBoundingClientRect()
        const cs = getComputedStyle(m.el)
        const styles = {}
        for (const k of KEYS) styles[k] = cs.getPropertyValue(k)
        // the html as the page has it, without the styles being tried
        const now = m.el.getAttribute('style')
        if (m.original === null) m.el.removeAttribute('style'); else m.el.setAttribute('style', m.original)
        const html = m.el.outerHTML.slice(0, 2000)
        if (now === null) m.el.removeAttribute('style'); else m.el.setAttribute('style', now)
        return { n: m.n, selector: path(m.el), tag: m.el.tagName.toLowerCase(), text: (m.el.innerText || '').trim().slice(0, 300), html, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, styles, tried: { ...m.tried } }
      })
    },
    setStyle(n, prop, value) {
      const m = marks[n - 1]
      if (!m) return false
      if (value) { m.el.style.setProperty(prop, value); m.tried[prop] = value } else { m.el.style.removeProperty(prop); delete m.tried[prop] }
      return true
    },
    remove(n) { const m = marks[n - 1]; if (m) remove(m); return true },
    clear() { while (marks.length) remove(marks[marks.length - 1]); return true },
    chrome(show) { hover.style.display = 'none'; layer.style.visibility = show ? 'visible' : 'visible'; return true },
    stop() {
      api.clear(); api.select(false); cancelAnimationFrame(raf); layer.remove()
      document.removeEventListener('mousemove', move, true)
      document.removeEventListener('mousedown', swallow, true)
      document.removeEventListener('mouseup', swallow, true)
      document.removeEventListener('click', click, true)
      document.removeEventListener('keydown', key, true)
      delete window.__prismMarkup
      return true
    }
  }
  window.__prismMarkup = api
  api.select(true)
  return true
})()`
