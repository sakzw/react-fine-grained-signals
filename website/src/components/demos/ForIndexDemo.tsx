'use client'

import { useSignal } from 'react-fine-grained-signals'
import { For, Index } from 'react-fine-grained-signals/utils'
import { button, muted, row } from './styles'

interface User {
  id: number
  name: string
}

const names = ['Ada', 'Grace', 'Alan', 'Barbara', 'Edsger', 'Margaret']

export function ForIndexDemo() {
  const users = useSignal<User[]>([
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Grace' },
    { id: 3, name: 'Alan' },
  ])
  const nextId = useSignal(4)

  // Only the `For` and `Index` boundaries read `users`, so these updates do
  // not re-render this component.
  const add = () => {
    const id = nextId.peek()
    nextId.value = id + 1
    users.value = [...users.peek(), { id, name: names[(id - 1) % names.length]! }]
  }
  const rotate = () => {
    const [first, ...rest] = users.peek()
    if (first !== undefined) users.value = [...rest, first]
  }
  const removeFirst = () => { users.value = users.peek().slice(1) }

  return (
    <div data-demo="for-index" style={{ display: 'grid', gap: '0.5rem' }}>
      <div style={row}>
        <button type="button" style={button} onClick={add}>Add</button>
        <button type="button" style={button} onClick={rotate}>Rotate</button>
        <button type="button" style={button} onClick={removeFirst}>Remove first</button>
      </div>
      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))' }}>
        <div>
          <div style={muted}>For (keyed by id)</div>
          <ol data-testid="for">
            <For each={users} by={(user) => user.id} fallback={<li>No users.</li>}>
              {(user) => <li>{`${user.name} #${user.id}`}</li>}
            </For>
          </ol>
        </div>
        <div>
          <div style={muted}>Index (keyed by position)</div>
          <ol data-testid="index">
            <Index each={users} fallback={<li>No users.</li>}>
              {(user, index) => <li>{`${index}: ${user().name}`}</li>}
            </Index>
          </ol>
        </div>
      </div>
    </div>
  )
}
