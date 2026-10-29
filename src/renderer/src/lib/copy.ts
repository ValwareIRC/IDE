// Copying text, from anywhere in Prism. The browser's own clipboard refuses when the window
// is not the one in focus that instant (and some phones refuse it outright), and a copy
// button that silently does nothing is worse than none. On the computer the main process
// copies (Electron's clipboard has no such rule); on the phone the browser's clipboard,
// then the older way; and if all of them fail, you are told.
import { prism } from '@/lib/ipc'
import { useUi } from '@/state/ui'

function oldWay(text: string): boolean {
  const box = document.createElement('textarea')
  box.value = text
  box.setAttribute('readonly', '')
  box.style.position = 'fixed'
  box.style.opacity = '0'
  document.body.appendChild(box)
  box.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  box.remove()
  return ok
}

/** Copies text; true once it is on the clipboard. Says so when it could not be. */
export async function copyText(text: string): Promise<boolean> {
  if (!window.__prismMobile) {
    try {
      await prism.app.copy(text)
      return true
    } catch {
      /* an older main process, or a window that is closing: try the browser's way */
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* refused: try the old way */
  }
  if (oldWay(text)) return true
  useUi.getState().toast('error', 'Could not copy', 'The clipboard refused it. Select the text and press Ctrl+C instead.')
  return false
}
