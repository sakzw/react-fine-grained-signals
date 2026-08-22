import { declare } from "@babel/helper-plugin-utils";
import * as t from "@babel/types";
import type { NodePath, PluginObj } from "@babel/core";

export interface ReactAlienSignalsTransformOptions {
  importSource?: string;
}

interface RuntimeImport {
  identifier: t.Identifier;
  bindingPath: NodePath<t.ImportSpecifier>;
}

function isImportedUseSignals(
  functionPath: NodePath<t.Function>,
  name: string,
  importSource: string,
): boolean {
  const binding = functionPath.scope.getBinding(name);
  if (binding === undefined || !binding.path.isImportSpecifier()) return false;
  if (binding.path.node.importKind === "type") return false;
  if (!t.isIdentifier(binding.path.node.imported, { name: "useSignals" })) {
    return false;
  }
  const declaration = binding.path.parentPath;
  return (
    declaration.isImportDeclaration() &&
    declaration.node.importKind !== "type" &&
    declaration.node.source.value === importSource
  );
}

function findRuntimeImports(
  programPath: NodePath<t.Program>,
  runtimeSource: string,
): RuntimeImport[] {
  const imports: RuntimeImport[] = [];
  for (const statement of programPath.get("body")) {
    if (
      !statement.isImportDeclaration() ||
      statement.node.importKind === "type" ||
      statement.node.source.value !== runtimeSource
    ) {
      continue;
    }
    for (const specifier of statement.get("specifiers")) {
      if (
        specifier.isImportSpecifier() &&
        specifier.node.importKind !== "type" &&
        t.isIdentifier(specifier.node.imported, { name: "useSignals" })
      ) {
        imports.push({
          identifier: t.cloneNode(specifier.node.local),
          bindingPath: specifier,
        });
      }
    }
  }
  return imports;
}

function addRuntimeImport(
  programPath: NodePath<t.Program>,
  runtimeSource: string,
  functionPath: NodePath<t.Function>,
): RuntimeImport {
  const local = functionPath.scope.generateUidIdentifier("useSignals");
  const declaration = t.importDeclaration(
    [t.importSpecifier(t.cloneNode(local), t.identifier("useSignals"))],
    t.stringLiteral(runtimeSource),
  );
  const imports = programPath.get("body").filter((path) =>
    path.isImportDeclaration()
  );
  let insertedPaths: NodePath[];
  if (imports.length === 0) {
    insertedPaths = programPath.unshiftContainer("body", declaration);
  } else {
    insertedPaths = imports.at(-1)!.insertAfter(declaration);
  }
  const inserted = insertedPaths[0];
  if (inserted === undefined || !inserted.isImportDeclaration()) {
    throw new Error("Failed to insert the managed useSignals runtime import");
  }
  programPath.scope.registerDeclaration(inserted);
  const specifier = inserted.get("specifiers")[0];
  if (specifier === undefined || !specifier.isImportSpecifier()) {
    throw new Error("Failed to register the managed useSignals runtime import");
  }
  return { identifier: local, bindingPath: specifier };
}

export default declare<ReactAlienSignalsTransformOptions>((api, options) => {
  api.assertVersion(7);
  const importSource = options.importSource ?? "react-alien-signals";
  const runtimeSource = `${importSource}/runtime`;
  let programPath: NodePath<t.Program>;
  let runtimeImports: RuntimeImport[];

  const plugin: PluginObj = {
    name: "react-alien-signals-managed-render",
    visitor: {
      Program: {
        enter(path) {
          programPath = path;
          runtimeImports = findRuntimeImports(path, runtimeSource);
        },
      },
      Function(path) {
        const body = path.get("body");
        if (!body.isBlockStatement()) return;
        const statements = body.get("body");
        const first = statements[0];
        if (first === undefined || !first.isExpressionStatement()) return;
        const expression = first.get("expression");
        if (!expression.isCallExpression() || expression.node.arguments.length !== 0) {
          return;
        }
        const callee = expression.get("callee");
        if (
          !callee.isIdentifier() ||
          !isImportedUseSignals(path, callee.node.name, importSource)
        ) {
          return;
        }
        if (path.node.async || path.node.generator) {
          throw path.buildCodeFrameError(
            "useSignals transform only supports synchronous, non-generator functions",
          );
        }

        let runtimeImport = runtimeImports.find(({ identifier, bindingPath }) =>
          path.scope.getBinding(identifier.name)?.path === bindingPath
        );
        if (runtimeImport === undefined) {
          runtimeImport = addRuntimeImport(programPath, runtimeSource, path);
          runtimeImports.push(runtimeImport);
        }
        const store = path.scope.generateUidIdentifier("signals");
        const declaration = t.variableDeclaration("const", [
          t.variableDeclarator(
            t.cloneNode(store),
            t.callExpression(t.cloneNode(runtimeImport.identifier), []),
          ),
        ]);
        t.inheritsComments(declaration, first.node);
        const transformedBody = statements.slice(1).map((statement) =>
          statement.node
        );
        body.set("body", [
          declaration,
          t.tryStatement(
            t.blockStatement(transformedBody),
            null,
            t.blockStatement([
              t.expressionStatement(
                t.callExpression(
                  t.memberExpression(t.cloneNode(store), t.identifier("f")),
                  [],
                ),
              ),
            ]),
          ),
        ]);
        path.scope.crawl();
      },
    },
  };
  return plugin;
});
