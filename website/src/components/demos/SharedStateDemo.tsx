'use client'

import { useRef } from 'react'
import { signal, useSignalValue } from 'react-fine-grained-signals'
import { button, muted, row } from './styles'

// Client-only module state: never use this pattern for request-specific SSR data.
const sharedCount = signal(0)
function useRenderCount() { const count = useRef(0); count.current += 1; return count.current }

function ManagedReader() {
  const renders = useRenderCount()
  return <p data-testid="managed-reader">Managed reader: {sharedCount.value} · renders {renders}</p>
}

function HookReader() {
  const value = useSignalValue(sharedCount)
  const renders = useRenderCount()
  return <p data-testid="hook-reader">Hook reader: {value} · renders {renders}</p>
}

export function SharedStateDemo() {
  const renders = useRenderCount()
  return <section data-demo="shared-state" style={{ display: 'grid', gap: '0.5rem' }}>
    <p data-testid="shared-owner-renders" style={muted}>Demo owner renders: {renders}</p>
    <div style={row}>
      <button type="button" style={button} onClick={() => { sharedCount.value-- }}>−</button>
      <button type="button" style={button} onClick={() => { sharedCount.value++ }}>+</button>
      <button type="button" style={button} onClick={() => { sharedCount.value = 0 }}>Reset shared signal</button>
    </div>
    <ManagedReader />
    <HookReader />
  </section>
}
