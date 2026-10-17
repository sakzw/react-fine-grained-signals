'use client'
/** @jsxImportSource react-fine-grained-signals */

import { useMemo } from 'react'
import { computed, deepSignal, signal, useSignal, type ReadonlySignal } from 'react-fine-grained-signals'
import { For, Index } from 'react-fine-grained-signals/utils'
import './style.css'

export function CounterDemo() {
  const count = useSignal(0)
  return <div className="demo"><button onClick={() => count.value++}>Count: {count}</button></div>
}

export function ComputedDemo() {
  const count = useSignal(1)
  const doubled = useMemo(() => computed(() => count.value * 2), [count])
  return <div className="demo"><button onClick={() => count.value++}>Value {count} → computed double {doubled}</button></div>
}

export function DeepSignalDemo() {
  const person = useMemo(() => deepSignal({ name: 'Ada', address: { city: 'London' } }), [])
  return <div className="demo"><label>Name <input value={person.value.name} onChange={(event) => { person.value.name = event.target.value }} /></label><label>City <input value={person.value.address.city} onChange={(event) => { person.value.address.city = event.target.value }} /></label><p>{person.value.name} lives in {person.value.address.city}.</p></div>
}

export function FormDemo() {
  const name = useSignal('Signals')
  return <div className="demo"><label>Your name <input bindValue={name} /></label><p>Hello, {name}!</p></div>
}

function IndexRow({ item, position, current }: { item: () => string; position: number; current: ReadonlySignal<number> }) {
  return position === current.value ? <strong>{item()}</strong> : <span>{item()}</span>
}

export function ListDemo() {
  const items = useMemo(() => signal(['Fine', 'grained', 'updates']), [])
  const index = useMemo(() => signal(0), [])
  return <div className="demo"><button onClick={() => { items.value = [...items.value, `item ${items.value.length + 1}`] }}>Add row</button><For each={items} by={(item) => item}>{(item) => <p>{item}</p>}</For><button onClick={() => { index.value = (index.value + 1) % items.value.length }}>Next Index item</button><Index each={items}>{(item, i) => <IndexRow item={item} position={i} current={index} />}</Index></div>
}

export function DirectBindingDemo() {
  const color = useMemo(() => signal('steelblue'), [])
  return <div className="demo"><button style={{ color }}>Direct-bound color</button><button onClick={() => { color.value = color.value === 'steelblue' ? 'tomato' : 'steelblue' }}>Toggle color signal</button></div>
}

export function ManagedDemo() {
  const count = useSignal(0)
  return <div className="demo"><button onClick={() => count.value++}>Managed read: {count.value}</button><small>Managed Transform tracks this render-time read.</small></div>
}
