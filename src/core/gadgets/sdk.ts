/** The script every gadget UI loads: window.prism inside the sandboxed iframe. */
export const GADGET_SDK_JS = `(() => {
  const pending = new Map();
  let seq = 1;
  const listeners = new Map();
  const readyCbs = [];
  let theme = null;
  function post(msg) { window.parent.postMessage({ __prism: true, ...msg }, '*'); }
  function call(method, args) {
    const id = seq++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post({ type: 'call', id, method, args: args || {} });
    });
  }
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || !m.__prism) return;
    if (m.type === 'result') {
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    } else if (m.type === 'event') {
      for (const cb of listeners.get(m.event) || []) { try { cb(m.data); } catch (e) { console.error(e); } }
      for (const cb of listeners.get('*') || []) { try { cb(m.event, m.data); } catch (e) { console.error(e); } }
    } else if (m.type === 'theme') {
      theme = m.theme;
      const root = document.documentElement;
      for (const [k, v] of Object.entries(theme.vars || {})) root.style.setProperty(k, v);
      document.body && document.body.classList.add('prism-themed');
      for (const cb of listeners.get('theme') || []) { try { cb(theme); } catch (e) { console.error(e); } }
    } else if (m.type === 'ready') {
      for (const cb of readyCbs) { try { cb(); } catch (e) { console.error(e); } }
    } else if (m.type === 'press') {
      // A demo pressing something in here. It is asked twice: once to find out where
      // the thing is, so the pointer can glide to it, and again to actually press it.
      var found = null;
      try {
        var all = Array.prototype.slice.call(document.querySelectorAll('button, [role=button], .chip, .toggle, .row, .tile, .shot, .stem'));
        var want = String(m.find || '').toLowerCase();
        var hits = all.filter(function (el) { return (el.textContent || '').trim().toLowerCase().indexOf(want) >= 0 });
        // A row holding a button contains that button's words too, so it matches as
        // readily as the button does — and then "the second thing saying On" is a row
        // nothing happens when you press. Keep only the innermost matches, and let an
        // exact label win over one that merely contains the word.
        hits = hits.filter(function (el) { return !hits.some(function (other) { return other !== el && el.contains(other) }) });
        var exact = hits.filter(function (el) { return (el.textContent || '').trim().toLowerCase() === want });
        if (exact.length) hits = exact;
        var el = hits[m.nth || 0];
        if (el) {
          var r = el.getBoundingClientRect();
          found = { x: r.left, y: r.top, width: r.width, height: r.height };
          if (m.press) el.click();
        }
      } catch (e) { found = null }
      post({ type: 'press-result', id: m.id, found: found });
    } else if (m.type === 'inspect') {
      let report = null;
      try { report = inspect(); } catch (e) { report = { width: 0, height: 0, issues: ['layout check failed: ' + e.message] }; }
      post({ type: 'inspect-result', id: m.id, report });
    }
  });
  // Plain-words layout problems, for models that cannot look at a picture.
  function inspect() {
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const issues = [];
    const name = (el) => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      const c = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      if (c) s += '.' + c;
      const t = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
      return t ? s + ' "' + t + '"' : s;
    };
    const scrolls = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
    const ownText = (el) => { for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true; return false; };
    const wide = document.documentElement.scrollWidth - vw;
    if (wide > 1) issues.push('the whole page is ' + wide + 'px wider than the panel (sideways scrollbar)');
    for (const el of document.body.querySelectorAll('*')) {
      if (issues.length >= 24) break;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > vh) continue;
      const inScroller = scrolls(el);
      if (!inScroller && r.right > vw + 1) { issues.push(name(el) + ' runs ' + Math.round(r.right - vw) + 'px past the right edge of the panel'); continue; }
      const spill = el.scrollWidth - el.clientWidth;
      if (spill > 1 && (ownText(el) || el.tagName === 'BUTTON')) {
        if (cs.overflowX === 'visible') issues.push(name(el) + ': its content spills out by ' + spill + 'px');
        else if (cs.overflowX === 'hidden' && cs.textOverflow !== 'ellipsis') issues.push(name(el) + ': text is cut off by ' + spill + 'px with no "…"');
      }
      const p = el.parentElement;
      if (p && p !== document.body && /^(BUTTON|INPUT|SELECT|IMG|A)$/.test(el.tagName)) {
        const pcs = getComputedStyle(p);
        if (pcs.overflowX === 'visible' && !inScroller) {
          const pr = p.getBoundingClientRect();
          const out = Math.max(r.right - pr.right, pr.left - r.left, r.bottom - pr.bottom);
          if (out > 2) issues.push(name(el) + ' hangs ' + Math.round(out) + 'px outside ' + name(p).split(' "')[0]);
        }
      }
    }
    return { width: vw, height: vh, issues };
  }
  const prism = {
    /** Call a backend handler by name (defined in backend.mjs handlers). */
    call,
    /** Subscribe to events the backend emits with api.emit(event, data). '*' gets everything. */
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(cb); return () => listeners.get(event).delete(cb); },
    ready(cb) { readyCbs.push(cb); },
    get theme() { return theme; },
    agent: { send: (text) => call('__host', { method: 'agent.send', args: { text } }) },
    ui: {
      toast: (title, detail) => call('__host', { method: 'ui.toast', args: { title, detail } }),
      openFile: (path) => call('__host', { method: 'ui.openFile', args: { path } }),
      openPreview: (path) => call('__host', { method: 'ui.openPreview', args: { path } }),
      show: () => call('__host', { method: 'ui.show', args: {} }),
      attach: (path, note) => call('__host', { method: 'ui.attach', args: { path, note } }),
      notify: (title, body) => call('__host', { method: 'ui.notify', args: { title, body } })
    },
    capture: (url, opts) => call('__host', { method: 'page.capture', args: { url, ...(opts || {}) } }),
    secrets: {
      get: (key) => call('__host', { method: 'secret.get', args: { key } }),
      set: (key, value) => call('__host', { method: 'secret.set', args: { key, value } })
    },
    workspace: {
      read: (path) => call('__host', { method: 'workspace.read', args: { path } }),
      write: (path, content) => call('__host', { method: 'workspace.write', args: { path, content } }),
      list: (path) => call('__host', { method: 'workspace.list', args: { path } })
    },
    state: {
      get: (key, fallback) => call('__host', { method: 'state.get', args: { key, fallback } }),
      set: (key, value) => call('__host', { method: 'state.set', args: { key, value } })
    },
    shell: (command, opts) => call('__host', { method: 'shell', args: { command, ...(opts || {}) } })
  };
  window.prism = prism;
  post({ type: 'hello' });
})();`

/** CSS every gadget can rely on: Prism's tokens, mapped from the host theme. */
export const GADGET_BASE_CSS = `
:root { color-scheme: dark; }
body.prism-themed {
  margin: 0; background: var(--bg, #0b0d13); color: var(--text, #e9ecf4);
  font-family: var(--font-ui, 'Inter Variable', system-ui, sans-serif); font-size: 13px; line-height: 1.5;
}
body.prism-themed button { font: inherit; color: inherit; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12); border-radius: 7px; padding: 4px 10px; cursor: pointer; }
body.prism-themed button:hover { background: rgba(255,255,255,.09); }
body.prism-themed button.primary { color: var(--accent, #8ad8ff); border-color: color-mix(in srgb, var(--accent, #8ad8ff) 45%, transparent); background: color-mix(in srgb, var(--accent, #8ad8ff) 14%, transparent); }
body.prism-themed input, body.prism-themed select, body.prism-themed textarea { font: inherit; color: inherit; background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.12); border-radius: 7px; padding: 5px 9px; }
body.prism-themed .card { border: 1px solid rgba(255,255,255,.07); border-radius: 10px; background: rgba(255,255,255,.025); padding: 10px 12px; }
body.prism-themed .mono { font-family: var(--font-mono, 'JetBrains Mono Variable', monospace); }
body.prism-themed .dim { color: var(--text-2, #a7aec0); }
body.prism-themed .accent { color: var(--accent, #8ad8ff); }
body.prism-themed ::-webkit-scrollbar { width: 9px; height: 9px; }
body.prism-themed ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); border-radius: 6px; }
`

/** Reference the agent reads (gadget_sdk) before writing a gadget. Kept short on purpose. */
export const GADGET_SDK_DOC = `# Prism gadget SDK

A gadget is a folder: gadget.json + index.html (+ backend.mjs). Write them with gadget_write({ id, files }); send only the files that change.
Project gadgets live in .prism/gadgets/<id>/ inside the workspace, so small later edits can use edit_file there. They hot-reload.

## gadget.json
{ "id": "vm-fleet", "name": "VM fleet", "description": "...", "backend": "backend.mjs",
  "dependencies": { "ws": "^8" },
  "permissions": { "shell": true, "network": true, "workspace": "read" } }
- id: lowercase letters/digits/dashes. "backend" is optional: leave it out for UI-only gadgets.
- dependencies (optional): npm packages. Prism installs them into the gadget folder before the backend starts.
- permissions are declarative (shown to the user); a backend is real Node and can do anything.

## index.html (the UI, sandboxed iframe)
Include the SDK and base styles first:
  <link rel="stylesheet" href="prism-gadget://_sdk/base.css">
  <script src="prism-gadget://_sdk/prism.js"></script>
Then use window.prism:
- prism.ready(cb)                       run when the host is connected (theme applied, backend started)
- prism.call(method, args) → Promise    call a backend handler
- prism.on(event, cb)                   receive backend api.emit(event, data); prism.on('*', (ev, data) => …) for all
- prism.theme                           { vars: { '--bg', '--text', '--accent', … } }; the CSS vars are also applied to :root
- prism.agent.send(text)                ask the agent to do something (goes to the active session as a user message)
- prism.ui.toast(title, detail) / prism.ui.openFile(path) / prism.ui.openPreview(path) / prism.ui.show()
- prism.ui.attach(path, note)          hand the user a file as a card in their conversation (the phone can download it)
- prism.ui.notify(title, body)         news for the user, on their phone too when Prism is out of sight
- prism.capture(url, { width, height, scale, waitMs }) → { mime, base64 }   a picture of a web page or HTML file
- prism.secrets.get(key) / set(key, value)   passwords and keys, kept encrypted (never put them in state or files)
- prism.workspace.read(path) / write(path, content) / list(path)   (per permissions.workspace)
- prism.state.get(key, fallback) / set(key, value)                  small persistent values per gadget
- prism.shell(command, { cwd?, timeoutMs? }) → { code, stdout, stderr }  (per permissions.shell)
Style: base.css gives dark HUD defaults; use var(--accent), var(--mint), var(--amber), var(--rose), .card, .mono, .dim, button.primary.
Optional kit (after base.css): <link rel="stylesheet" href="prism-gadget://_sdk/kit.css"> <script src="prism-gadget://_sdk/kit.js"></script>
gives the look of the gadgets that come with Prism: .k-app/.k-top/.k-title/.k-body (header + scrolling body), .k-tabs/.k-tab.on,
.k-card, .k-row, .k-grow, .k-list/.k-item, .k-dot.ok|warn|bad|run, .k-pill.ok|warn|bad, .k-log, .k-empty, .k-field, .k-grid, .k-stat,
.k-ask (a question waiting for the user), .k-table, .k-bar > i, .k-steps/.k-step/.k-num; and window.kit: h(tag, attrs, ...children),
mount(el, ...children), bytes(n), ago(ts), dur(ms), toast(text), copy(text), act(asyncFn, doneText), ask(question, yes, no) → Promise<boolean>,
tabs([[id, label]], current, pick).
The panel can be any size, from about 300px wide to full screen, and the user resizes it freely. Build for that:
start your CSS with  *, *::before, *::after { box-sizing: border-box }  and  html, body { height: 100%; margin: 0 };
use flex/grid with flex-wrap and min-width: 0 on flex children; grids as repeat(auto-fit, minmax(140px, 1fr));
long text gets overflow: hidden; text-overflow: ellipsis; white-space: nowrap; button rows wrap; nothing has a fixed pixel width
wider than 280px; the main area scrolls (overflow: auto) instead of pushing things off the panel.
No localStorage/cookies (sandboxed): use prism.state. Fetching http://127.0.0.1:<port> served by the backend works.

## backend.mjs (optional; its own Node process, ES module)
export default {
  async start(api) { /* called once. Keep it quick: timers, light setup. Do not boot machines here. */ },
  async stop(api) { /* clean up */ },
  handlers: {
    // the UI calls these with prism.call('name', args); the agent can call them with gadget_call
    async list(args, api) { return [...] },
  },
  tools: [
    // shown to the agent as gadget__<id>__<name>; same schema style as any tool
    { name: 'vm_start', description: 'Start a VM by name', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      async execute(args, api) { ...; return 'started ' + args.name /* or { content, isError, images: [{ mime, base64 }] } */ } }
  ]
}
api inside the backend:
- api.emit(event, data)        push to the UI (prism.on)
- api.log(...)                 appears in the gadget's log
- api.shell(cmd, { cwd?, timeoutMs? }) → { code, stdout, stderr }
- api.spawn(cmd, args, { cwd?, env?, shell?, onData(chunk, stream), onExit(code) }) → { pid, write(data), kill(), exited }
  long-lived processes (VMs, servers, watchers). Keep handles in module scope. kill() takes the whole process tree,
  and everything spawned is killed when the backend stops.
- api.serve((req, res) => …) → Promise<{ url, port, close }>   local web server on a free port (CORS open), for audio/video,
  screen streams (MJPEG), file downloads, or a WebSocket upgrade on the returned .server
- api.dataDir                  folder for big or changing files (disk images, caches, downloads, screenshots)
- api.dir (gadget folder), api.root (workspace root path, '' if none)
- api.workspace.read/write/list, api.state.get/set, api.agent.send(text), api.ui.toast/openFile/openPreview/show
- api.ui.attach(path, note), api.ui.notify(title, body), api.capture(url, opts), api.secrets.get/set: as on the page
Never write changing files into the gadget folder: it is watched. Use api.dataDir or api.state.

## What reloads when
- backend.mjs, any .mjs/.cjs, gadget.json, files under backend/ server/ lib/ → the backend restarts (what it spawned is killed).
- index.html and other UI files → only the panel refreshes; the backend and its processes keep running.
So the UI must rebuild its whole view from the backend when it loads (call a state/list handler inside prism.ready)
and never assume it saw earlier events.

## Pattern: a fleet the user watches and you drive
Works for VMs, containers, browsers, devices, game servers, terminals, anything with several "machines".
backend:
- const machines = new Map()  // id → { id, name, status, proc, lastScreen … }
- handlers list(), start({ id }), stop({ id }), screen({ id }), input({ id, … }): the UI uses these.
- tools with the same operations for you: fleet_list, fleet_start, fleet_stop, fleet_screen, fleet_type / fleet_click / fleet_run.
  fleet_screen should return { content: 'what is on it', images: [{ mime: 'image/png', base64 }] } so you can see the machine.
- api.emit('status', machine) when one changes; api.emit('screen', { id, … }) for new frames (a few per second at most;
  for smooth video serve MJPEG from api.serve and point an <img> at it). api.emit('activity', { id, by: 'agent' | 'user' }).
ui:
- one large view of the selected machine, a strip of small tiles for the rest, ←/→ and click to cycle, a status dot each,
  a clear highlight on the machine the agent is touching, and a way to hand one to the agent:
  prism.agent.send('In VM fleet, on machine web-2: …').
Getting screens and input: QEMU → QMP screendump / sendkey, or VNC; VirtualBox → VBoxManage controlvm <vm> screenshotpng <file> / keyboardputstring;
Hyper-V → PowerShell; Docker → docker exec / logs. Check what is installed first (api.shell('where qemu-system-x86_64'))
and tell the user plainly when something has to be installed.

## Lifecycle and checking your work
- The backend starts when the panel opens or you first call one of its tools.
- Tools returning images ({ images: [{ mime, base64 }] }) are shown to the user and to vision-capable models.
- After gadget_write, call gadget_open({ id }) so the user sees it. gadget_look({ id }) gives you a picture of the panel
  and a written layout check (what spills, hangs out or is cut off) at the current size and at 340px wide, so you can
  fix layout even when you cannot see pictures. gadget_read({ id }) shows the files and the recent log.
  Run gadget_look after every UI change and fix what it reports before you say it is done.
- Keep the UI calm: dark, few colours, clear states, plain words. No technical jargon on screen.
`
