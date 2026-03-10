/**
 * Feature: kiro-http-bridge, Property 6: Tool name mapping consistency
 *
 * For any Kiro tool name in the map, calling mapKiroToolName then formatToolStatus
 * should produce the same display string as the JSONL pipeline would for the
 * equivalent Claude Code tool name. For unmapped names, mapKiroToolName returns
 * the original name unchanged.
 *
 * Validates: Requirements 3.3, 3.4, 8.3
 */
import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";

// Mock vscode module before importing anything that depends on it
vi.mock("vscode", () => ({}), { virtual: true });

import { mapKiroToolName, KIRO_TOOL_NAME_MAP } from "../httpToolNameMap.js";
import { formatToolStatus } from "../transcriptParser.js";

const KNOWN_KIRO_NAMES = Object.keys(KIRO_TOOL_NAME_MAP);

describe("Tool name mapping consistency (Property 6)", () => {
  it("mapKiroToolName then formatToolStatus produces the same result as formatToolStatus with the mapped Claude Code name directly", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KNOWN_KIRO_NAMES),
        (kiroName) => {
          const mapped = mapKiroToolName(kiroName);
          const viaMap = formatToolStatus(mapped, {});
          const direct = formatToolStatus(KIRO_TOOL_NAME_MAP[kiroName], {});
          expect(viaMap).toBe(direct);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns the original name unchanged for unmapped names", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !KNOWN_KIRO_NAMES.includes(s)),
        (unknownName) => {
          expect(mapKiroToolName(unknownName)).toBe(unknownName);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns "Working" for empty or "unknown" unmapped names', () => {
    fc.assert(
      fc.property(
        fc.constantFrom("", "unknown"),
        (name) => {
          const mapped = mapKiroToolName(name);
          expect(formatToolStatus(mapped, {})).toBe("Working");
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns "Using {name}" for non-empty, non-"unknown" unmapped names', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter(
          (s) => !KNOWN_KIRO_NAMES.includes(s) && s !== "unknown",
        ),
        (name) => {
          const mapped = mapKiroToolName(name);
          expect(formatToolStatus(mapped, {})).toBe(`Using ${name}`);
        },
      ),
      { numRuns: 100 },
    );
  });
});
