"use client";

import { useRef } from "react";
import { useDeepSignal, useSignal, useSignalTracking } from "react-fine-grained-signals";
import { For, Index } from "react-fine-grained-signals/utils";
import { button, muted, row } from "./styles";

interface User {
  id: number;
  name: string;
  score: number;
}
const names = ["Ada", "Grace", "Alan", "Barbara", "Edsger", "Margaret"];
const initialUsers = (): User[] => [
  { id: 1, name: "Ada", score: 10 },
  { id: 2, name: "Grace", score: 20 },
  { id: 3, name: "Alan", score: 30 },
];
function useRenderCount() {
  const count = useRef(0);
  count.current += 1;
  return count.current;
}

function DeepUserRow({ user }: { user: User }) {
  useSignalTracking();
  const renders = useRenderCount();
  return (
    <li data-testid={`deep-row-${user.id}`}>
      {user.name} · score {user.score} <small>row renders: {renders}</small>
    </li>
  );
}

function KeyedUserRow({ user }: { user: User }) {
  const renders = useRenderCount();
  return (
    <li>
      {user.name} #{user.id} <small>row renders: {renders}</small>
    </li>
  );
}

function IndexedUserRow({ user, index }: { user: () => User; index: number }) {
  const renders = useRenderCount();
  return (
    <li>
      {index}: {user().name} <small>row renders: {renders}</small>
    </li>
  );
}

export function ForIndexDemo() {
  const users = useDeepSignal(initialUsers);
  const nextId = useSignal(4);
  const ownerRenders = useRenderCount();
  const add = () => {
    const id = nextId.value++;
    users.value.push({ id, name: names[(id - 1) % names.length]!, score: id * 10 });
  };
  const rotate = () => {
    const first = users.value.shift();
    if (first) users.value.push(first);
  };
  const removeFirst = () => {
    users.value.shift();
  };
  const replace = () => {
    users.value = users.value.map((user) => ({ ...user, score: user.score + 1 }));
  };
  const updateFirst = () => {
    const first = users.value[0];
    if (first) first.score++;
  };

  return (
    <div data-demo="for-index" style={{ display: "grid", gap: "0.5rem" }}>
      <p data-testid="list-owner-renders" style={muted}>
        List owner renders: {ownerRenders}
      </p>
      <div style={row}>
        <button type="button" style={button} onClick={add}>
          Add
        </button>
        <button type="button" style={button} onClick={rotate}>
          Rotate
        </button>
        <button type="button" style={button} onClick={removeFirst}>
          Remove first
        </button>
        <button type="button" style={button} onClick={replace}>
          Immutable replacement +1
        </button>
        <button type="button" style={button} onClick={updateFirst}>
          Deep edit first score
        </button>
      </div>
      <p style={muted}>
        The list boundary keeps its owner stable. For callbacks run for each item after collection replacement; stable
        keys preserve row identity. The Deep Signal rows subscribe to their own fields, so a nested edit updates only
        the row that read that field.
      </p>
      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))" }}>
        <div>
          <div style={muted}>For · identity keyed (callback visits all items on collection change)</div>
          <ol data-testid="for">
            <For each={users} by={(user) => user.id} fallback={<li>No users.</li>}>
              {(user) => <KeyedUserRow user={user} />}
            </For>
          </ol>
        </div>
        <div>
          <div style={muted}>Index · position keyed</div>
          <ol data-testid="index">
            <Index each={users} fallback={<li>No users.</li>}>
              {(user, index) => <IndexedUserRow user={user} index={index} />}
            </Index>
          </ol>
        </div>
        <div>
          <div style={muted}>Deep Signal · row-local subscriptions</div>
          <ol data-testid="deep-rows">
            <For each={users} by={(user) => user.id} fallback={<li>No users.</li>}>
              {(user) => <DeepUserRow user={user} />}
            </For>
          </ol>
        </div>
      </div>
    </div>
  );
}
