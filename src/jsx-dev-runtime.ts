import { Fragment, jsxDEV as reactJsxDEV } from "react/jsx-dev-runtime";
import { createJsxWrapper } from "./runtime/jsx.js";

export { Fragment };
export type { JSX } from "./runtime/jsx.js";

/** Development JSX factory for `jsxImportSource: "react-alien-signals"`. */
export function jsxDEV(
  type: Parameters<typeof reactJsxDEV>[0],
  props: Parameters<typeof reactJsxDEV>[1],
  key: Parameters<typeof reactJsxDEV>[2],
  isStaticChildren: Parameters<typeof reactJsxDEV>[3],
  source: Parameters<typeof reactJsxDEV>[4],
  self: Parameters<typeof reactJsxDEV>[5],
) {
  const wrapped = createJsxWrapper((nextType, nextProps, nextKey) =>
    reactJsxDEV(nextType, nextProps, nextKey, isStaticChildren, source, self),
  );
  return wrapped(type, props, key);
}
