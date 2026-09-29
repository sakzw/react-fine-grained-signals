import { Fragment, jsxDEV } from "react-fine-grained-signals/jsx-dev-runtime";
import generic, { pluginName, reactFineGrainedSignals } from "unplugin-react-fine-grained-signals";
import vite from "unplugin-react-fine-grained-signals/vite";
import rollup from "unplugin-react-fine-grained-signals/rollup";
import webpack from "unplugin-react-fine-grained-signals/webpack";
import rspack from "unplugin-react-fine-grained-signals/rspack";
import esbuild from "unplugin-react-fine-grained-signals/esbuild";

// This file is included by the clean consumer's tsc run. Imports and values
// make declaration resolution for every documented public entry observable.
const devElement = jsxDEV("div", {}, undefined, false, undefined, undefined);
void [Fragment, devElement, generic, pluginName, reactFineGrainedSignals, vite, rollup, webpack, rspack, esbuild];
