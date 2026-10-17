'use client'

import { useSignal } from 'react-fine-grained-signals'
import { button, row } from './styles'

/**
 * No `useSignalTracking()` call: the managed transform sees the `.value` read
 * and adds the capture Hook during the build.
 */
export function Counter() {
  const count = useSignal(0)
  return (
    <div data-demo="counter" style={row}>
      <button type="button" style={button} onClick={() => count.value--}>
        −
      </button>
      <output>Count: {count.value}</output>
      <button type="button" style={button} onClick={() => count.value++}>
        +
      </button>
    </div>
  )
}
