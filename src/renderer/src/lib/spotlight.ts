// Cards that catch the light: tells the card under the pointer where the pointer is (--mx, --my), for polish.css.
const CARDS = '.welcome-card, .theme-card'

let frame = 0
let last: PointerEvent | null = null

addEventListener(
  'pointermove',
  (e) => {
    last = e
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const card = last?.target instanceof Element ? (last.target.closest(CARDS) as HTMLElement | null) : null
      if (!card || !last) return
      const r = card.getBoundingClientRect()
      card.style.setProperty('--mx', `${last.clientX - r.left}px`)
      card.style.setProperty('--my', `${last.clientY - r.top}px`)
    })
  },
  { passive: true }
)
