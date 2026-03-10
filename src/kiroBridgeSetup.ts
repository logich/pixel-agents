/**
 * Kiro Bridge Setup — auto-scaffolds HTTP-based hooks on activation.
 *
 * [Modified for HTTP bridge] Hooks now use curl to POST JSON directly to the
 * local HTTP bridge server instead of invoking a bridge shell script.
 * The server port is read from ~/.pixel-agents/kiro-port at hook runtime.
 *
 * When the extension activates in a workspace, checks whether the Kiro hooks
 * exist. If not, offers to create them so the Pixel Agents integration works
 * out of the box.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ── Constants ──────────────────────────────────────────────────

/** Bridge script filename — retained for removeBridge() cleanup and migration (Task 7.2). */
const BRIDGE_SCRIPT_FILENAME = 'pixel-agents-bridge.sh';

/** Relative path to the old bridge script — retained for removeBridge() cleanup and migration. */
const BRIDGE_SCRIPT_REL = `.kiro/scripts/${BRIDGE_SCRIPT_FILENAME}`;

/** The four hook filenames. */
const HOOK_FILES = [
  'pixel-agents-prompt.kiro.hook',
  'pixel-agents-tool-start.kiro.hook',
  'pixel-agents-tool-done.kiro.hook',
  'pixel-agents-agent-stop.kiro.hook',
];

// ── Hook definitions (HTTP-based curl commands) ────────────────

/**
 * [Modified for HTTP bridge] Returns HTTP-based hook definitions using curl commands.
 * Each hook reads the server port from ~/.pixel-agents/kiro-port and POSTs JSON
 * to the local HTTP bridge server. Commands use -sf (silent+fail), -m 2 (2s timeout),
 * and || true to ensure exit code 0 regardless of outcome.
 *
 * $KIRO_TOOL_NAME and $KIRO_TOOL_ID are environment variables provided by the
 * Kiro hook runner context.
 */
export function getHookDefinitions(): Record<string, object> {
  return {
    'pixel-agents-prompt.kiro.hook': {
      enabled: true,
      name: 'Pixel Agents: Prompt Start',
      description: 'Notifies Pixel Agents when a new prompt is submitted.',
      version: '1',
      when: { type: 'promptSubmit' },
      then: {
        type: 'runCommand',
        command:
          'PORT=$(cat ~/.pixel-agents/kiro-port 2>/dev/null) && [ -n "$PORT" ] && curl -sf -m 2 -X POST -H \'Content-Type: application/json\' -d \'{}\' http://127.0.0.1:$PORT/prompt-start > /dev/null 2>&1 || true',
      },
    },
    'pixel-agents-tool-start.kiro.hook': {
      enabled: true,
      name: 'Pixel Agents: Tool Start',
      description: 'Notifies Pixel Agents when a tool starts executing.',
      version: '1',
      when: { type: 'preToolUse', toolTypes: ['read', 'write', 'shell'] },
      then: {
        type: 'runCommand',
        command:
          'PORT=$(cat ~/.pixel-agents/kiro-port 2>/dev/null) && [ -n "$PORT" ] && TOOL_ID=$(curl -sf -m 2 -X POST -H \'Content-Type: application/json\' -d "{\\"tool\\":\\"$KIRO_TOOL_NAME\\"}" http://127.0.0.1:$PORT/tool-start 2>/dev/null) || true',
      },
    },
    'pixel-agents-tool-done.kiro.hook': {
      enabled: true,
      name: 'Pixel Agents: Tool Done',
      description: 'Notifies Pixel Agents when a tool finishes executing.',
      version: '1',
      when: { type: 'postToolUse', toolTypes: ['read', 'write', 'shell'] },
      then: {
        type: 'runCommand',
        command:
          'PORT=$(cat ~/.pixel-agents/kiro-port 2>/dev/null) && [ -n "$PORT" ] && curl -sf -m 2 -X POST -H \'Content-Type: application/json\' -d "{\\"toolId\\":\\"$KIRO_TOOL_ID\\"}" http://127.0.0.1:$PORT/tool-done > /dev/null 2>&1 || true',
      },
    },
    'pixel-agents-agent-stop.kiro.hook': {
      enabled: true,
      name: 'Pixel Agents: Agent Done',
      description: 'Notifies Pixel Agents when the agent finishes its turn.',
      version: '1',
      when: { type: 'agentStop' },
      then: {
        type: 'runCommand',
        command:
          'PORT=$(cat ~/.pixel-agents/kiro-port 2>/dev/null) && [ -n "$PORT" ] && curl -sf -m 2 -X POST -H \'Content-Type: application/json\' -d \'{}\' http://127.0.0.1:$PORT/agent-stop > /dev/null 2>&1 || true',
      },
    },
  };
}

// ── Bridge state checks ────────────────────────────────────────

/**
 * [Modified for HTTP bridge] Check if the Kiro bridge hooks are set up.
 * Only checks for hook files — the bridge shell script is no longer required.
 */
export function isBridgeSetUp(workspaceRoot: string): boolean {
  const hooksDir = path.join(workspaceRoot, '.kiro', 'hooks');
  for (const hookFile of HOOK_FILES) {
    if (!fs.existsSync(path.join(hooksDir, hookFile))) return false;
  }
  return true;
}

/**
 * [Added for Task 7.2 — Migration] Detect whether the old bridge-script-based
 * setup exists. Returns true when `.kiro/scripts/pixel-agents-bridge.sh` is
 * present, indicating the workspace was configured with the pre-HTTP bridge.
 *
 * Requirement 12.1: detect existing bridge-script-based hooks.
 */
export function isOldBridgeSetUp(workspaceRoot: string): boolean {
  return fs.existsSync(path.join(workspaceRoot, BRIDGE_SCRIPT_REL));
}

/**
 * [Added for Task 7.2 — Migration] Migrate from the old bridge-script-based
 * setup to HTTP-based hooks. Removes the old shell script and overwrites
 * hook files with the new curl-based HTTP hooks via scaffoldBridge().
 *
 * Requirement 12.2: generate HTTP-based hook files on migration.
 * Requirement 12.3: remove the old bridge shell script.
 */
export function migrateToHttpBridge(workspaceRoot: string): void {
  // Remove old bridge script if it exists (Req 12.3)
  const oldScript = path.join(workspaceRoot, BRIDGE_SCRIPT_REL);
  if (fs.existsSync(oldScript)) {
    fs.unlinkSync(oldScript);
  }

  // Write new HTTP-based hooks — overwrites any old hook files (Req 12.2)
  scaffoldBridge(workspaceRoot);

  console.log('[KiroBridge] ✅ Migrated from bridge script to HTTP-based hooks');
}



// ── Scaffold / Remove ──────────────────────────────────────────

/**
 * [Modified for HTTP bridge] Scaffold HTTP-based hook files into the workspace.
 * No longer copies a bridge shell script — hooks use curl directly.
 */
function scaffoldBridge(workspaceRoot: string): void {
  const hooksDir = path.join(workspaceRoot, '.kiro', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const hookDefs = getHookDefinitions();
  for (const [filename, content] of Object.entries(hookDefs)) {
    const hookPath = path.join(hooksDir, filename);
    fs.writeFileSync(hookPath, JSON.stringify(content, null, 2) + '\n', 'utf-8');
  }

  console.log('[KiroBridge] ✅ Scaffolded 4 HTTP-based hooks');
}

/**
 * Remove the bridge script and hooks from the workspace.
 * Retained as-is — still removes old script + hooks for full cleanup.
 */
function removeBridge(workspaceRoot: string): void {
  const hooksDir = path.join(workspaceRoot, '.kiro', 'hooks');
  for (const hookFile of HOOK_FILES) {
    const p = path.join(hooksDir, hookFile);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const scriptPath = path.join(workspaceRoot, BRIDGE_SCRIPT_REL);
  if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);

  console.log('[KiroBridge] Removed bridge script and hooks');
}

// ── Extension integration ──────────────────────────────────────

/**
 * Called on extension activation. Checks if bridge is set up and offers to create it.
 * [Modified for HTTP bridge] No longer passes extensionPath to scaffoldBridge().
 * [Modified for Task 7.2 — Migration] Detects old bridge-script-based setup and
 * offers to upgrade to HTTP-based hooks before falling through to new setup offer.
 *
 * Requirement 12.1: detect existing bridge-script-based hooks.
 * Requirement 12.4: if user declines migration, leave existing hooks in place.
 */
export async function checkAndOfferBridgeSetup(
  _context: vscode.ExtensionContext,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  // Check if .kiro directory exists (indicates Kiro IDE)
  const kiroDir = path.join(workspaceRoot, '.kiro');
  if (!fs.existsSync(kiroDir)) return;

  // [Task 7.2] Check for old bridge-script-based setup and offer migration
  if (isOldBridgeSetUp(workspaceRoot)) {
    const migrationChoice = await vscode.window.showInformationMessage(
      'Pixel Agents: Upgrade Kiro bridge to HTTP-based hooks for faster agent tracking?',
      'Upgrade',
      'Dismiss',
    );

    if (migrationChoice === 'Upgrade') {
      try {
        migrateToHttpBridge(workspaceRoot);
        vscode.window.showInformationMessage(
          'Pixel Agents: Kiro bridge upgraded to HTTP-based hooks!',
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Pixel Agents: Migration failed — ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    // If user dismisses, leave existing hooks in place (Req 12.4)
    return;
  }

  // Only offer new bridge setup if old bridge is NOT detected
  if (isBridgeSetUp(workspaceRoot)) return;

  const choice = await vscode.window.showInformationMessage(
    'Pixel Agents: Set up Kiro bridge hooks for agent activity tracking?',
    'Setup',
    'Dismiss',
  );

  if (choice === 'Setup') {
    try {
      scaffoldBridge(workspaceRoot);
      vscode.window.showInformationMessage(
        'Pixel Agents: Kiro bridge is ready! Agent activity will now appear in the pixel office.',
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `Pixel Agents: Failed to set up bridge — ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}


/**
 * Register the setup/remove commands.
 * [Modified for HTTP bridge] No longer passes extensionPath to scaffoldBridge().
 */
export function registerBridgeCommands(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  context.subscriptions.push(
    vscode.commands.registerCommand('pixel-agents.setupKiroBridge', () => {
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
      }
      try {
        scaffoldBridge(workspaceRoot);
        vscode.window.showInformationMessage(
          'Pixel Agents: Kiro bridge set up successfully!',
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Pixel Agents: Setup failed — ${err instanceof Error ? err.message : err}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pixel-agents.removeKiroBridge', () => {
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
      }
      try {
        removeBridge(workspaceRoot);
        vscode.window.showInformationMessage(
          'Pixel Agents: Kiro bridge removed.',
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Pixel Agents: Removal failed — ${err instanceof Error ? err.message : err}`,
        );
      }
    }),
  );
}
