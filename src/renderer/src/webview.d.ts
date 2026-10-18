// <webview> is an Electron element, unknown to React's types.
import 'react'

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { src?: string; partition?: string }, HTMLElement>
    }
  }
}
