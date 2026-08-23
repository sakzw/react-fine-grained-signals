/** @jsxImportSource react-alien-signals */

// Client-only mount used by the production (`vite build` + `vite preview`)
// path — see examples/browser/vite.config.ts. Unlike entry-client.tsx this
// does not hydrate SSR-rendered markup; it renders fresh into an empty
// `#root`, which is all that's needed to prove the built/minified bundle's
// signal reactivity and JSX runtime behave correctly outside of dev mode.
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createDemoState } from "./state.js";
import "./styles.css";

const container = document.getElementById("root");
if (container == null) throw new Error("Missing #root container");

createRoot(container).render(<App state={createDemoState()} />);
