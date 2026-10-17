'use client'

import { useComputed, useSignal } from 'react-fine-grained-signals'
import { button, field, muted, row } from './styles'

export function ComputedDemo() {
  const price = useSignal(12)
  const quantity = useSignal(3)
  // A computed recomputes lazily, only after a signal it read has changed.
  const total = useComputed(() => price.value * quantity.value)
  const label = useComputed(() => (total.value >= 100 ? 'Free shipping' : `${100 - total.value} to free shipping`))

  return (
    <div data-demo="computed" style={{ display: 'grid', gap: '0.5rem' }}>
      <div style={row}>
        <label>
          Price{' '}
          <input
            type="number"
            min={0}
            style={{ ...field, width: '6rem' }}
            value={price.value}
            onChange={(event) => { price.value = Number(event.currentTarget.value) }}
          />
        </label>
        <span>×</span>
        <button type="button" style={button} onClick={() => { quantity.value = Math.max(0, quantity.value - 1) }}>−</button>
        <output data-testid="quantity">{quantity.value}</output>
        <button type="button" style={button} onClick={() => quantity.value++}>+</button>
      </div>
      <div>
        Total: <strong data-testid="total">{total.value}</strong> · <span style={muted}>{label.value}</span>
      </div>
    </div>
  )
}
