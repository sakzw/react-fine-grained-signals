export const runtimes = [
  { id: "rfsg-v0.1.1", version: "0.1.1", package: "react-fine-grained-signals@0.1.1" },
  { id: "rfsg-current", version: "0.1.1", package: "workspace production runtime" },
  { id: "alien-signals", version: "3.2.1", package: "alien-signals@3.2.1" },
  { id: "rfsg-m151-owner", version: "M1.5.1", package: "M1.5.1 Alien-derived core + adapters" },
];

const order = [
  ["rfsg-v0.1.1", "rfsg-current", "rfsg-m151-owner", "alien-signals"],
  ["rfsg-current", "alien-signals", "rfsg-v0.1.1", "rfsg-m151-owner"],
  ["alien-signals", "rfsg-m151-owner", "rfsg-current", "rfsg-v0.1.1"],
  ["rfsg-m151-owner", "rfsg-v0.1.1", "alien-signals", "rfsg-current"],
];
const byId = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
export function runtimeOrderForRound(round) {
  if (!Number.isSafeInteger(round) || round < 1) throw new Error("round must be a positive integer");
  return order[(round - 1) % order.length].map((id) => byId.get(id));
}
