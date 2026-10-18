// Accessibility checks for pages Prism shows: whether people who cannot see well, use a
// screen reader, cannot use a mouse or cannot hear can use what is being built.
//
// The rules are axe-core's (the checker most accessibility audits use), run inside the
// page. Prism adds two things axe does not look for: text too small to read, and pages
// that make sound, whose words must also be on screen. What it finds is put in plain
// words, worst first, with where each problem is on the page.
import axeSource from 'axe-core/axe.min.js?raw'
import type { A11yFinding, A11yReport } from '@shared/a11y'

/** The rules people meet most, said the way a person would. Anything else uses axe's own words. */
const PLAIN: Record<string, { what: string; who: string }> = {
  'color-contrast': { what: 'Text that is hard to read against its background', who: 'people with low vision, and anyone in bright light' },
  'color-contrast-enhanced': { what: 'Text with less contrast than the strictest standard asks', who: 'people with low vision' },
  'image-alt': { what: 'Pictures with no description', who: 'people using a screen reader' },
  'input-image-alt': { what: 'Picture buttons with no description', who: 'people using a screen reader' },
  'svg-img-alt': { what: 'Drawings marked as pictures with no description', who: 'people using a screen reader' },
  'role-img-alt': { what: 'Pictures with no description', who: 'people using a screen reader' },
  'button-name': { what: 'Buttons a screen reader cannot name', who: 'people using a screen reader or voice control' },
  'link-name': { what: 'Links with no words', who: 'people using a screen reader or voice control' },
  label: { what: 'Form fields with no label', who: 'people using a screen reader or voice control' },
  'select-name': { what: 'Drop-down lists with no label', who: 'people using a screen reader' },
  'input-button-name': { what: 'Buttons with no words', who: 'people using a screen reader' },
  'target-size': { what: 'Things too small or too close together to tap', who: 'people with shaky hands, and everyone on a phone' },
  'html-has-lang': { what: 'The page does not say what language it is in', who: 'screen readers, which then pronounce it wrongly' },
  'html-lang-valid': { what: 'The page names a language that does not exist', who: 'screen readers' },
  'document-title': { what: 'The page has no title', who: 'people using a screen reader or many tabs' },
  'meta-viewport': { what: 'Zooming in is turned off', who: 'people with low vision' },
  'meta-viewport-large': { what: 'Zooming in is limited', who: 'people with low vision' },
  'heading-order': { what: 'Headings skip levels', who: 'people finding their way with a screen reader' },
  'page-has-heading-one': { what: 'The page has no main heading', who: 'people finding their way with a screen reader' },
  'empty-heading': { what: 'Headings with no words', who: 'people using a screen reader' },
  region: { what: 'Content outside the page’s landmarks', who: 'people jumping around with a screen reader' },
  'landmark-one-main': { what: 'The page has no main area marked', who: 'people jumping around with a screen reader' },
  'aria-allowed-attr': { what: 'Screen-reader hints that do not belong on that element', who: 'people using a screen reader' },
  'aria-required-attr': { what: 'Screen-reader hints missing a part they need', who: 'people using a screen reader' },
  'aria-valid-attr-value': { what: 'Screen-reader hints with values that mean nothing', who: 'people using a screen reader' },
  'aria-hidden-focus': { what: 'Things hidden from screen readers that can still be reached with the keyboard', who: 'people using a screen reader' },
  'aria-command-name': { what: 'Controls a screen reader cannot name', who: 'people using a screen reader' },
  'aria-toggle-field-name': { what: 'Switches and checkboxes with no name', who: 'people using a screen reader' },
  'aria-dialog-name': { what: 'Dialogs with no name', who: 'people using a screen reader' },
  'nested-interactive': { what: 'Buttons or links inside other buttons or links', who: 'people using a keyboard or screen reader' },
  'scrollable-region-focusable': { what: 'Scrolling areas the keyboard cannot reach', who: 'people who use the keyboard instead of a mouse' },
  'frame-title': { what: 'Embedded frames with no title', who: 'people using a screen reader' },
  'duplicate-id-aria': { what: 'Two things share a name that labels rely on', who: 'people using a screen reader' },
  'list': { what: 'Lists built wrongly', who: 'people using a screen reader' },
  listitem: { what: 'List items outside a list', who: 'people using a screen reader' },
  'video-caption': { what: 'Videos with no captions', who: 'people who are deaf or hard of hearing, or cannot play sound' },
  'audio-caption': { what: 'Sound with no words on screen', who: 'people who are deaf or hard of hearing, or cannot play sound' },
  'no-autoplay-audio': { what: 'Sound that plays by itself', who: 'people using a screen reader, whose speech it drowns out' },
  'link-in-text-block': { what: 'Links that can only be told apart from text by colour', who: 'people who see colour differently' },
  'focus-order-semantics': { what: 'Things the keyboard reaches that are not marked as controls', who: 'people using the keyboard' },
  'tabindex': { what: 'A keyboard order forced out of the page’s own order', who: 'people using the keyboard' },
  'prism-small-text': { what: 'Text smaller than 12 pixels', who: 'people with low vision, and anyone on a phone' },
  'prism-sound': { what: 'The page makes sound', who: 'people who cannot hear it: what it says should also be on screen' }
}

/** Run inside the page: loads axe (once) and returns its findings with Prism's own two checks. */
export function auditScript(): string {
  return `(async () => {
  if (!window.axe) { ${axeSource}\n }
  const rect = (el) => { if (!el || !el.getBoundingClientRect) return null; const r = el.getBoundingClientRect(); return r.width || r.height ? { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) } : null };
  const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] });
  const findings = r.violations.map((v) => ({ id: v.id, impact: v.impact || 'minor', help: v.help, helpUrl: v.helpUrl,
    nodes: v.nodes.slice(0, 25).map((n) => { const sel = Array.isArray(n.target) ? n.target.flat().join(' ') : String(n.target); let el = null; try { el = document.querySelector(sel) } catch {} return { target: sel, html: String(n.html || '').slice(0, 300), rect: rect(el), detail: String(n.failureSummary || '').replace(/^Fix (any|all) of the following:\\s*/i, '').slice(0, 400) } }) }));
  // text too small to read
  const small = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode() && small.length < 25) {
    const t = walker.currentNode; const el = t.parentElement;
    if (!el || seen.has(el) || !t.textContent.trim()) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    const size = parseFloat(cs.fontSize);
    const box = rect(el);
    if (size && size < 12 && box && box.width > 0) small.push({ target: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''), html: el.outerHTML.slice(0, 200), rect: box, detail: 'The text is ' + size + 'px: "' + t.textContent.trim().slice(0, 60) + '"' });
  }
  if (small.length) findings.push({ id: 'prism-small-text', impact: 'moderate', help: 'Text should be at least 12 pixels', helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/resize-text', nodes: small });
  // sound: media, and sound files the page has loaded
  const media = [...document.querySelectorAll('audio, video')].filter((m) => !m.muted || m.tagName === 'AUDIO');
  const sounds = performance.getEntriesByType('resource').filter((e) => /\\.(mp3|wav|ogg|m4a|aac|opus|flac)(\\?|$)/i.test(e.name));
  if (media.length || sounds.length) findings.push({ id: 'prism-sound', impact: 'moderate', help: 'Anything the page says out loud should also be shown as words', helpUrl: 'https://www.w3.org/WAI/media/av/', nodes: [...media.slice(0, 10).map((m) => ({ target: m.tagName.toLowerCase() + (m.id ? '#' + m.id : ''), html: m.outerHTML.slice(0, 200), rect: rect(m), detail: m.querySelector('track[kind=captions], track[kind=subtitles]') ? 'It has captions: check they say everything.' : 'No captions or transcript is attached.' })), ...sounds.slice(0, 5).map((s) => ({ target: s.name.split('/').pop(), html: '', rect: null, detail: 'The page loaded this sound file.' }))] });
  return { findings, passed: r.passes ? r.passes.length : 0, url: location.href, title: document.title };
})()`
}

/** Draws numbered boxes over the problems, for a picture of the page. Run again with null to take them away. */
export function outlineScript(boxes: Array<{ n: number; rect: { x: number; y: number; width: number; height: number }; impact: string }> | null): string {
  return `(() => {
  document.querySelectorAll('[data-prism-a11y]').forEach((e) => e.remove());
  const boxes = ${JSON.stringify(boxes ?? [])};
  const colour = { critical: '#ff5c7a', serious: '#ff8a4c', moderate: '#f5c97a', minor: '#8ad8ff' };
  for (const b of boxes) {
    const d = document.createElement('div');
    d.setAttribute('data-prism-a11y', '');
    d.style.cssText = 'position:absolute;z-index:2147483647;pointer-events:none;border:2px solid ' + colour[b.impact] + ';border-radius:3px;left:' + (b.rect.x - 2) + 'px;top:' + (b.rect.y - 2) + 'px;width:' + (b.rect.width + 4) + 'px;height:' + (b.rect.height + 4) + 'px';
    const tag = document.createElement('span');
    tag.textContent = String(b.n);
    tag.style.cssText = 'position:absolute;left:-2px;top:-18px;background:' + colour[b.impact] + ';color:#111;font:600 11px system-ui;padding:1px 5px;border-radius:3px';
    d.appendChild(tag);
    document.body.appendChild(d);
  }
  return boxes.length;
})()`
}

/** Highlights the elements of one finding in the live page and scrolls the first into view. */
export function highlightScript(selectors: string[]): string {
  return `(() => {
  document.querySelectorAll('[data-prism-a11y]').forEach((e) => e.remove());
  let first = null;
  for (const s of ${JSON.stringify(selectors.slice(0, 25))}) {
    let el = null; try { el = document.querySelector(s) } catch {}
    if (!el) continue;
    first = first || el;
    const r = el.getBoundingClientRect();
    const d = document.createElement('div');
    d.setAttribute('data-prism-a11y', '');
    d.style.cssText = 'position:absolute;z-index:2147483647;pointer-events:none;border:2px solid #ff8a4c;border-radius:3px;box-shadow:0 0 0 4px rgba(255,138,76,.25);left:' + (r.left + scrollX - 3) + 'px;top:' + (r.top + scrollY - 3) + 'px;width:' + (r.width + 6) + 'px;height:' + (r.height + 6) + 'px';
    document.body.appendChild(d);
  }
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => document.querySelectorAll('[data-prism-a11y]').forEach((e) => e.remove()), 6000);
  return !!first;
})()`
}

const ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 } as const

/** axe's raw results, put in plain words and worst first. */
export function toReport(raw: { findings: Array<Omit<A11yFinding, 'what' | 'who'>>; passed: number; url: string; title: string }): A11yReport {
  const findings = raw.findings
    .map((f) => ({ ...f, impact: (['critical', 'serious', 'moderate', 'minor'].includes(f.impact) ? f.impact : 'minor') as A11yFinding['impact'], what: PLAIN[f.id]?.what ?? f.help, who: PLAIN[f.id]?.who ?? '' }))
    .sort((a, b) => ORDER[a.impact] - ORDER[b.impact] || b.nodes.length - a.nodes.length)
  return { url: raw.url, title: raw.title, findings, passed: raw.passed, at: Date.now() }
}

/** Numbered boxes for the picture, in the same order as reportText numbers them. */
export function boxesFor(r: A11yReport): Array<{ n: number; rect: { x: number; y: number; width: number; height: number }; impact: string }> {
  const out: Array<{ n: number; rect: { x: number; y: number; width: number; height: number }; impact: string }> = []
  let n = 0
  for (const f of r.findings)
    for (const node of f.nodes.slice(0, 6)) {
      n++
      if (node.rect) out.push({ n, rect: node.rect, impact: f.impact })
    }
  return out
}
