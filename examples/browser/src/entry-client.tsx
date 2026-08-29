/** @jsxImportSource react-fine-grained-signals */

import { hydrateRoot } from "react-dom/client";
import { App } from "./App.js";
import { createDemoState } from "./state.js";
import "./styles.css";

const container = document.getElementById("root");
if (container == null) throw new Error("Missing #root container");

hydrateRoot(container, <App state={createDemoState()} />, {
  onRecoverableError(error) {
    console.error("[hydration-recoverable]", error);
  },
});
