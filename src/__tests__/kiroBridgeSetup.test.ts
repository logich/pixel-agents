/**
 * Unit tests for hook generation and migration in kiroBridgeSetup.ts.
 *
 * - Property 16: Generated hook files use curl with correct structure
 * - Old bridge detection (isOldBridgeSetUp)
 * - Migration flow (migrateToHttpBridge)
 * - Bridge setup detection (isBridgeSetUp)
 *
 * Validates: Requirements 7.1, 7.3, 7.4, 10.4, 12.1, 12.3, 12.4
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock vscode module before importing anything that depends on it.
// @ts-expect-error — vitest supports the virtual option at runtime
vi.mock('vscode', () => ({
	workspace: { workspaceFolders: [] },
	window: {
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
	commands: { registerCommand: vi.fn() },
}), { virtual: true });

import {
	getHookDefinitions,
	isBridgeSetUp,
	isOldBridgeSetUp,
	migrateToHttpBridge,
} from '../kiroBridgeSetup.js';

// ── Property 16: Generated hook files use curl with correct structure ───────
// Feature: kiro-http-bridge, Property 16: Generated hook files use curl with correct structure
describe('Property 16: Generated hook files use curl with correct structure', () => {
	// **Validates: Requirements 7.1, 7.3, 7.4, 10.4**

	const hookDefs = getHookDefinitions();

	it('returns exactly 4 hook files', () => {
		expect(Object.keys(hookDefs)).toHaveLength(4);
	});

	const expectedHooks: Array<{
		filename: string;
		whenType: string;
		endpoint: string;
		hasToolTypes: boolean;
	}> = [
		{ filename: 'pixel-agents-prompt.kiro.hook', whenType: 'promptSubmit', endpoint: '/prompt-start', hasToolTypes: false },
		{ filename: 'pixel-agents-tool-start.kiro.hook', whenType: 'preToolUse', endpoint: '/tool-start', hasToolTypes: true },
		{ filename: 'pixel-agents-tool-done.kiro.hook', whenType: 'postToolUse', endpoint: '/tool-done', hasToolTypes: true },
		{ filename: 'pixel-agents-agent-stop.kiro.hook', whenType: 'agentStop', endpoint: '/agent-stop', hasToolTypes: false },
	];

	it('all expected hook filenames are present', () => {
		const filenames = Object.keys(hookDefs);
		for (const h of expectedHooks) {
			expect(filenames).toContain(h.filename);
		}
	});

	for (const h of expectedHooks) {
		describe(h.filename, () => {
			const def = hookDefs[h.filename] as Record<string, unknown>;
			const when = def['when'] as Record<string, unknown>;
			const then = def['then'] as Record<string, unknown>;
			const command = then['command'] as string;

			it(`has when.type = "${h.whenType}"`, () => {
				expect(when['type']).toBe(h.whenType);
			});

			it(`command contains curl targeting http://127.0.0.1:$PORT${h.endpoint} (Req 7.1)`, () => {
				expect(command).toContain('curl');
				expect(command).toContain(`http://127.0.0.1:$PORT${h.endpoint}`);
			});

			it('command includes || true suffix (Req 10.4)', () => {
				expect(command).toMatch(/\|\| true\s*$/);
			});

			it('command includes -sf flag', () => {
				expect(command).toContain('-sf');
			});

			it('command includes -m 2 timeout flag', () => {
				expect(command).toContain('-m 2');
			});

			if (h.hasToolTypes) {
				it('has toolTypes ["read", "write", "shell"] (Req 7.3)', () => {
					expect(when['toolTypes']).toEqual(['read', 'write', 'shell']);
				});
			}
		});
	}

	it('tool-start command includes $KIRO_TOOL_NAME', () => {
		const toolStartDef = hookDefs['pixel-agents-tool-start.kiro.hook'] as Record<string, unknown>;
		const then = toolStartDef['then'] as Record<string, unknown>;
		expect(then['command']).toContain('$KIRO_TOOL_NAME');
	});

	it('tool-done command includes $KIRO_TOOL_ID', () => {
		const toolDoneDef = hookDefs['pixel-agents-tool-done.kiro.hook'] as Record<string, unknown>;
		const then = toolDoneDef['then'] as Record<string, unknown>;
		expect(then['command']).toContain('$KIRO_TOOL_ID');
	});
});

// ── Temp directory helpers for filesystem-based tests ────────────────────────

const HOOK_FILES = [
	'pixel-agents-prompt.kiro.hook',
	'pixel-agents-tool-start.kiro.hook',
	'pixel-agents-tool-done.kiro.hook',
	'pixel-agents-agent-stop.kiro.hook',
];

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-bridge-test-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Old bridge detection tests ──────────────────────────────────────────────
describe('isOldBridgeSetUp', () => {
	// **Validates: Requirements 12.1**

	it('returns true when .kiro/scripts/pixel-agents-bridge.sh exists', () => {
		const scriptDir = path.join(tmpDir, '.kiro', 'scripts');
		fs.mkdirSync(scriptDir, { recursive: true });
		fs.writeFileSync(path.join(scriptDir, 'pixel-agents-bridge.sh'), '#!/bin/bash\n', 'utf-8');

		expect(isOldBridgeSetUp(tmpDir)).toBe(true);
	});

	it('returns false when the script does not exist', () => {
		expect(isOldBridgeSetUp(tmpDir)).toBe(false);
	});
});

// ── Migration tests ─────────────────────────────────────────────────────────
describe('migrateToHttpBridge', () => {
	// **Validates: Requirements 12.3, 12.4**

	it('removes the old bridge script (Req 12.3)', () => {
		const scriptDir = path.join(tmpDir, '.kiro', 'scripts');
		fs.mkdirSync(scriptDir, { recursive: true });
		const scriptPath = path.join(scriptDir, 'pixel-agents-bridge.sh');
		fs.writeFileSync(scriptPath, '#!/bin/bash\n', 'utf-8');

		migrateToHttpBridge(tmpDir);

		expect(fs.existsSync(scriptPath)).toBe(false);
	});

	it('writes new HTTP-based hook files', () => {
		const scriptDir = path.join(tmpDir, '.kiro', 'scripts');
		fs.mkdirSync(scriptDir, { recursive: true });
		fs.writeFileSync(path.join(scriptDir, 'pixel-agents-bridge.sh'), '#!/bin/bash\n', 'utf-8');

		migrateToHttpBridge(tmpDir);

		const hooksDir = path.join(tmpDir, '.kiro', 'hooks');
		for (const hookFile of HOOK_FILES) {
			const hookPath = path.join(hooksDir, hookFile);
			expect(fs.existsSync(hookPath)).toBe(true);
			// Verify the hook content is valid JSON with curl command
			const content = JSON.parse(fs.readFileSync(hookPath, 'utf-8'));
			expect(content.then.command).toContain('curl');
		}
	});

	it('after migration, isBridgeSetUp returns true', () => {
		const scriptDir = path.join(tmpDir, '.kiro', 'scripts');
		fs.mkdirSync(scriptDir, { recursive: true });
		fs.writeFileSync(path.join(scriptDir, 'pixel-agents-bridge.sh'), '#!/bin/bash\n', 'utf-8');

		migrateToHttpBridge(tmpDir);

		expect(isBridgeSetUp(tmpDir)).toBe(true);
	});

	it('after migration, isOldBridgeSetUp returns false', () => {
		const scriptDir = path.join(tmpDir, '.kiro', 'scripts');
		fs.mkdirSync(scriptDir, { recursive: true });
		fs.writeFileSync(path.join(scriptDir, 'pixel-agents-bridge.sh'), '#!/bin/bash\n', 'utf-8');

		migrateToHttpBridge(tmpDir);

		expect(isOldBridgeSetUp(tmpDir)).toBe(false);
	});
});

// ── isBridgeSetUp tests ─────────────────────────────────────────────────────
describe('isBridgeSetUp', () => {

	it('returns true when all 4 hook files exist', () => {
		const hooksDir = path.join(tmpDir, '.kiro', 'hooks');
		fs.mkdirSync(hooksDir, { recursive: true });
		for (const hookFile of HOOK_FILES) {
			fs.writeFileSync(path.join(hooksDir, hookFile), '{}', 'utf-8');
		}

		expect(isBridgeSetUp(tmpDir)).toBe(true);
	});

	it('returns false when any hook file is missing', () => {
		const hooksDir = path.join(tmpDir, '.kiro', 'hooks');
		fs.mkdirSync(hooksDir, { recursive: true });

		// Write only 3 of the 4 hook files
		for (let i = 0; i < HOOK_FILES.length - 1; i++) {
			fs.writeFileSync(path.join(hooksDir, HOOK_FILES[i]), '{}', 'utf-8');
		}

		expect(isBridgeSetUp(tmpDir)).toBe(false);
	});

	it('returns false when hooks directory does not exist', () => {
		expect(isBridgeSetUp(tmpDir)).toBe(false);
	});
});
