// A conversation-like box that keeps growing, to try the follow-the-bottom behaviour with
// a finger: scripts/scroll-test/README.md.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useStickToBottom as current } from '../../src/renderer/src/lib/stickToBottom'
import { useStickToBottom as before } from './old-stickToBottom'

const which = new URLSearchParams(location.search).get('which') === 'before' ? before : current

function Box(): React.JSX.Element {
  const { ref, stuck } = which<HTMLDivElement>()
  const [rows, setRows] = useState(60)
  const [tick, setTick] = useState(0)
  // a timer ticking, as the conversation's elapsed time does even after a run
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 200)
    return () => clearInterval(t)
  }, [])
  ;(window as unknown as Record<string, unknown>)['grow'] = () => setRows((n) => n + 5)
  ;(window as unknown as Record<string, unknown>)['stuck'] = stuck
  return (
    <div ref={ref} id="box" style={{ height: '100vh', overflowY: 'auto', fontFamily: 'sans-serif' }}>
      {Array.from({ length: rows }, (_, i) => (
        <p key={i} style={{ margin: 0, padding: '10px 12px', borderBottom: '1px solid #ddd' }}>
          Message {i + 1}
        </p>
      ))}
      <p style={{ padding: 12 }}>Working… {tick}</p>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Box />)
