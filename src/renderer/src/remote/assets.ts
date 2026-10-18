// The phone app cannot load prism:// addresses (they are served by the computer's Prism). Anything on the page
// that points at one is fetched over the connection and swapped for a local copy.
import type { PrismApi } from '@shared/ipc'

const cache = new Map<string, Promise<string>>()

export function localCopy(api: PrismApi, url: string): Promise<string> {
  let p = cache.get(url)
  if (!p) {
    p = api.host.asset(url).then((a) => (a ? URL.createObjectURL(new Blob([a.data as BlobPart], { type: a.mime })) : ''))
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

const ATTRS = ['src', 'poster', 'href']

function fix(api: PrismApi, el: Element): void {
  for (const a of ATTRS) {
    const v = el.getAttribute(a)
    if (!v?.startsWith('prism://')) continue
    if (a === 'href' && el.tagName !== 'LINK' && el.tagName !== 'image') continue
    el.setAttribute(a, '')
    void localCopy(api, v).then((u) => u && el.setAttribute(a, u))
  }
}

export function installAssets(api: PrismApi): void {
  // previews ask for an address first: hand back the local copy instead
  const assetUrl = api.fs.assetUrl.bind(api.fs)
  api.fs.assetUrl = async (p: string) => localCopy(api, await assetUrl(p))

  const scan = (root: ParentNode): void => root.querySelectorAll('[src^="prism://"],[poster^="prism://"],[href^="prism://"]').forEach((el) => fix(api, el))
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes') fix(api, m.target as Element)
      else m.addedNodes.forEach((n) => n instanceof Element && (fix(api, n), scan(n)))
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ATTRS })

  // the theme's own picture sits in a style variable
  const style = document.documentElement.style
  new MutationObserver(() => {
    const v = style.getPropertyValue('--picture')
    const m = /url\("(prism:\/\/[^"]+)"\)/.exec(v)
    if (m) void localCopy(api, m[1]!).then((u) => style.getPropertyValue('--picture') === v && style.setProperty('--picture', u ? `url("${u}")` : 'none'))
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
}
