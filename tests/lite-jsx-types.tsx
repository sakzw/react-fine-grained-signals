/** @jsxImportSource react-fine-grained-signals/jsx/lite */

import { signal } from "../src/index.js";

const child = signal("value");

const plainMarkup = <button title="plain">Plain</button>;
const signalChild = <output>{child}</output>;
const nestedSignalChildren = <>{[child, ["and", child]]}</>;
// @ts-expect-error Lite runtime does not accept Signal-valued HTML attributes.
const signalAttribute = <button title={child} />;
// @ts-expect-error Lite runtime does not support direct form bindings.
const formBinding = <input bindValue={child} />;
// @ts-expect-error Lite runtime does not support signal-valued style properties.
const styleBinding = <div style={{ color: child }} />;

void [plainMarkup, signalChild, nestedSignalChildren, signalAttribute, formBinding, styleBinding];
