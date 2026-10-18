import { Children, createElement, memo, useMemo, type ReactNode } from 'react'
import { openLink } from '@/lib/open'
import { cx } from '@/lib/format'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'
import { Diagram } from './Diagram'
import { prism } from '@/lib/ipc'

function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children)
  return ''
}

type Positioned = { node?: { position?: { start?: { line?: number } } } }

/** Block elements carry data-line (their line in the source) when sourceLines is on, so a preview can follow an editor. */
function lined(tag: string) {
  return function Lined({ node, ...props }: Positioned & { children?: ReactNode }): React.JSX.Element {
    return createElement(tag, { 'data-line': node?.position?.start?.line, ...props })
  }
}

const LINED = Object.fromEntries(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'table', 'hr'].map((t) => [t, lined(t)])) as Components

/** Finds the words in an answer that a step backs up (a file it changed, a command it ran, "tests pass"). */
export interface Linker {
  inText(s: string): Array<string | { text: string; id: string }>
  inCode(s: string): string | null
}

function linkify(children: ReactNode, link: Linker): ReactNode {
  return Children.map(children, (c) => {
    if (typeof c !== 'string') return c
    const parts = link.inText(c)
    return parts.length === 1 && typeof parts[0] === 'string' ? c : parts.map((p, i) => (typeof p === 'string' ? p : <span key={i} className="ln" data-step={p.id}>{p.text}</span>))
  })
}

function linked(tag: string, link: Linker) {
  return function Linked({ node: _node, children, ...props }: Positioned & { children?: ReactNode }): React.JSX.Element {
    return createElement(tag, props, linkify(children, link))
  }
}

export const Markdown = memo(function Markdown({ text, onOpenFile, sourceLines, link }: { text: string; onOpenFile?: (path: string) => void; sourceLines?: boolean; link?: Linker }): React.JSX.Element {
  const linkedTags = useMemo(() => (link ? (Object.fromEntries(['p', 'li', 'td', 'strong', 'em'].map((t) => [t, linked(t, link)])) as Components) : {}), [link])
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          ...(sourceLines ? LINED : {}),
          ...linkedTags,
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                if (!href) return
                if (/^https?:/i.test(href)) openLink(href)
                else onOpenFile?.(href.replace(/^\.\//, ''))
              }}
            >
              {children}
            </a>
          ),
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, node, ...rest }) => {
            const m = /language-([\w+-]+)/.exec(className ?? '')
            const raw = textOf(children)
            const isBlock = m !== null || raw.includes('\n')
            if (!isBlock) {
              const id = link?.inCode(raw)
              if (id) {
                return (
                  <code className={cx(className, 'ln')} data-step={id} {...rest}>
                    {children}
                  </code>
                )
              }
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              )
            }
            const block = m?.[1] === 'mermaid' ? <Diagram code={raw.replace(/\n$/, '')} /> : <CodeBlock code={raw.replace(/\n$/, '')} lang={m?.[1]} />
            return sourceLines ? <div data-line={(node as Positioned['node'])?.position?.start?.line}>{block}</div> : block
          }
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
