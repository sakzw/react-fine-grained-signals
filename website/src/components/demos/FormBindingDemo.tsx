/** @jsxImportSource react-fine-grained-signals */
'use client'

import { useRef } from 'react'
import { useComputed, useSignal } from 'react-fine-grained-signals'
import { field, muted, row } from './styles'

export function FormBindingDemo() {
  const ownerRenders = useRef(0)
  ownerRenders.current += 1
  const name = useSignal('Ada')
  const amount = useSignal('12.5')
  const parsedAmount = useComputed(() => amount.value === '' ? 'empty' : String(Number(amount.value)))
  const level = useSignal('50')
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
    amount.value = '42.5'
    level.value = '75'
    plan.value = 'pro'
    region.value = 'us'
    formats.value = ['csv', 'json']
    features.value = ['search', 'export']
    subscribed.value = false
  }

  return (
    <form data-demo="form" style={{ display: 'grid', gap: '0.5rem' }} onSubmit={(event) => event.preventDefault()}>
      <label style={row}>Name <input name="name" style={field} bindValue={name} /></label>
      <label style={row}>Amount (string signal, number input)
        <input aria-label="Amount" type="number" min="0" max="100" step="0.25" required style={field} bindValue={amount} />
      </label>
      <output data-testid="numeric-summary">Amount text: {amount} · parsed: {parsedAmount}</output>
      <label style={row}>Level (range input, string signal)
        <input aria-label="Level" type="range" min="0" max="100" step="1" bindValue={level} />
      </label>
      <output data-testid="range-summary">Level text: {level}</output>
      <output data-testid="form-owner-renders">Form owner renders: {ownerRenders.current}</output>
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
