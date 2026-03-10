# Pixel Agents — Kiro Setup

Pixel Agents works with Kiro through an HTTP bridge server and four agent hooks. When you use Kiro in this workspace, your AI agent gets its own animated pixel character that reacts to what it's doing in real time.

## How It Works

The extension starts a local HTTP server on `127.0.0.1` and writes its port to `~/.pixel-agents/kiro-port`. Kiro hooks fire at four lifecycle points and use `curl` to POST JSON events directly to the server — no intermediate files, no polling.

```
Kiro hook → curl POST → HTTP bridge server → Pixel Agents webview
```

## Prerequisites

- [Kiro IDE](https://kiro.dev) (a VS Code fork — does not use the VS Code marketplace)
- The Pixel Agents VSIX installed manually (see below)
- `curl` available on your system (ships with macOS and most Linux distros)

## Installing the Extension in Kiro

Since Kiro doesn't use the VS Code marketplace, you need to build and install the VSIX manually:

```bash
git clone https://github.com/pablodelucca/pixel-agents.git
cd pixel-agents
npm install
cd webview-ui && npm install && cd ..
npm run vsix
```

This produces a `pixel-agents-*.vsix` file. Install it in Kiro:

1. Open Kiro
2. Open the Command Palette (Cmd+Shift+P / Ctrl+Shift+P)
3. Run "Extensions: Install from VSIX..."
4. Select the `.vsix` file

## Setup

The extension auto-detects Kiro workspaces (those with a `.kiro/` directory) and offers to scaffold the hooks on first activation. Click "Setup" when prompted.

You can also set up manually via the Command Palette: "Pixel Agents: Setup Kiro Bridge".

The four hook files in `.kiro/hooks/`:

| Hook File | Event | What It Does |
|---|---|---|
| `pixel-agents-prompt.kiro.hook` | `promptSubmit` | Notifies the extension a new prompt was submitted |
| `pixel-agents-tool-start.kiro.hook` | `preToolUse` | Sends the tool name, gets back a toolId for correlation |
| `pixel-agents-tool-done.kiro.hook` | `postToolUse` | Sends the toolId to mark the tool as complete |
| `pixel-agents-agent-stop.kiro.hook` | `agentStop` | Tells the extension the agent finished its turn |

The `preToolUse` and `postToolUse` hooks filter on `["read", "write", "shell"]` tool types to avoid recursive firing from the hooks' own `runCommand` invocations.

## Upgrading from the Old Bridge

If you previously used the bash-script bridge (`pixel-agents-bridge.sh`), the extension will detect it and offer to upgrade to HTTP-based hooks automatically. The old script is removed and the hooks are rewritten to use `curl`.

## Verifying It Works

1. Open the Pixel Agents panel (bottom panel area)
2. Check that `~/.pixel-agents/kiro-port` exists and contains a port number
3. Send a prompt in Kiro
4. A pixel character should appear and start animating

The character will show different animations based on what Kiro is doing — reading files, writing code, running commands, etc. When Kiro finishes its turn, the character enters a waiting state and is cleaned up after a short delay.

## Testing with the Simulator

You can test the HTTP bridge without Kiro using the included simulator script:

```bash
bash scripts/simulate-http-agents.sh [num_agents] [duration_seconds]
# defaults: 2 agents, 30 seconds
```

This curls the HTTP bridge directly with realistic tool sequences.

## Disabling the Bridge

To temporarily disable the bridge without removing the hook files, set `"enabled": false` in any of the `.kiro/hooks/pixel-agents-*.kiro.hook` files.

To remove the hooks entirely: "Pixel Agents: Remove Kiro Bridge" from the Command Palette.

## Tool Name Mapping

The HTTP bridge translates Kiro tool names to the display labels Pixel Agents uses:

| Kiro Tools | Pixel Agents Label |
|---|---|
| `readFile`, `readCode`, `readMultipleFiles`, `getDiagnostics` | Read |
| `editCode`, `strReplace`, `semanticRename`, `smartRelocate` | Edit |
| `fsWrite`, `fsAppend`, `deleteFile`, `createHook` | Write |
| `executeBash` | Bash |
| `fileSearch`, `listDirectory` | Glob |
| `grepSearch`, `mcp_builder_mcp_WorkspaceSearch` | Grep |
| `remote_web_search`, `webFetch` | WebFetch |
| `invokeSubAgent` | Task |

Unknown tools pass through with their original name and show "Using {name}" as the status.

## Running Tests

```bash
npm test
```

This runs all property-based and unit tests including the HTTP bridge server, handlers, tool name mapping, and hook configuration tests.

## Troubleshooting

**No character appears** — Check that the Pixel Agents panel is open and `~/.pixel-agents/kiro-port` exists. Try `curl -sf http://127.0.0.1:$(cat ~/.pixel-agents/kiro-port)/prompt-start -d '{}'` to verify the server is responding.

**Character doesn't animate on tool use** — The `preToolUse`/`postToolUse` hooks only fire for `read`, `write`, and `shell` tool types. Web searches, sub-agent invocations via MCP, and other tool categories won't trigger animations unless you expand the `toolTypes` filter.

**Character stays active after Kiro finishes** — Make sure the `pixel-agents-agent-stop.kiro.hook` is enabled. The `agentStop` hook is what tells the character to enter waiting state.

**Port file missing** — The HTTP bridge server may have failed to start. Check the VS Code developer console (Help → Toggle Developer Tools) for errors containing `[Pixel Agents] HTTP bridge`.
