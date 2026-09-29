import { afterEach, describe, expect, it } from "vitest";
import {
  executionContext,
  isGraphExecutionOwner,
  isRenderExecutionOwner,
  pushExecutionOwner,
  UNTRACKED_OWNER,
  withExecutionOwner,
  withSynchronousExecutionOwner,
  type ExecutionOwnerV2,
  type GraphExecutionOwnerV2,
  type RenderExecutionOwnerV2,
} from "../src/core/execution-owner.js";

afterEach(() => {
  executionContext.owner = undefined;
  executionContext.frames.length = 0;
});

const graphOwner: GraphExecutionOwnerV2 = {
  version: 2,
  kind: "graph",
  runtimeToken: {},
  add() {},
};

const renderOwner: RenderExecutionOwnerV2 = {
  version: 2,
  kind: "render",
  runtimeToken: {},
  add() {},
};

describe("execution owner scopes", () => {
  it("recognizes graph and render owners while rejecting absent and untracked owners", () => {
    expect(isGraphExecutionOwner(graphOwner)).toBe(true);
    expect(isGraphExecutionOwner(renderOwner)).toBe(false);
    expect(isGraphExecutionOwner(undefined)).toBe(false);
    expect(isGraphExecutionOwner(UNTRACKED_OWNER)).toBe(false);
    expect(isRenderExecutionOwner(renderOwner)).toBe(true);
    expect(isRenderExecutionOwner(graphOwner)).toBe(false);
    expect(isRenderExecutionOwner(undefined)).toBe(false);
    expect(isRenderExecutionOwner(UNTRACKED_OWNER)).toBe(false);
  });

  it("restores synchronous and stacked owners, including out-of-order cleanup", () => {
    const parent: ExecutionOwnerV2 = graphOwner;
    const child: ExecutionOwnerV2 = renderOwner;
    expect(withExecutionOwner(parent, () => {
      expect(executionContext.owner).toBe(parent);
      const restoreChild = pushExecutionOwner(child);
      const restoreParent = pushExecutionOwner(parent);
      restoreChild();
      expect(executionContext.owner).toBe(parent);
      restoreParent();
      expect(executionContext.owner).toBe(parent);
      return withSynchronousExecutionOwner(UNTRACKED_OWNER, () => {
        expect(executionContext.owner).toBe(UNTRACKED_OWNER);
        return 42;
      });
    })).toBe(42);
    expect(executionContext.owner).toBeUndefined();
    expect(executionContext.frames).toEqual([]);
  });

  it("restores ownership after synchronous callback errors", () => {
    expect(() => withSynchronousExecutionOwner(graphOwner, () => {
      throw new Error("owner callback");
    })).toThrow("owner callback");
    expect(executionContext.owner).toBeUndefined();
    expect(() => withExecutionOwner(renderOwner, () => {
      throw new Error("stacked callback");
    })).toThrow("stacked callback");
    expect(executionContext.owner).toBeUndefined();
    expect(executionContext.frames).toEqual([]);
  });
});
