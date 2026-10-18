// Opening a web link.
//
// A window asks the main process, which hands it to this computer's browser. A phone
// cannot: opening something on the computer's desktop is one of the things a remote
// client is refused, and quite right — tapping a link on a walk should open it on the
// phone, not on a machine at home. So the phone opens it itself.
import { prism } from './ipc'

export function openLink(href: string): void {
  if (!href || !/^https?:/i.test(href)) return
  if (window.__prismMobile) {
    // Android hands an external address to the phone's own browser
    const w = window.open(href, '_blank', 'noopener,noreferrer')
    if (!w) window.location.href = href
    return
  }
  void prism.app.openExternal(href)
}
