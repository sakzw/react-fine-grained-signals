import { jsxDEV as reactJsxDEV } from "react/jsx-dev-runtime";
import type { JsxPropsTransform } from "./jsx-shared.js";

type ReactJsxDEV = typeof reactJsxDEV;

/**
 * The development factory for a runtime. Kept out of `jsx-shared.ts` so the
 * production entries never import `react/jsx-dev-runtime`.
 */
export function createJsxDEV(transform: JsxPropsTransform): ReactJsxDEV {
  return (type, props, key, isStaticChildren, source, self) =>
    reactJsxDEV(type, transform(type, props) as typeof props, key, isStaticChildren, source, self);
}
