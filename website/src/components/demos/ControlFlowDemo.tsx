'use client'

import { useSignal } from 'react-fine-grained-signals'
import { Match, Show, Switch } from 'react-fine-grained-signals/utils'
import { button, row } from './styles'

export function ControlFlowDemo() {
  const signedIn = useSignal(false)
  const view = useSignal<'list' | 'details' | 'empty'>('list')
  return <div data-demo="control-flow" style={{ display: 'grid', gap: '0.5rem' }}>
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
      <Match when={view.value === 'list'}><p data-testid="switch-state">User list</p></Match>
      <Match when={view.value === 'details'}><p data-testid="switch-state">User details</p></Match>
      <Match when={view.value === 'empty'}><p data-testid="switch-state">No users</p></Match>
    </Switch>
  </div>
}
