import { contextBridge, ipcRenderer } from 'electron'
import type { PrismApi, Unsubscribe } from '@shared/ipc'
import { makeApi } from '@shared/api'

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: PrismApi = makeApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on,
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  platform: process.platform as PrismApi['platform'],
  debug: !!process.env['PRISM_DEBUG_PORT']
})

contextBridge.exposeInMainWorld('prism', api)
