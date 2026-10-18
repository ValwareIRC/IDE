// One demo, written by hand, to find out whether watching Prism drive itself is
// a pleasure or a chore. Everything it touches outside its own scratch file is
// read only.
import type { Demo } from './script'

const STAGE = '.prism/demo-stage/anchor.mjs'

export const firstDemo: Demo = {
  title: 'How a tour finds its place again',
  stage: [
    {
      path: STAGE,
      content: `// The demo made this file, and deletes it when it ends.
const lines = ['function hello() {', '  return 1', '}']

// the demo writes a function here
console.log('line:', lineOf(lines, 'return 1'))
`
    }
  ],
  steps: [
    { do: 'say', say: "A tour points at lines of code, and code moves. Let's find out how a tour still knows where to go." },

    { do: 'rail', view: 'search', say: 'When you want to find something in a codebase, start in **Search**. It is the panel on the left, and it beats guessing which file.' },
    { do: 'search.type', query: 'findAnchor', say: 'I only know the name of the thing I am after, so I will type that.' },
    { do: 'search.open', file: 'src/core/agent/tools/tour.ts', say: 'Several files mention it. This is the one that **defines** it, so that is the one to open.' },

    {
      do: 'spotlight',
      file: 'src/core/agent/tools/tour.ts',
      anchor: 'export function findAnchor(content: string, anchor: string, line?: number): number | null {',
      select: 'anchor',
      say: 'Here it is. The second thing it takes is called `anchor` — and that word is the whole idea.',
      pace: 0.8
    },
    {
      do: 'spotlight',
      file: 'src/core/agent/tools/tour.ts',
      anchor: 'const exact = lines.findIndex((l) => l.trim() === want)',
      select: 'l.trim() === want',
      say: 'A tour step does not remember a line **number**. It remembers the line\'s **text**, and looks for that text again. Move the code and the step follows it.',
      pace: 0.8
    },
    { do: 'spotlight', file: 'src/core/agent/tools/tour.ts', anchor: 'const part = lines.findIndex((l) => l.includes(want))', say: 'If the line was edited rather than moved, it settles for finding the text somewhere inside a line.' },
    { do: 'spotlight.off' },

    { do: 'rail', view: 'explorer', say: 'Now your turn to see it work. Back to the **Explorer**.' },
    { do: 'tree.expand', path: '.prism/demo-stage', say: 'The demo made itself a scratch file to play in. Nothing of yours is touched.' },
    { do: 'tree.open', path: STAGE },
    {
      do: 'type',
      file: STAGE,
      after: '// the demo writes a function here',
      text: `function lineOf(lines, want) {
  const i = lines.findIndex((l) => l.trim() === want)
  return i >= 0 ? i + 1 : null
}`,
      say: 'That is the same trick in four lines: find the text, report which line it turned out to be on.',
      pace: 0.9
    },
    { do: 'save', file: STAGE, say: 'Ctrl+S. Typed is not saved, and the thing about to run it reads the file from disk.' },
    { do: 'terminal', command: `node ${STAGE}`, say: 'And now we run it for real — this is a real terminal, so this is really running.' },
    { do: 'await.output', match: 'line: 2', say: 'Waiting for node.' },
    { do: 'say', say: '`line: 2` — it found `return 1` on the second line. That is how a tour written months ago still lands on the right place today.' }
  ]
}
