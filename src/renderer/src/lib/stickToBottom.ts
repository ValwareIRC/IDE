import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Keeps a scroll box at its bottom while content grows (text streaming in, code being coloured, a diagram
 * drawn), until the user scrolls up; scrolling back to the bottom follows again. `key` re-attaches when the
 * box itself is replaced.
 */
export function useStickToBottom<T extends HTMLElement>(key?: unknown): { ref: React.RefObject<T | null>; stuck: boolean; toBottom: () => void; release: () => void } {
  const ref = useRef<T | null>(null)
  const stuckRef = useRef(true)
  const [stuck, setStuck] = useState(true)
  const set = useCallback((v: boolean) => {
    if (stuckRef.current === v) return
    stuckRef.current = v
    setStuck(v)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let last = el.scrollTop
    // growth the user caused (opening a step) stays where they are looking
    let clicked = 0
    const pin = (): void => {
      if (!stuckRef.current) return
      if (Date.now() - clicked < 700) {
        if (el.scrollHeight - el.scrollTop - el.clientHeight > 2) set(false)
        return
      }
      el.scrollTop = el.scrollHeight
      last = el.scrollTop
    }
    // only the user's own input lets go: content shrinking and growing again in one frame also moves it up
    let dragging = false
    // A finger on a phone screen: it scrolls without any wheel, scrollbar or key, so on the
    // phone the box never let go and every timer tick pulled the conversation back down.
    let touching = false
    const onScroll = (): void => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      if (gap <= 2) set(true)
      else if ((dragging || touching) && el.scrollTop < last - 1) set(false)
      last = el.scrollTop
    }
    const onTouchStart = (): void => {
      touching = true
    }
    const onTouchEnd = (): void => {
      touching = false
    }
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0 && el.scrollHeight > el.clientHeight) set(false)
    }
    const onDown = (e: MouseEvent): void => {
      // a press on the scrollbar itself
      if (e.target === el && e.offsetX >= el.clientWidth) dragging = true
      else clicked = Date.now()
    }
    const onUp = (): void => {
      dragging = false
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') set(false)
    }
    const ro = new ResizeObserver(() => soon(false))
    // Streaming fires these constantly: one character can mean a mutation, a resize per child, and a reflow
    // each. Everything is folded into a single pass per frame, and the children are re-observed only when the
    // list of them actually changed. Without this, a long conversation locked the window up while it worked.
    let queued = false
    let rewatch = false
    const watch = (): void => {
      ro.disconnect()
      ro.observe(el)
      for (const c of Array.from(el.children)) ro.observe(c)
    }
    const soon = (childrenChanged: boolean): void => {
      rewatch ||= childrenChanged
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        if (rewatch) {
          rewatch = false
          watch()
        }
        pin()
      })
    }
    const mo = new MutationObserver((records) => soon(records.some((r) => r.type === 'childList')))
    watch()
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('keydown', onKey)
    el.addEventListener('mousedown', onDown)
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    window.addEventListener('mouseup', onUp)
    pin()
    return () => {
      ro.disconnect()
      mo.disconnect()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('mousedown', onDown)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      window.removeEventListener('mouseup', onUp)
    }
  }, [key, set])

  const toBottom = useCallback(() => {
    const el = ref.current
    set(true)
    if (el) el.scrollTop = el.scrollHeight
  }, [set])

  // stop following, for a jump the user asked for (a find match)
  const release = useCallback(() => set(false), [set])

  return { ref, stuck, toBottom, release }
}
