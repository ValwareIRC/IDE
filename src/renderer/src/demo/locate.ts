// Finding a thing on screen again. A recorded click has to land on the same button when
// the lesson plays, in a window that may be a different size with different things open,
// so it is remembered the way a person would describe it: by the name lessons know it
// by (data-demo) if it has one, else by its words, its tooltip, what kind of thing it is
// and what is around it, and which of several matching ones it was.

/** Things a person clicks, as opposed to the boxes they sit in. */
export const CLICKABLE =
  'button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="switch"], [role="option"], [role="checkbox"], [role="radio"], input[type="checkbox"], input[type="radio"], summary, .tree-row, .session-row, .menu-item, .menubar-item, .dv-tab, [data-demo]'

export interface Target {
  /** The name lessons know it by. */
  demo?: string
  /** What sort of thing: "button", "menuitem", ... */
  kind: string
  /** Its words, as shown. */
  text?: string
  /** Its tooltip or spoken name. */
  label?: string
  /** For a thing with no words of its own (a switch): the words of the row it sits in. */
  near?: string
  /** Which of several that match, in screen order. */
  nth?: number
}

const words = (s: string | null | undefined, n = 80): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

function kindOf(el: Element): string {
  return el.getAttribute('role') ?? (el.classList.contains('menu-item') ? 'menuitem' : el.classList.contains('menubar-item') ? 'menubar' : el.tagName.toLowerCase())
}

function rowText(el: Element): string {
  const row = el.parentElement?.closest('.setting-row, .lesson-row, .session-row, .fleet-row, label, li, tr')
  return words(row?.textContent, 80)
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

function matches(el: Element, t: Target): boolean {
  if (kindOf(el) !== t.kind) return false
  if (t.label && words(el.getAttribute('aria-label') || el.getAttribute('title')) !== t.label) return false
  if (t.text && words(el.textContent) !== t.text) return false
  if (t.near && rowText(el) !== t.near) return false
  return true
}

/** Whether a click landed on something that does anything, rather than on empty space between things. */
export function clickable(from: Element): boolean {
  return !!from.closest(CLICKABLE)
}

/** The thing pressed, described so it can be found again. */
export function describeTarget(from: Element): { el: Element; target: Target } {
  const el = from.closest(CLICKABLE) ?? from
  // a name lessons know, when it belongs to this one thing and not to a box of many
  const named = el.closest('[data-demo]')
  if (named && (named === el || named.querySelectorAll(CLICKABLE).length <= 1)) return { el, target: { demo: named.getAttribute('data-demo')!, kind: kindOf(el) } }
  const t: Target = { kind: kindOf(el) }
  const label = words(el.getAttribute('aria-label') || el.getAttribute('title'))
  const text = words(el.textContent)
  if (label) t.label = label
  if (text) t.text = text
  if (!label && !text) t.near = rowText(el)
  const all = [...document.querySelectorAll(CLICKABLE)].filter((x) => visible(x) && matches(x, t))
  const nth = all.indexOf(el)
  if (nth > 0) t.nth = nth
  return { el, target: t }
}

/** The thing a target describes, as the screen is now; null when it is not there. */
export function findTarget(t: Target): Element | null {
  if (t.demo) {
    const named = document.querySelector(`[data-demo="${t.demo}"]`)
    if (!named) return null
    // a wrapper named for lessons: what is pressed is the button inside it
    return named.matches(CLICKABLE.replace(', [data-demo]', '')) ? named : (named.querySelector(CLICKABLE) ?? named)
  }
  const all = [...document.querySelectorAll(CLICKABLE)].filter((x) => visible(x) && matches(x, t))
  return all[t.nth ?? 0] ?? all[0] ?? null
}

/** A target in a few words, for the lesson editor and for saying what could not be found. */
export function targetWords(t: Target): string {
  if (t.demo) return t.demo.replace(':', ': ')
  if (t.kind === 'field') return `the box “${t.label ?? ''}”${t.nth ? ` (number ${t.nth + 1})` : ''}`
  const what = t.kind === 'menuitem' ? 'menu item' : t.kind === 'menubar' ? 'menu' : t.kind === 'input' ? 'box' : t.kind
  const which = t.nth ? ` (number ${t.nth + 1})` : ''
  if (!t.text && !t.label && t.near) return `the ${what} by “${t.near.slice(0, 50)}”${which}`
  return `the ${what} “${t.text || t.label || ''}”${which}`
}

/** Presses something the way a hand does, so whatever it listens for (press, release, click) hears it. */
export function pressLikeAHand(el: Element, right = false): void {
  const r = el.getBoundingClientRect()
  const at = { bubbles: true, cancelable: true, view: window, button: right ? 2 : 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
  if (right) {
    // a right-click is a press, a release and a request for the menu
    el.dispatchEvent(new PointerEvent('pointerdown', at))
    el.dispatchEvent(new MouseEvent('mousedown', at))
    el.dispatchEvent(new PointerEvent('pointerup', at))
    el.dispatchEvent(new MouseEvent('mouseup', at))
    el.dispatchEvent(new MouseEvent('contextmenu', at))
    return
  }
  el.dispatchEvent(new PointerEvent('pointerover', at))
  el.dispatchEvent(new MouseEvent('mouseover', at))
  el.dispatchEvent(new PointerEvent('pointerdown', at))
  el.dispatchEvent(new MouseEvent('mousedown', at))
  ;(el as HTMLElement).focus?.()
  el.dispatchEvent(new PointerEvent('pointerup', at))
  el.dispatchEvent(new MouseEvent('mouseup', at))
  el.dispatchEvent(new MouseEvent('click', at))
}

/** Rests the pointer on something, as hovering does: a submenu opens like this. */
export function hoverLikeAHand(el: Element): void {
  const r = el.getBoundingClientRect()
  const at = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
  el.dispatchEvent(new PointerEvent('pointerover', at))
  el.dispatchEvent(new MouseEvent('mouseover', at))
  el.dispatchEvent(new PointerEvent('pointerenter', { ...at, bubbles: false }))
  el.dispatchEvent(new MouseEvent('mouseenter', { ...at, bubbles: false }))
}

// ---- boxes to type into

/** Boxes a person types a word or two into (a name, a setting): not the editor, the terminal or the message box. */
export const FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="range"]), textarea'

/** What a box is called: its spoken name, its placeholder, or the words of the label it sits in. */
function fieldName(el: Element): string {
  const own = el.getAttribute('aria-label') || el.getAttribute('placeholder')
  if (own) return words(own)
  const label = el.closest('label, .field, .setting-row')
  const title = label?.querySelector('span, .t')?.textContent ?? label?.textContent
  return words(title, 60)
}

export function describeField(el: Element): Target {
  const t: Target = { kind: 'field', label: fieldName(el) }
  const all = [...document.querySelectorAll(FIELD)].filter((x) => visible(x) && fieldName(x) === t.label)
  const nth = all.indexOf(el)
  if (nth > 0) t.nth = nth
  return t
}

export function findField(t: Target): HTMLInputElement | HTMLTextAreaElement | null {
  const all = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(FIELD)].filter((x) => visible(x) && fieldName(x) === (t.label ?? ''))
  return all[t.nth ?? 0] ?? all[0] ?? null
}

/** Puts text in a box the way typing does, so whatever listens to it (React included) hears each change. */
export function setFieldLikeAHand(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Presses Enter in a box, as a hand does to confirm it. */
export function enterLikeAHand(el: Element): void {
  const at = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
  el.dispatchEvent(new KeyboardEvent('keydown', at))
  el.dispatchEvent(new KeyboardEvent('keypress', at))
  el.dispatchEvent(new KeyboardEvent('keyup', at))
}
