import { useState } from "react";
import { createRoot } from "react-dom/client";
import { signal } from "react-fine-grained-signals";

const revision = "cacheDir-HMR-A";
const shared = window.cacheDirSmokeSignal ??= signal(0);

function Counter() {
  const [local, setLocal] = useState(0);
  return (
    <main>
      <button id="local" onClick={() => setLocal((value) => value + 1)}>local:{local}</button>
      <button id="signal" onClick={() => { shared.value += 1; }}>signal:{shared.value}</button>
      <output id="revision">{revision}</output>
    </main>
  );
}

const root = window.cacheDirSmokeRoot ??= createRoot(document.getElementById("root"));
root.render(<Counter />);
if (import.meta.hot) import.meta.hot.accept();
