/** @jsxImportSource react-fine-grained-signals */
'use client'

import { useComputed, useSignal } from 'react-fine-grained-signals'
import { field, muted, row } from './styles'

export function FormBindingDemo() {
  const name = useSignal('Ada')
  const plan = useSignal('basic')
  const region = useSignal('eu')
  const formats = useSignal<string[]>(['json'])
  const features = useSignal<string[]>(['search'])
  const subscribed = useSignal(true)
  const summary = useComputed(
    () => `${name.value || 'Anonymous'} · ${plan.value} · ${region.value} · ${formats.value.join('+')} · ${features.value.join(', ') || 'no features'} · ${subscribed.value ? 'subscribed' : 'not subscribed'}`,
  )

  const applyPreset = () => {
    name.value = 'Grace'
    plan.value = 'pro'
    region.value = 'us'
    formats.value = ['csv', 'json']
    features.value = ['search', 'export']
    subscribed.value = false
  }

  return (
    <form data-demo="form" style={{ display: 'grid', gap: '0.5rem' }} onSubmit={(event) => event.preventDefault()}>
      <label style={row}>Name <input name="name" style={field} bindValue={name} /></label>
      <fieldset style={{ ...row, border: 0, margin: 0, padding: 0 }}>
        <legend style={muted}>Plan</legend>
        <label><input type="radio" name="plan" value="basic" bindValue={plan} /> Basic</label>
        <label><input type="radio" name="plan" value="pro" bindValue={plan} /> Pro</label>
      </fieldset>
      <label style={row}>Region (single select)
        <select aria-label="Region" style={field} bindValue={region}>
          <option value="eu">Europe</option><option value="us">United States</option><option value="apac">Asia Pacific</option>
        </select>
      </label>
      <label style={row}>Export formats (multiple select)
        <select aria-label="Export formats" multiple style={field} bindValue={formats}>
          <option value="csv">CSV</option><option value="json">JSON</option><option value="xml">XML</option>
        </select>
      </label>
      <fieldset style={{ ...row, border: 0, margin: 0, padding: 0 }}>
        <legend style={muted}>Features</legend>
        <label><input type="checkbox" name="features" value="search" bindValue={features} /> Search</label>
        <label><input type="checkbox" name="features" value="export" bindValue={features} /> Export</label>
      </fieldset>
      <label style={row}><input type="checkbox" bindChecked={subscribed} /> Subscribe to updates</label>
      <div style={row}><button type="button" onClick={applyPreset}>Apply Signal preset</button></div>
      <output data-testid="summary">{summary}</output>
    </form>
  )
}
