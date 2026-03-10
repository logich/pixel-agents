/**
 * Unit tests for Kiro hook configuration validity.
 *
 * [Updated for HTTP bridge] Validates the hook definitions returned by
 * getHookDefinitions() rather than reading files from disk. The hooks
 * are now HTTP-based curl commands instead of bridge script invocations.
 *
 * Validates: Requirements 7.1–7.5, 8.1
 */
import { describe, it, expect, vi } from "vitest";

// Mock vscode module before importing anything that depends on it
vi.mock("vscode", () => ({
	workspace: { workspaceFolders: [] },
	window: {
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
	commands: { registerCommand: vi.fn() },
}), { virtual: true });

import { getHookDefinitions } from "../kiroBridgeSetup.js";

interface HookConfig {
  name: string;
  version: string;
  description?: string;
  enabled?: boolean;
  when: {
    type: string;
    toolTypes?: string[];
  };
  then: {
    type: string;
    command: string;
  };
}

const EXPECTED_HOOKS = [
  {
    filename: "pixel-agents-prompt.kiro.hook",
    expectedEventType: "promptSubmit",
    expectedEndpoint: "/prompt-start",
  },
  {
    filename: "pixel-agents-tool-start.kiro.hook",
    expectedEventType: "preToolUse",
    expectedEndpoint: "/tool-start",
  },
  {
    filename: "pixel-agents-tool-done.kiro.hook",
    expectedEventType: "postToolUse",
    expectedEndpoint: "/tool-done",
  },
  {
    filename: "pixel-agents-agent-stop.kiro.hook",
    expectedEventType: "agentStop",
    expectedEndpoint: "/agent-stop",
  },
];

describe("Hook configuration validity", () => {
  const hookDefs = getHookDefinitions();
  const hooks = EXPECTED_HOOKS.map((h) => ({
    ...h,
    config: hookDefs[h.filename] as unknown as HookConfig,
  }));

  it("getHookDefinitions returns all 4 hook files", () => {
    expect(Object.keys(hookDefs)).toHaveLength(4);
    for (const h of EXPECTED_HOOKS) {
      expect(hookDefs).toHaveProperty(h.filename);
    }
  });

  it("each hook has required fields: name, version, when, then", () => {
    for (const { filename, config } of hooks) {
      expect(config.name, `${filename} missing name`).toBeDefined();
      expect(typeof config.name).toBe("string");
      expect(config.version, `${filename} missing version`).toBeDefined();
      expect(typeof config.version).toBe("string");
      expect(config.when, `${filename} missing when`).toBeDefined();
      expect(config.then, `${filename} missing then`).toBeDefined();
    }
  });

  it("when.type matches expected event type for each hook", () => {
    for (const { filename, config, expectedEventType } of hooks) {
      expect(config.when.type, `${filename} should have when.type = ${expectedEventType}`).toBe(expectedEventType);
    }
  });

  it("then.type is runCommand for all hooks", () => {
    for (const { filename, config } of hooks) {
      expect(config.then.type, `${filename} should have then.type = runCommand`).toBe("runCommand");
    }
  });

  it("then.command uses curl to POST to the correct HTTP endpoint", () => {
    for (const { filename, config, expectedEndpoint } of hooks) {
      expect(config.then.command, `${filename} should use curl`).toContain("curl");
      expect(config.then.command, `${filename} should target ${expectedEndpoint}`).toContain(
        `http://127.0.0.1:$PORT${expectedEndpoint}`,
      );
      expect(config.then.command, `${filename} should have || true`).toMatch(/\|\| true\s*$/);
    }
  });

  it("preToolUse and postToolUse hooks have toolTypes that do NOT include *", () => {
    const toolHooks = hooks.filter(
      (h) => h.config.when.type === "preToolUse" || h.config.when.type === "postToolUse",
    );
    expect(toolHooks.length).toBeGreaterThan(0);
    for (const { filename, config } of toolHooks) {
      expect(config.when.toolTypes, `${filename} should have toolTypes`).toBeDefined();
      expect(config.when.toolTypes, `${filename} toolTypes must not include *`).not.toContain("*");
    }
  });

  it('preToolUse and postToolUse hooks have toolTypes set to ["read", "write", "shell"]', () => {
    const toolHooks = hooks.filter(
      (h) => h.config.when.type === "preToolUse" || h.config.when.type === "postToolUse",
    );
    for (const { filename, config } of toolHooks) {
      expect(
        config.when.toolTypes,
        `${filename} should have toolTypes = ["read", "write", "shell"]`,
      ).toEqual(["read", "write", "shell"]);
    }
  });

  it("all hooks are enabled (enabled: true or absent)", () => {
    for (const { filename, config } of hooks) {
      if (config.enabled !== undefined) {
        expect(config.enabled, `${filename} should be enabled`).toBe(true);
      }
    }
  });
});
