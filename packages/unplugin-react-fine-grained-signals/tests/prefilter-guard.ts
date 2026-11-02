/**
 * Test setup (vitest `setupFiles`): every call any test makes to
 * `transformReactFineGrainedSignals`, directly or through an adapter, checks
 * that the raw-text screen `mightTransform` never drops a module the transform
 * would change or report a diagnostic for. When the screen says no, the module
 * is transformed anyway without it; if that changes the module or reports
 * anything, the call throws, and the test that made it fails. The whole test
 * corpus is the proof, without copying its inputs anywhere.
 */
import { vi } from "vitest";

vi.mock("../src/internal/transform.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/internal/transform.js")>();
  return {
    ...original,
    transformReactFineGrainedSignals(...args: Parameters<typeof original.transformReactFineGrainedSignals>) {
      const [code, id, options] = args;
      if (!original.mightTransform(code, options.mode)) {
        const reported: string[] = [];
        let changed = false;
        try {
          changed =
            original.transformWithoutPrefilter(code, id, {
              ...options,
              warn: (warning) => reported.push(warning.message),
            }) !== null;
        } catch {
          // A module that does not parse is not one the screen dropped wrongly.
        }
        if (changed || reported.length > 0) {
          throw new Error(
            `mightTransform rejected ${id} in mode ${options.mode}, but the transform ` +
              `${changed ? "changes it" : `reports ${reported.join("; ")}`}:\n${code}`,
          );
        }
      }
      return original.transformReactFineGrainedSignals(...args);
    },
  };
});
