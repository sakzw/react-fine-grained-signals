# babel-plugin-react-alien-signals

Babel transform for managed `react-alien-signals` render tracking.

```js
module.exports = {
  plugins: ["babel-plugin-react-alien-signals"],
};
```

The plugin transforms synchronous functions whose first statement is an imported `useSignals()` call. The call is replaced with `react-alien-signals/runtime`, and the remaining function body is wrapped in `try` / `finally` so render tracking always closes synchronously.

Use `{ importSource: "@scope/signals" }` when the runtime package is published under another name.
