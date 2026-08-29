/** @jsxImportSource react-fine-grained-signals */

import { App } from "./App.js";
import { createDemoState } from "./state.js";

export function createApp() {
  return <App state={createDemoState()} />;
}
