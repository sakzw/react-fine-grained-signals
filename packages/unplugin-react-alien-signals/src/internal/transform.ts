import { declare } from "@babel/helper-plugin-utils";
import { transformSync, type NodePath, type PluginObj } from "@babel/core";
import * as t from "@babel/types";
import type { TransformResult } from "unplugin";

export type ReactAlienSignalsMode = "manual" | "auto" | "all";

export interface InternalTransformOptions {
  importSource: string;
  mode: ReactAlienSignalsMode;
}

export type InternalTransformResult = Exclude<TransformResult, string>;

interface RuntimeImport {
  identifier: t.Identifier;
  bindingPath: NodePath<t.ImportSpecifier>;
}

interface FunctionInspection {
  containsJSX: boolean;
  readsValue: boolean;
  hasUseSignalsCall: boolean;
}

const useSignalsComment = /(^|\s)@useSignals(\s|$)/;
const noUseSignalsComment = /(^|\s)@noUseSignals(\s|$)/;
const transformedMetadataKey = "reactAlienSignalsTransformed";

function hasLeadingComment(path: NodePath, pattern: RegExp): boolean {
  return path.node.leadingComments?.some((comment) => pattern.test(comment.value)) ?? false;
}

function hasCommentInAncestors(path: NodePath, pattern: RegExp): boolean {
  let current: NodePath | null = path;
  while (current !== null && !current.isProgram()) {
    if (hasLeadingComment(current, pattern)) return true;
    current = current.parentPath;
  }
  return false;
}

function isKnownComponentWrapper(path: NodePath<t.CallExpression>): boolean {
  const callee = path.get("callee");
  if (callee.isIdentifier()) {
    return callee.node.name === "memo" || callee.node.name === "forwardRef";
  }
  if (!callee.isMemberExpression()) return false;
  const property = callee.get("property");
  return (
    (!callee.node.computed && property.isIdentifier() &&
      (property.node.name === "memo" || property.node.name === "forwardRef")) ||
    (callee.node.computed && property.isStringLiteral() &&
      (property.node.value === "memo" || property.node.value === "forwardRef"))
  );
}

function getFunctionName(path: NodePath<t.Function>): string | undefined {
  if (
    (path.isFunctionDeclaration() || path.isFunctionExpression()) &&
    path.node.id !== null &&
    path.node.id !== undefined
  ) {
    return path.node.id.name;
  }
  let parent = path.parentPath;
  while (parent.isCallExpression() && isKnownComponentWrapper(parent)) {
    parent = parent.parentPath;
  }
  if (parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
    return parent.node.id.name;
  }
  return undefined;
}

function isComponent(path: NodePath<t.Function>): boolean {
  const name = getFunctionName(path);
  return name !== undefined && /^[A-Z]/.test(name);
}

function isCustomHook(path: NodePath<t.Function>): boolean {
  const name = getFunctionName(path);
  return name !== undefined && /^use[A-Z]/.test(name);
}

function isImportedUseSignals(
  functionPath: NodePath<t.Function>,
  name: string,
  importSource: string,
): boolean {
  const binding = functionPath.scope.getBinding(name);
  if (binding === undefined || !binding.path.isImportSpecifier()) return false;
  if (binding.path.node.importKind === "type") return false;
  if (!t.isIdentifier(binding.path.node.imported, { name: "useSignals" })) return false;
  const declaration = binding.path.parentPath;
  return (
    declaration.isImportDeclaration() &&
    declaration.node.importKind !== "type" &&
    declaration.node.source.value === importSource
  );
}

function inspectFunction(
  functionPath: NodePath<t.Function>,
  importSource: string,
): FunctionInspection {
  const inspection: FunctionInspection = {
    containsJSX: false,
    readsValue: false,
    hasUseSignalsCall: false,
  };
  functionPath.traverse({
    Function(path) {
      path.skip();
    },
    JSXElement() {
      inspection.containsJSX = true;
    },
    JSXFragment() {
      inspection.containsJSX = true;
    },
    MemberExpression(path) {
      const property = path.node.property;
      if (
        (!path.node.computed && t.isIdentifier(property, { name: "value" })) ||
        (path.node.computed && t.isStringLiteral(property, { value: "value" }))
      ) {
        inspection.readsValue = true;
      }
    },
    OptionalMemberExpression(path) {
      const property = path.node.property;
      if (
        (!path.node.computed && t.isIdentifier(property, { name: "value" })) ||
        (path.node.computed && t.isStringLiteral(property, { value: "value" }))
      ) {
        inspection.readsValue = true;
      }
    },
    CallExpression(path) {
      const callee = path.get("callee");
      if (
        callee.isIdentifier() &&
        isImportedUseSignals(functionPath, callee.node.name, importSource)
      ) {
        inspection.hasUseSignalsCall = true;
      }
    },
  });
  return inspection;
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
  const imports = programPath.get("body").filter((path) => path.isImportDeclaration());
  const insertedPaths = imports.length === 0
    ? programPath.unshiftContainer("body", declaration)
    : imports.at(-1)!.insertAfter(declaration);
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

function isExplicitUseSignals(
  functionPath: NodePath<t.Function>,
  statements: NodePath<t.Statement>[],
  importSource: string,
): boolean {
  const first = statements[0];
  if (first === undefined || !first.isExpressionStatement()) return false;
  const expression = first.get("expression");
  if (!expression.isCallExpression() || expression.node.arguments.length !== 0) return false;
  const callee = expression.get("callee");
  return (
    callee.isIdentifier() &&
    isImportedUseSignals(functionPath, callee.node.name, importSource)
  );
}

function shouldAutomaticallyTransform(
  mode: ReactAlienSignalsMode,
  functionPath: NodePath<t.Function>,
  inspection: FunctionInspection,
): boolean {
  if (isCustomHook(functionPath)) return mode !== "manual" && inspection.readsValue;
  if (!isComponent(functionPath) || !inspection.containsJSX) return false;
  return mode === "all" || (mode === "auto" && inspection.readsValue);
}

const babelTransform = declare<InternalTransformOptions>((api, options) => {
  api.assertVersion(7);
  const runtimeSource = `${options.importSource}/runtime`;
  let programPath: NodePath<t.Program>;
  let runtimeImports: RuntimeImport[];

  const plugin: PluginObj = {
    name: "unplugin-react-alien-signals",
    visitor: {
      Program: {
        enter(path, state) {
          programPath = path;
          runtimeImports = findRuntimeImports(path, runtimeSource);
          (state.file.metadata as Record<string, unknown>)[transformedMetadataKey] = false;
        },
      },
      Function(path, state) {
        if (hasCommentInAncestors(path, noUseSignalsComment)) return;

        const body = path.get("body");
        const statements = body.isBlockStatement() ? body.get("body") : [];
        const explicit = isExplicitUseSignals(path, statements, options.importSource);
        const inspection = inspectFunction(path, options.importSource);
        const annotated =
          hasCommentInAncestors(path, useSignalsComment) &&
          (isComponent(path) || isCustomHook(path));
        const automatic = shouldAutomaticallyTransform(options.mode, path, inspection);
        if (!explicit && !annotated && !automatic) return;
        if (!explicit && inspection.hasUseSignalsCall) return;
        if (path.node.async || path.node.generator) {
          if (!explicit && !annotated) return;
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
        const first = statements[0];
        if (explicit && first !== undefined) t.inheritsComments(declaration, first.node);
        const originalStatements = body.isBlockStatement()
          ? statements.slice(explicit ? 1 : 0).map((statement) => statement.node)
          : [t.returnStatement(body.node as t.Expression)];
        const transformedBody = t.blockStatement([
          declaration,
          t.tryStatement(
            t.blockStatement(originalStatements),
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
        if (body.isBlockStatement()) transformedBody.directives = body.node.directives;
        body.replaceWith(transformedBody);
        path.scope.crawl();
        (state.file.metadata as Record<string, unknown>)[transformedMetadataKey] = true;
      },
    },
  };
  return plugin;
});

/** Runs the private Babel transform for the universal bundler adapter. */
export function transformReactAlienSignals(
  code: string,
  id: string,
  options: InternalTransformOptions,
): InternalTransformResult | null {
  const result = transformSync(code, {
    babelrc: false,
    configFile: false,
    filename: id,
    parserOpts: { plugins: ["jsx", "typescript"] },
    plugins: [[babelTransform, options]],
    sourceMaps: true,
  });
  if (
    result === null ||
    typeof result.code !== "string" ||
    (result.metadata as Record<string, unknown> | undefined)?.[transformedMetadataKey] !== true
  ) {
    return null;
  }
  return { code: result.code, map: result.map };
}
