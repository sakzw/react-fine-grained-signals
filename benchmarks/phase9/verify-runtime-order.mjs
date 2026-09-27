import assert from "node:assert/strict";
import { runtimeOrderForRound, runtimes } from "./config.mjs";

const ids = runtimes.map((runtime) => runtime.id);
const cycle = Array.from({ length: 4 }, (_, index) => runtimeOrderForRound(index + 1).map(({ id }) => id));
assert.deepEqual(cycle, [
  ["rfsg-v0.1.1", "rfsg-current", "vue-reactivity", "alien-signals"],
  ["rfsg-current", "alien-signals", "rfsg-v0.1.1", "vue-reactivity"],
  ["alien-signals", "vue-reactivity", "rfsg-current", "rfsg-v0.1.1"],
  ["vue-reactivity", "rfsg-v0.1.1", "alien-signals", "rfsg-current"],
]);

const positionCounts = new Map(ids.map((id) => [id, [0, 0, 0, 0]]));
for (const order of cycle) {
  assert.equal(order.length, ids.length);
  assert.equal(new Set(order).size, ids.length);
  order.forEach((id, position) => positionCounts.get(id)[position] += 1);
}
for (const counts of positionCounts.values()) assert.deepEqual(counts, [1, 1, 1, 1]);

for (let left = 0; left < ids.length; left += 1) {
  for (let right = left + 1; right < ids.length; right += 1) {
    let leftBefore = 0;
    let rightBefore = 0;
    for (const order of cycle) {
      if (order.indexOf(ids[left]) < order.indexOf(ids[right])) leftBefore += 1;
      else rightBefore += 1;
    }
    assert.equal(leftBefore, 2, `${ids[left]} should run before ${ids[right]} twice per cycle`);
    assert.equal(rightBefore, 2, `${ids[right]} should run before ${ids[left]} twice per cycle`);
  }
}

for (let round = 1; round <= 4; round += 1) {
  assert.deepEqual(runtimeOrderForRound(round + 4).map(({ id }) => id), cycle[round - 1]);
}

process.stdout.write("Balanced runtime order verified for one cycle and the repeated eight-round schedule.\n");
