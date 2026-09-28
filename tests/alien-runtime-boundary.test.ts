import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const productionRoot = join(repositoryRoot, "src");
const allowedSystemImport = "src/core/alien-derived-runtime-core.mjs";

interface AlienImport {
  readonly specifier: string;
  readonly line: number;
}

function findAlienImports(source: string): AlienImport[] {
  const imports: AlienImport[] = [];
  const code = maskCommentsAndStrings(source);
  const declarations = /^[\t ]*(?:import|export)\b[^;]*;/gm;
  let declaration: RegExpExecArray | null;

  while ((declaration = declarations.exec(code)) !== null) {
    const original = source.slice(declaration.index, declaration.index + declaration[0].length);
    const moduleSpecifier = original.match(/\bfrom\s*(["'])(alien-signals(?:\/system)?)\1/)
      ?? original.match(/^\s*(?:import|export)\s*(["'])(alien-signals(?:\/system)?)\1/);
    const specifier = moduleSpecifier?.[2];
    if (specifier === undefined) continue;
    imports.push({
      specifier,
      line: source.slice(0, declaration.index).split("\n").length,
    });
  }

  return imports;
}

function maskCommentsAndStrings(source: string): string {
  const characters = source.split("");
  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
    }
  };

  for (let index = 0; index < characters.length;) {
    const character = characters[index];
    const next = characters[index + 1];
    if (character === "/" && next === "/") {
      const start = index;
      while (index < characters.length && characters[index] !== "\n") index += 1;
      mask(start, index);
      continue;
    }
    if (character === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < characters.length && !(characters[index] === "*" && characters[index + 1] === "/")) index += 1;
      index = Math.min(index + 2, characters.length);
      mask(start, index);
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const start = index++;
      while (index < characters.length) {
        if (characters[index] === "\\") {
          index += 2;
          continue;
        }
        if (characters[index++] === character) break;
      }
      mask(start, index);
      continue;
    }
    index += 1;
  }

  return characters.join("");
}

async function listProductionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listProductionFiles(path);
    return entry.isFile() && /\.(?:tsx?|mjs)$/.test(entry.name) ? [path] : [];
  }));
  return nestedFiles.flat();
}

describe("Alien Signals production dependency boundary", () => {
  it("recognizes static imports and exports without matching comments, strings, or dynamic imports", () => {
    const source = `
      // import { signal } from "alien-signals";
      /** export { effect } from "alien-signals"; */
      /*
      import { computed } from "alien-signals";
      */
      const example = 'import { computed } from "alien-signals";';
      const docs = \`\nimport { effect } from "alien-signals";\n\`;
      import { signal } from "alien-signals";
      export type { ReactiveNode } from "alien-signals/system";
      void import("alien-signals");
    `;

    expect(findAlienImports(source)).toEqual([
      { specifier: "alien-signals", line: 11 },
      { specifier: "alien-signals/system", line: 12 },
    ]);
  });

  it("keeps alien-signals/system confined to the private RFSG runtime", async () => {
    // RFSG intentionally depends on alien-signals/system. The invariant is
    // that production owns its high-level reactive runtime and Alien supplies
    // only the accepted low-level graph substrate.
    const violations: string[] = [];
    let allowedSystemImports = 0;
    for (const file of await listProductionFiles(productionRoot)) {
      const source = await readFile(file, "utf8");
      const relativeFile = relative(repositoryRoot, file).replaceAll("\\", "/");
      for (const alienImport of findAlienImports(source)) {
        if (alienImport.specifier === "alien-signals") {
          violations.push(`${relativeFile}:${alienImport.line} imports the forbidden high-level root API`);
        } else if (relativeFile !== allowedSystemImport) {
          violations.push(`${relativeFile}:${alienImport.line} imports alien-signals/system outside the allowlist`);
        } else {
          allowedSystemImports += 1;
        }
      }
    }

    if (violations.length > 0) {
      throw new Error([
        "Production code must not import Alien Signals' high-level root API.",
        "Use RFSG's private ReactiveRuntime; only src/core/alien-derived-runtime-core.mjs may depend directly on alien-signals/system.",
        ...violations,
      ].join("\n"));
    }

    expect(allowedSystemImports).toBeGreaterThan(0);
  });
});
