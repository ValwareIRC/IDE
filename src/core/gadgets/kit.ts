// A few shared pieces for gadget pages, so the ones that come with Prism look like one
// family and a gadget the agent writes can look the same with a line of HTML:
//   <link rel="stylesheet" href="prism-gadget://_sdk/kit.css">
//   <script src="prism-gadget://_sdk/kit.js"></script>
// It sits on top of base.css and uses the same theme colours.

export const GADGET_KIT_CSS = `
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; margin: 0; }
.k-app { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.k-top { display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px; flex-wrap: wrap; border-bottom: 1px solid rgba(255,255,255,.06); }
.k-title { font-weight: 600; font-size: 14px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.k-top .k-title { margin-right: auto; }
.k-sub, .k-hint { color: var(--text-2, #a7aec0); font-size: 12px; }
.k-faint { color: var(--text-3, #6f7689); }
.k-body { flex: 1; min-height: 0; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.k-tabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid rgba(255,255,255,.06); overflow-x: auto; flex: none; }
.k-tabs { scrollbar-width: none; }
.k-tabs::-webkit-scrollbar { display: none; }
body.prism-themed .k-tab { background: none; border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 8px 10px; color: var(--text-2, #a7aec0); white-space: nowrap; }
body.prism-themed .k-tab:hover { background: none; color: var(--text, #e9ecf4); }
body.prism-themed .k-tab.on { color: var(--text, #e9ecf4); border-bottom-color: var(--accent, #8ad8ff); }
.k-card { border: 1px solid rgba(255,255,255,.07); border-radius: 10px; background: rgba(255,255,255,.025); padding: 10px 12px; min-width: 0; }
.k-card > h3, .k-h { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.k-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.k-row.nowrap { flex-wrap: nowrap; }
.k-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.k-grow { flex: 1; min-width: 0; }
.k-list { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.k-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; min-width: 0; }
.k-item.click { cursor: pointer; }
.k-item.click:hover, .k-item.on { background: rgba(255,255,255,.05); }
.k-trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.k-mono { font-family: var(--font-mono, 'JetBrains Mono Variable', monospace); font-size: 12px; }
.k-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3, #6f7689); flex: none; }
.k-dot.ok { background: var(--mint, #7ee2b8); }
.k-dot.warn { background: var(--amber, #f5c97a); }
.k-dot.bad { background: var(--rose, #f59ab0); }
.k-dot.run { background: var(--accent, #8ad8ff); animation: k-pulse 1.1s ease-in-out infinite; }
@keyframes k-pulse { 50% { opacity: .35; } }
.k-pill { display: inline-block; font-size: 11px; line-height: 18px; padding: 0 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,.12); white-space: nowrap; color: var(--text-2, #a7aec0); }
.k-pill.ok { color: var(--mint, #7ee2b8); border-color: color-mix(in srgb, var(--mint, #7ee2b8) 40%, transparent); }
.k-pill.warn { color: var(--amber, #f5c97a); border-color: color-mix(in srgb, var(--amber, #f5c97a) 40%, transparent); }
.k-pill.bad { color: var(--rose, #f59ab0); border-color: color-mix(in srgb, var(--rose, #f59ab0) 40%, transparent); }
.k-pill.accent { color: var(--accent, #8ad8ff); border-color: color-mix(in srgb, var(--accent, #8ad8ff) 40%, transparent); }
.ok-text { color: var(--mint, #7ee2b8); } .warn-text { color: var(--amber, #f5c97a); } .bad-text { color: var(--rose, #f59ab0); }
.k-log { font-family: var(--font-mono, 'JetBrains Mono Variable', monospace); font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; background: rgba(0,0,0,.28); border-radius: 8px; padding: 8px 10px; max-height: 280px; overflow: auto; margin: 0; }
.k-log:empty { display: none; }
.k-empty { text-align: center; color: var(--text-2, #a7aec0); padding: 22px 12px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.k-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.k-field > span { font-size: 12px; color: var(--text-2, #a7aec0); }
.k-field input, .k-field textarea, .k-field select { width: 100%; }
textarea.k-mono, .k-field textarea { resize: vertical; }
.k-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
.k-stat { border: 1px solid rgba(255,255,255,.07); border-radius: 10px; padding: 8px 10px; min-width: 0; }
.k-stat b { display: block; font-size: 18px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.k-stat span { font-size: 11.5px; color: var(--text-2, #a7aec0); }
.k-btns { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
body.prism-themed button { white-space: nowrap; }
body.prism-themed button:disabled { opacity: .45; cursor: default; }
body.prism-themed button.danger { color: var(--rose, #f59ab0); border-color: color-mix(in srgb, var(--rose, #f59ab0) 40%, transparent); }
body.prism-themed button.ghost { background: none; border-color: transparent; }
body.prism-themed button.small { padding: 2px 8px; font-size: 12px; }
.k-ask { border: 1px solid color-mix(in srgb, var(--amber, #f5c97a) 55%, transparent); background: color-mix(in srgb, var(--amber, #f5c97a) 9%, transparent); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.k-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.k-table th { text-align: left; font-weight: 500; color: var(--text-2, #a7aec0); padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,.08); white-space: nowrap; position: sticky; top: 0; background: var(--bg, #0b0d13); }
.k-table td { padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,.04); vertical-align: top; max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
.k-scroll-x { overflow-x: auto; min-width: 0; }
.k-bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,.08); overflow: hidden; min-width: 40px; }
.k-bar > i { display: block; height: 100%; background: var(--accent, #8ad8ff); border-radius: 3px; }
.k-bar > i.warn { background: var(--amber, #f5c97a); } .k-bar > i.bad { background: var(--rose, #f59ab0); } .k-bar > i.ok { background: var(--mint, #7ee2b8); }
.k-steps { display: flex; flex-direction: column; gap: 6px; }
.k-step { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,.07); min-width: 0; flex-wrap: wrap; }
.k-step.on { border-color: color-mix(in srgb, var(--accent, #8ad8ff) 45%, transparent); }
.k-num { width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 11.5px; border: 1px solid rgba(255,255,255,.15); flex: none; color: var(--text-2, #a7aec0); }
.k-num.ok { border-color: var(--mint, #7ee2b8); color: var(--mint, #7ee2b8); }
.k-num.bad { border-color: var(--rose, #f59ab0); color: var(--rose, #f59ab0); }
.k-num.run { border-color: var(--accent, #8ad8ff); color: var(--accent, #8ad8ff); animation: k-pulse 1.1s ease-in-out infinite; }
.k-sep { height: 1px; background: rgba(255,255,255,.06); margin: 2px 0; }
.k-toast { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); background: rgba(20,22,30,.96); border: 1px solid rgba(255,255,255,.12); border-radius: 9px; padding: 7px 12px; font-size: 12.5px; max-width: calc(100% - 24px); z-index: 50; }
details.k-more > summary { cursor: pointer; color: var(--text-2, #a7aec0); font-size: 12px; list-style: none; }
details.k-more > summary::before { content: '▸ '; }
details.k-more[open] > summary::before { content: '▾ '; }
img.k-shot { max-width: 100%; border-radius: 8px; border: 1px solid rgba(255,255,255,.08); display: block; }
.k-modal-back { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; z-index: 60; padding: 16px; }
.k-modal { background: var(--bg-2, #141720); border: 1px solid rgba(255,255,255,.12); border-radius: 12px; padding: 14px 16px; width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 12px; }
.k-modal-text { white-space: pre-wrap; line-height: 1.5; }
.k-modal .k-btns { justify-content: flex-end; }
`

export const GADGET_KIT_JS = `(() => {
  /** h('div', { class: 'k-row', onclick: fn }, 'text', child, [more]) */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    const add = (c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) return c.forEach(add);
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    return el;
  }
  function mount(target, ...kids) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    el.replaceChildren();
    kids.flat().forEach((c) => c != null && c !== false && el.appendChild(c instanceof Node ? c : document.createTextNode(String(c))));
    return el;
  }
  function bytes(n) {
    if (!isFinite(n)) return '';
    const u = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
  }
  function ago(ts) {
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 90) return 'a minute ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' minutes ago';
    const hr = Math.round(m / 60);
    if (hr < 24) return hr === 1 ? 'an hour ago' : hr + ' hours ago';
    const d = Math.round(hr / 24);
    if (d < 30) return d === 1 ? 'yesterday' : d + ' days ago';
    return new Date(ts).toLocaleDateString();
  }
  function dur(ms) {
    if (ms == null || !isFinite(ms)) return '';
    if (ms < 1000) return Math.round(ms) + ' ms';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + ' s';
    const m = Math.floor(s / 60);
    return m + ' min ' + Math.round(s % 60) + ' s';
  }
  let toastTimer = null;
  function toast(text) {
    let el = document.querySelector('.k-toast');
    if (!el) { el = h('div', { class: 'k-toast' }); document.body.appendChild(el); }
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 2600);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { const t = h('textarea', { value: text }); document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); toast('Copied'); }
  }
  /** Runs fn and shows its failure as a toast instead of losing it. */
  async function act(fn, done) {
    try { const r = await fn(); if (done) toast(done); return r; }
    catch (e) { toast(String((e && e.message) || e).replace(/^Error: /, '')); return undefined; }
  }
  /** A yes-or-no question inside the panel: resolves true for yes. */
  function ask(text, yes, no) {
    return new Promise((res) => {
      const close = (v) => { back.remove(); res(v); };
      const back = h('div', { class: 'k-modal-back', onclick: (e) => { if (e.target === back) close(false); } },
        h('div', { class: 'k-modal' },
          h('div', { class: 'k-modal-text' }, text),
          h('div', { class: 'k-btns' }, h('button', { onclick: () => close(false) }, no || 'Cancel'), h('button', { class: 'primary', onclick: () => close(true) }, yes || 'Yes'))));
      document.body.appendChild(back);
      back.querySelector('button.primary').focus();
    });
  }
  function tabs(names, current, pick) {
    return h('div', { class: 'k-tabs' }, names.map(([id, label]) => h('button', { class: 'k-tab' + (id === current ? ' on' : ''), onclick: () => pick(id) }, label)));
  }
  window.kit = { h, mount, bytes, ago, dur, toast, copy, act, ask, tabs };
})();`
