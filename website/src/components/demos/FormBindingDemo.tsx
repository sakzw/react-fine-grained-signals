/** @jsxImportSource react-fine-grained-signals */
'use client'

import { useComputed, useSignal } from 'react-fine-grained-signals'
import { field, muted, row } from './styles'

/**
 * `bindValue` / `bindChecked` keep the DOM and the signal in sync without
 * re-rendering this component; signal children update their own text node.
 */
export function FormBindingDemo() {
  const name = useSignal('Ada')
  const plan = useSignal('basic')
  const features = useSignal<string[]>(['search'])
  const subscribed = useSignal(true)
  const summary = useComputed(
    () => `${name.value || 'Anonymous'} · ${plan.value} · ${features.value.join(', ') || 'no features'} · ${subscribed.value ? 'subscribed' : 'not subscribed'}`,
  )

  return (
    <form data-demo="form" style={{ display: 'grid', gap: '0.5rem' }} onSubmit={(event) => event.preventDefault()}>
      <label style={row}>
        Name <input name="name" style={field} bindValue={name} />
      </label>
      <fieldset style={{ ...row, border: 0, margin: 0, padding: 0 }}>
        <legend style={muted}>Plan</legend>
        <label><input type="radio" name="plan" value="basic" bindValue={plan} /> Basic</label>
        <label><input type="radio" name="plan" value="pro" bindValue={plan} /> Pro</label>
      </fieldset>
      <fieldset style={{ ...row, border: 0, margin: 0, padding: 0 }}>
        <legend style={muted}>Features</legend>
        <label><input type="checkbox" name="features" value="search" bindValue={features} /> Search</label>
        <label><input type="checkbox" name="features" value="export" bindValue={features} /> Export</label>
      </fieldset>
      <label style={row}>
        <input type="checkbox" bindChecked={subscribed} /> Subscribe to updates
      </label>
      <output data-testid="summary">{summary}</output>
    </form>
  )
}
