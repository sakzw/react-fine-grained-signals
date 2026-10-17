'use client'

import { useDeepSignal, useSignal } from 'react-fine-grained-signals'
import { button, field, muted, row } from './styles'

interface Todo {
  id: number
  title: string
  done: boolean
}

export function DeepSignalDemo() {
  const state = useDeepSignal(() => ({
    todos: [
      { id: 1, title: 'Read the guide', done: true },
      { id: 2, title: 'Try deepSignal', done: false },
    ] as Todo[],
    // Standard collections are reactive too: here, how often each title was toggled.
    toggles: new Map<number, number>(),
  }))
  const draft = useSignal('')
  const nextId = useSignal(3)

  const add = () => {
    const title = draft.value.trim()
    if (title === '') return
    state.value.todos.push({ id: nextId.value++, title, done: false })
    draft.value = ''
  }
  const toggle = (todo: Todo) => {
    todo.done = !todo.done
    state.value.toggles.set(todo.id, (state.value.toggles.get(todo.id) ?? 0) + 1)
  }

  const todos = state.value.todos
  const remaining = todos.filter((todo) => !todo.done).length

  return (
    <div data-demo="deep" style={{ display: 'grid', gap: '0.5rem' }}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {todos.map((todo) => (
          <li key={todo.id} style={row}>
            <label style={row}>
              <input type="checkbox" checked={todo.done} onChange={() => toggle(todo)} />
              <span style={{ textDecoration: todo.done ? 'line-through' : undefined }}>{todo.title}</span>
            </label>
            <span style={muted}>toggled {state.value.toggles.get(todo.id) ?? 0}×</span>
          </li>
        ))}
      </ul>
      <div style={row}>
        <input
          aria-label="New todo"
          style={field}
          value={draft.value}
          onChange={(event) => { draft.value = event.currentTarget.value }}
          onKeyDown={(event) => { if (event.key === 'Enter') add() }}
        />
        <button type="button" style={button} onClick={add}>Add</button>
        <span data-testid="remaining">{remaining} remaining</span>
      </div>
    </div>
  )
}
