'use client'

import { computed, signal } from 'react-fine-grained-signals'
import { button, muted, row } from './styles'

// Module-level state shared by both components below.
const temperature = signal(21)
const unit = signal<'C' | 'F'>('C')
const display = computed(() => (unit.value === 'C' ? temperature.value : Math.round(temperature.value * 9 / 5 + 32)))

function describe(): string {
  // A helper read: the transform captures the call `describe()` because the
  // helper's body reads a signal.
  return temperature.value >= 25 ? 'warm' : temperature.value <= 15 ? 'cold' : 'mild'
}

/** Selected automatically: the build sees `.value` reads and adds the capture Hook. */
export function Thermostat() {
  return (
    <div data-demo="managed" style={{ display: 'grid', gap: '0.5rem' }}>
      <div style={row}>
        <button type="button" style={button} onClick={() => temperature.value--}>−</button>
        <output data-testid="reading">{display.value}°{unit.value}</output>
        <button type="button" style={button} onClick={() => temperature.value++}>+</button>
        <button type="button" style={button} onClick={() => { unit.value = unit.value === 'C' ? 'F' : 'C' }}>
          Show °{unit.value === 'C' ? 'F' : 'C'}
        </button>
      </div>
      <div>
        It feels <strong data-testid="feel">{describe()}</strong>.
      </div>
    </div>
  )
}

/**
 * @noSignalTracking
 * Opted out of the transform on purpose, to show what it adds: this component
 * reads the same signals but nothing subscribes it, so it keeps the value it
 * rendered with until something else re-renders it.
 */
export function UntrackedThermostat() {
  return (
    <p data-demo="untracked" style={muted}>
      Opted out with <code>@noSignalTracking</code>: <span data-testid="stale">{display.value}°{unit.value}</span>
    </p>
  )
}
