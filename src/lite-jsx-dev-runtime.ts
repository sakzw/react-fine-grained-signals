import { Fragment, jsxDEV as reactJsxDEV } from "react/jsx-dev-runtime";
import { createLiteJsxWrapper } from "./runtime/lite-jsx.js";

export { Fragment };
export type { JSX } from "./lite-jsx-runtime.js";

/** Development JSX factory for `jsxImportSource: "react-fine-grained-signals/lite"`. */
export function jsxDEV(
  type: Parameters<typeof reactJsxDEV>[0],
  props: Parameters<typeof reactJsxDEV>[1],
  key: Parameters<typeof reactJsxDEV>[2],
  isStaticChildren: Parameters<typeof reactJsxDEV>[3],
  source: Parameters<typeof reactJsxDEV>[4],
  self: Parameters<typeof reactJsxDEV>[5],
) {
  const wrapped = createLiteJsxWrapper((nextType, nextProps, nextKey) =>
    reactJsxDEV(nextType, nextProps, nextKey, isStaticChildren, source, self),
  );
  return wrapped(type, props, key);
}
