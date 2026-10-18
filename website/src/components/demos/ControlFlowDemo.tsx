'use client'

import { useRef } from 'react'
import { useSignal } from 'react-fine-grained-signals'
import { Match, Show, Switch } from 'react-fine-grained-signals/utils'
import { button, row } from './styles'

export function ControlFlowDemo() {
  const signedIn = useSignal(false)
  const view = useSignal<'list' | 'details' | 'empty'>('list')
  const parentRenders = useRef(0)
  parentRenders.current += 1
  return <div data-demo="control-flow" style={{ display: 'grid', gap: '0.5rem' }}>
    <p data-testid="control-flow-parent-renders">Parent renders: {parentRenders.current}</p>
    <div style={row}>
      <button type="button" style={button} onClick={() => { signedIn.value = !signedIn.value }}>Toggle signed-in</button>
      <button type="button" style={button} onClick={() => { view.value = 'list' }}>List</button>
      <button type="button" style={button} onClick={() => { view.value = 'details' }}>Details</button>
      <button type="button" style={button} onClick={() => { view.value = 'empty' }}>Empty</button>
    </div>
    <Show when={signedIn} fallback={<p data-testid="show-state">Please sign in.</p>}>
      {(value) => <p data-testid="show-state">Signed in: {String(value)}</p>}
    </Show>
    <Switch fallback={<p data-testid="switch-state">Unknown view</p>}>
      <Match when={view} equals="list">{(value) => <p data-testid="switch-state">User {value}</p>}</Match>
      <Match when={view} equals="details">{(value) => <p data-testid="switch-state">User {value}</p>}</Match>
      <Match when={view} equals="empty">{(value) => <p data-testid="switch-state">User {value}</p>}</Match>
    </Switch>
  </div>
}
