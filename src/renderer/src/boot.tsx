import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/nunito'
import '@fontsource-variable/space-grotesk'
import './styles/fonts.css'
import 'dockview/dist/styles/dockview.css'
import '@xterm/xterm/css/xterm.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/dock.css'
import './styles/hud.css'
import './styles/panels.css'
import './styles/agent.css'
import './styles/markdown.css'
import './styles/polish.css'
import './lib/spotlight'
import { App } from './App'
import { useApp } from './state/app'
import { useSessions } from './state/sessions'
import { useLayout } from './state/layout'
import { useEditor } from './state/editor'
import { useUi } from './state/ui'
import { useLooking } from './state/looking'
import { useTerminals } from './state/terminals'
import { editorFor } from './lib/editorBus'
import { bootMark } from './lib/bootMark'

bootMark('app code loaded')

if (import.meta.env.DEV || window.prism?.debug) {
  // Development, or started with a debugging port: lets a DevTools session drive the app for automated checks.
  ;(window as unknown as { __prism: unknown }).__prism = { useApp, useSessions, useLayout, useEditor, useUi, useTerminals, editorFor, voice: () => import('./lib/voice'), multiverse: () => import('./panels/multiverse/Multiverse'), demo: () => import('./demo/player'), demos: () => import('./demo/firstDemo'), useLooking }
}

bootMark('putting up the app')
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
