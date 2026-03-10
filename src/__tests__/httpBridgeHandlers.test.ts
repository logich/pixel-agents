/**
 * Property-based tests for HTTP bridge endpoint handlers.
 *
 * Tests Properties 7–12 and 15 from the kiro-http-bridge design document.
 * Each test uses fast-check with a minimum of 100 iterations.
 *
 * Validates: Requirements 3.1, 3.2, 3.5, 3.6, 4.1, 4.2, 4.3, 5.1, 5.2,
 *            6.1, 6.2, 8.1, 8.2, 9.3
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// Mock vscode module before importing anything that depends on it
vi.mock('vscode', () => ({}), { virtual: true });

import {
	handlePromptStart,
	handleToolStart,
	handleToolDone,
	handleAgentStop,
} from '../httpBridgeHandlers.js';
import type { HandlerContext } from '../httpBridgeHandlers.js';
import type { AgentState } from '../types.js';

// ── Arbitrary for tool names ────────────────────────────────────────────────
const toolNameArb = fc.oneof(
	fc.constantFrom('readFile', 'editCode', 'fsWrite', 'executeBash', 'grepSearch', 'listDirectory'),
	fc.string({ minLength: 1, maxLength: 50 }),
);

// ── Helper: create a fresh HandlerContext ───────────────────────────────────
function makeContext(): HandlerContext & { messages: unknown[]; cleanupCalls: number[] } {
	const messages: unknown[] = [];
	const cleanupCalls: number[] = [];
	return {
		agents: new Map(),
		nextAgentIdRef: { current: 1 },
		activeAgentIdRef: { current: null },
		getWebview: () => ({ postMessage: (msg: unknown) => { messages.push(msg); } }) as never,
		persistAgents: () => {},
		onTerminalLessTurnEnd: (id: number) => { cleanupCalls.push(id); },
		waitingTimers: new Map(),
		permissionTimers: new Map(),
		httpAgentIdRef: { current: null },
		httpInactivityTimerRef: { current: null },
		messages,
		cleanupCalls,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});


// ── Property 7: Tool-start creates agent and returns unique toolId ──────────
// Feature: kiro-http-bridge, Property 7: Tool-start creates agent and returns unique toolId
describe('Property 7: Tool-start creates agent and returns unique toolId', () => {
	// **Validates: Requirements 3.1, 3.5, 3.6, 8.1**

	it('returns a ToolStartResponse with a toolId string and creates an HTTP agent with terminalRef === null', () => {
		fc.assert(
			fc.property(toolNameArb, (toolName) => {
				const ctx = makeContext();
				const result = handleToolStart(ctx, { tool: toolName });

				// Should return a toolId string (Req 3.5)
				expect(typeof result.toolId).toBe('string');
				expect(result.toolId.length).toBeGreaterThan(0);

				// An HTTP agent should exist (Req 3.1)
				expect(ctx.httpAgentIdRef.current).not.toBeNull();
				const agent = ctx.agents.get(ctx.httpAgentIdRef.current!);
				expect(agent).toBeDefined();

				// The agent should have the toolId in activeToolIds
				expect(agent!.activeToolIds.has(result.toolId)).toBe(true);

				// The agent should have terminalRef === null (Req 8.1)
				expect(agent!.terminalRef).toBeNull();
			}),
			{ numRuns: 100 },
		);
	});

	it('all returned toolIds are distinct across a sequence of tool-start calls', () => {
		fc.assert(
			fc.property(
				fc.array(toolNameArb, { minLength: 2, maxLength: 20 }),
				(toolNames) => {
					const ctx = makeContext();
					const toolIds = toolNames.map((name) => handleToolStart(ctx, { tool: name }).toolId);

					// All toolIds should be unique (Req 3.6)
					const uniqueIds = new Set(toolIds);
					expect(uniqueIds.size).toBe(toolIds.length);
				},
			),
			{ numRuns: 100 },
		);
	});
});


// ── Property 8: Tool-start then tool-done round-trip ────────────────────────
// Feature: kiro-http-bridge, Property 8: Tool-start then tool-done round-trip
describe('Property 8: Tool-start then tool-done round-trip', () => {
	// **Validates: Requirements 4.1, 4.3**

	it('completing all started tools empties activeToolIds and sets hadToolsInTurn to false', () => {
		fc.assert(
			fc.property(
				fc.array(toolNameArb, { minLength: 1, maxLength: 15 }),
				(toolNames) => {
					const ctx = makeContext();

					// Start all tools and collect their toolIds
					const toolIds = toolNames.map((name) => handleToolStart(ctx, { tool: name }).toolId);

					const agent = ctx.agents.get(ctx.httpAgentIdRef.current!)!;
					expect(agent.activeToolIds.size).toBe(toolIds.length);

					// Complete each tool (Req 4.1)
					for (const toolId of toolIds) {
						handleToolDone(ctx, { toolId });
					}

					// After all tools completed, activeToolIds should be empty (Req 4.3)
					expect(agent.activeToolIds.size).toBe(0);
					expect(agent.hadToolsInTurn).toBe(false);
				},
			),
			{ numRuns: 100 },
		);
	});
});

// ── Property 9: Tool-done with unknown toolId is idempotent ─────────────────
// Feature: kiro-http-bridge, Property 9: Tool-done with unknown toolId is idempotent
describe('Property 9: Tool-done with unknown toolId is idempotent', () => {
	// **Validates: Requirements 4.2**

	it('calling handleToolDone with a random unknown toolId does not modify any agent state', () => {
		fc.assert(
			fc.property(
				fc.array(toolNameArb, { minLength: 1, maxLength: 5 }),
				fc.uuid(),
				(toolNames, unknownToolId) => {
					const ctx = makeContext();

					// Start some tools to create an agent with state
					const startedIds = toolNames.map((name) => handleToolStart(ctx, { tool: name }).toolId);

					// Ensure the unknown toolId was not returned by any tool-start
					fc.pre(!startedIds.includes(unknownToolId));

					const agent = ctx.agents.get(ctx.httpAgentIdRef.current!)!;

					// Snapshot state before
					const toolIdsBefore = new Set(agent.activeToolIds);
					const statusesBefore = new Map(agent.activeToolStatuses);
					const namesBefore = new Map(agent.activeToolNames);
					const hadToolsBefore = agent.hadToolsInTurn;
					const isWaitingBefore = agent.isWaiting;

					// Call tool-done with unknown toolId (Req 4.2)
					handleToolDone(ctx, { toolId: unknownToolId });

					// State should be unchanged
					expect(new Set(agent.activeToolIds)).toEqual(toolIdsBefore);
					expect(new Map(agent.activeToolStatuses)).toEqual(statusesBefore);
					expect(new Map(agent.activeToolNames)).toEqual(namesBefore);
					expect(agent.hadToolsInTurn).toBe(hadToolsBefore);
					expect(agent.isWaiting).toBe(isWaitingBefore);
				},
			),
			{ numRuns: 100 },
		);
	});

	it('calling handleToolDone with no agent present does not throw', () => {
		fc.assert(
			fc.property(fc.uuid(), (unknownToolId) => {
				const ctx = makeContext();
				// No agent exists — should be a no-op
				expect(() => handleToolDone(ctx, { toolId: unknownToolId })).not.toThrow();
				expect(ctx.agents.size).toBe(0);
			}),
			{ numRuns: 100 },
		);
	});
});


// ── Property 10: Prompt-start creates or reactivates agent ──────────────────
// Feature: kiro-http-bridge, Property 10: Prompt-start creates or reactivates agent
describe('Property 10: Prompt-start creates or reactivates agent', () => {
	// **Validates: Requirements 5.1, 5.2**

	it('creates a new agent with terminalRef === null and isWaiting === false when no HTTP agent exists', () => {
		fc.assert(
			fc.property(fc.constant(null), () => {
				const ctx = makeContext();

				// No agent exists yet
				expect(ctx.httpAgentIdRef.current).toBeNull();

				handlePromptStart(ctx);

				// A new agent should be created (Req 5.1)
				expect(ctx.httpAgentIdRef.current).not.toBeNull();
				const agent = ctx.agents.get(ctx.httpAgentIdRef.current!);
				expect(agent).toBeDefined();
				expect(agent!.terminalRef).toBeNull();
				expect(agent!.isWaiting).toBe(false);
			}),
			{ numRuns: 100 },
		);
	});

	it('reactivates a waiting agent without creating a new one (same agent ID)', () => {
		fc.assert(
			fc.property(
				fc.array(toolNameArb, { minLength: 1, maxLength: 5 }),
				(toolNames) => {
					const ctx = makeContext();

					// Create an agent and put it in waiting state via agent-stop
					for (const name of toolNames) {
						handleToolStart(ctx, { tool: name });
					}
					handleAgentStop(ctx);

					const agentId = ctx.httpAgentIdRef.current!;
					const agent = ctx.agents.get(agentId)!;
					expect(agent.isWaiting).toBe(true);

					const agentCountBefore = ctx.agents.size;

					// Reactivate via prompt-start (Req 5.2)
					handlePromptStart(ctx);

					// Same agent ID — no new agent created
					expect(ctx.httpAgentIdRef.current).toBe(agentId);
					expect(ctx.agents.size).toBe(agentCountBefore);
					expect(agent.isWaiting).toBe(false);
				},
			),
			{ numRuns: 100 },
		);
	});
});

// ── Property 11: Agent-stop clears all state and triggers cleanup ───────────
// Feature: kiro-http-bridge, Property 11: Agent-stop clears all state and triggers cleanup
describe('Property 11: Agent-stop clears all state and triggers cleanup', () => {
	// **Validates: Requirements 6.1, 6.2, 8.2**

	it('clears activeToolIds, sets isWaiting true, hadToolsInTurn false, and invokes onTerminalLessTurnEnd', () => {
		fc.assert(
			fc.property(
				fc.array(toolNameArb, { minLength: 1, maxLength: 15 }),
				(toolNames) => {
					const ctx = makeContext();

					// Start tools to build up agent state
					for (const name of toolNames) {
						handleToolStart(ctx, { tool: name });
					}

					const agentId = ctx.httpAgentIdRef.current!;
					const agent = ctx.agents.get(agentId)!;
					expect(agent.activeToolIds.size).toBe(toolNames.length);

					// Stop the agent (Req 6.1, 6.2)
					handleAgentStop(ctx);

					// All tool state should be cleared (Req 6.1)
					expect(agent.activeToolIds.size).toBe(0);
					expect(agent.activeToolStatuses.size).toBe(0);
					expect(agent.activeToolNames.size).toBe(0);

					// Waiting and turn flags (Req 6.1)
					expect(agent.isWaiting).toBe(true);
					expect(agent.hadToolsInTurn).toBe(false);

					// onTerminalLessTurnEnd should have been called with the agent ID (Req 8.2)
					expect(ctx.cleanupCalls).toContain(agentId);
				},
			),
			{ numRuns: 100 },
		);
	});

	it('is a no-op when no HTTP agent exists', () => {
		fc.assert(
			fc.property(fc.constant(null), () => {
				const ctx = makeContext();
				expect(() => handleAgentStop(ctx)).not.toThrow();
				expect(ctx.cleanupCalls).toHaveLength(0);
			}),
			{ numRuns: 100 },
		);
	});
});

// ── Property 12: HTTP and terminal agents are independent ───────────────────
// Feature: kiro-http-bridge, Property 12: HTTP and terminal agents are independent
describe('Property 12: HTTP and terminal agents are independent', () => {
	// **Validates: Requirements 9.3**

	it('operations on the HTTP agent do not modify a terminal agent state', () => {
		fc.assert(
			fc.property(
				fc.array(toolNameArb, { minLength: 1, maxLength: 10 }),
				(toolNames) => {
					const ctx = makeContext();

					// Create a mock terminal agent manually in the agents map
					const terminalAgentId = 999;
					const terminalAgent: AgentState = {
						id: terminalAgentId,
						terminalRef: null, // simplified mock — real terminal agents have a Terminal ref
						projectDir: '/some/project',
						jsonlFile: '/some/file.jsonl',
						fileOffset: 42,
						lineBuffer: 'some-buffer',
						activeToolIds: new Set(['existing-tool-1']),
						activeToolStatuses: new Map([['existing-tool-1', 'Reading']]),
						activeToolNames: new Map([['existing-tool-1', 'Read']]),
						activeSubagentToolIds: new Map(),
						activeSubagentToolNames: new Map(),
						isWaiting: false,
						permissionSent: false,
						hadToolsInTurn: true,
					};
					ctx.agents.set(terminalAgentId, terminalAgent);

					// Snapshot terminal agent state
					const snapshotToolIds = new Set(terminalAgent.activeToolIds);
					const snapshotStatuses = new Map(terminalAgent.activeToolStatuses);
					const snapshotNames = new Map(terminalAgent.activeToolNames);
					const snapshotOffset = terminalAgent.fileOffset;
					const snapshotLineBuffer = terminalAgent.lineBuffer;
					const snapshotIsWaiting = terminalAgent.isWaiting;
					const snapshotHadTools = terminalAgent.hadToolsInTurn;

					// Perform HTTP agent operations
					handlePromptStart(ctx);
					for (const name of toolNames) {
						handleToolStart(ctx, { tool: name });
					}
					handleAgentStop(ctx);

					// Terminal agent state should be completely unchanged (Req 9.3)
					expect(new Set(terminalAgent.activeToolIds)).toEqual(snapshotToolIds);
					expect(new Map(terminalAgent.activeToolStatuses)).toEqual(snapshotStatuses);
					expect(new Map(terminalAgent.activeToolNames)).toEqual(snapshotNames);
					expect(terminalAgent.fileOffset).toBe(snapshotOffset);
					expect(terminalAgent.lineBuffer).toBe(snapshotLineBuffer);
					expect(terminalAgent.isWaiting).toBe(snapshotIsWaiting);
					expect(terminalAgent.hadToolsInTurn).toBe(snapshotHadTools);
				},
			),
			{ numRuns: 100 },
		);
	});
});

// ── Property 15: Tool-start input validation ────────────────────────────────
// Feature: kiro-http-bridge, Property 15: Tool-start input validation
describe('Property 15: Tool-start input validation', () => {
	// **Validates: Requirements 3.2**

	it('handleToolStart works with various valid tool name strings', () => {
		fc.assert(
			fc.property(toolNameArb, (toolName) => {
				const ctx = makeContext();
				const result = handleToolStart(ctx, { tool: toolName });

				// Should succeed and return a valid toolId
				expect(typeof result.toolId).toBe('string');
				expect(result.toolId.length).toBeGreaterThan(0);

				// Agent should exist with the tool tracked
				const agent = ctx.agents.get(ctx.httpAgentIdRef.current!)!;
				expect(agent.activeToolIds.has(result.toolId)).toBe(true);
			}),
			{ numRuns: 100 },
		);
	});

	it('handleToolStart accepts known Kiro tool names', () => {
		const knownTools = ['readFile', 'editCode', 'fsWrite', 'executeBash', 'grepSearch', 'listDirectory'];
		for (const tool of knownTools) {
			const ctx = makeContext();
			const result = handleToolStart(ctx, { tool });
			expect(typeof result.toolId).toBe('string');
			expect(result.toolId.length).toBeGreaterThan(0);
		}
	});
});
