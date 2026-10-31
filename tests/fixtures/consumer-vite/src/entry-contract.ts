import { Fragment, jsxDEV } from "react-fine-grained-signals/jsx/jsx-dev-runtime";
import generic, {
  REACT_FINE_GRAINED_SIGNALS_DIAGNOSTIC_IDS,
  reactFineGrainedSignals,
  type ReactFineGrainedSignalsDiagnosticId,
  type ReactFineGrainedSignalsDiagnosticsOptions,
  type ReactFineGrainedSignalsFilterPattern,
  type ReactFineGrainedSignalsMode,
  type ReactFineGrainedSignalsOptions,
  type ReactFineGrainedSignalsReactCompiler,
  type ReactFineGrainedSignalsTransform,
} from "unplugin-react-fine-grained-signals";
import type * as pluginRoot from "unplugin-react-fine-grained-signals";
import vite, { type VitePlugin } from "unplugin-react-fine-grained-signals/vite";
import rollup, { type RollupPlugin } from "unplugin-react-fine-grained-signals/rollup";
import webpack, { type WebpackPlugin } from "unplugin-react-fine-grained-signals/webpack";
import rspack, { type RspackPlugin } from "unplugin-react-fine-grained-signals/rspack";
import esbuild, { type EsbuildPlugin } from "unplugin-react-fine-grained-signals/esbuild";

// This file is included by the clean consumer's tsc run. Imports and values
// make declaration resolution for every documented public entry observable.
const devElement = jsxDEV("div", {}, undefined, false, undefined, undefined);
void [Fragment, devElement, generic, reactFineGrainedSignals, vite, rollup, webpack, rspack, esbuild];

const include: ReactFineGrainedSignalsFilterPattern = [/\/src\//, (id) => !id.includes("/server/")];
const errorOn: readonly ReactFineGrainedSignalsDiagnosticId[] = [REACT_FINE_GRAINED_SIGNALS_DIAGNOSTIC_IDS[0]];
const diagnostics: ReactFineGrainedSignalsDiagnosticsOptions = { errorOn };
const mode: ReactFineGrainedSignalsMode = "auto";
const transform: ReactFineGrainedSignalsTransform = "managed";
const reactCompiler: ReactFineGrainedSignalsReactCompiler = "opt-out";
const options: ReactFineGrainedSignalsOptions = {
  include,
  exclude: /\.stories\.tsx$/,
  diagnostics,
  mode,
  transform,
  reactCompiler,
};
const plugins: [VitePlugin, RollupPlugin, WebpackPlugin, RspackPlugin, EsbuildPlugin] = [
  vite(options),
  rollup(options),
  webpack(options),
  rspack(options),
  esbuild(options),
];
void plugins;

// The adapter/test helpers in the package's source are not public API.
type InternalValueName =
  | "canTransform"
  | "createModuleFilter"
  | "resolveEsbuildLoader"
  | "createBundlerPlugin"
  | "pluginName";
const internalValuesAreNotExported: Extract<keyof typeof pluginRoot, InternalValueName> extends never ? true : false =
  true;
void internalValuesAreNotExported;
// @ts-expect-error -- internal type, not exported from the root entry
type _EsbuildLoaderName = import("unplugin-react-fine-grained-signals").EsbuildLoaderName;
// @ts-expect-error -- internal type, not exported from the vite entry either
type _BundlerTransformOutput = import("unplugin-react-fine-grained-signals/vite").BundlerTransformOutput;
