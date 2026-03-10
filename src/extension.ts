import * as vscode from 'vscode';
import { PixelAgentsViewProvider } from './PixelAgentsViewProvider.js';
import { VIEW_ID, COMMAND_SHOW_PANEL, COMMAND_EXPORT_DEFAULT_LAYOUT } from './constants.js';
import { checkAndOfferBridgeSetup, registerBridgeCommands } from './kiroBridgeSetup.js';

let providerInstance: PixelAgentsViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
	const provider = new PixelAgentsViewProvider(context);
	providerInstance = provider;

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_SHOW_PANEL, () => {
			vscode.commands.executeCommand(`${VIEW_ID}.focus`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_EXPORT_DEFAULT_LAYOUT, () => {
			provider.exportDefaultLayout();
		})
	);

	// Kiro bridge: register commands and offer setup if needed
	registerBridgeCommands(context);
	checkAndOfferBridgeSetup(context);

	// HTTP Bridge — start the local HTTP server for Kiro hook integration (Req 1.1)
	provider.startHttpBridge().catch((err) => {
		console.error('[Pixel Agents] Failed to start HTTP bridge:', err);
	});

}

export function deactivate() {
	// HTTP Bridge — stop the server and remove port file on deactivation (Req 1.3)
	providerInstance?.stopHttpBridge().catch(() => {});
	providerInstance?.dispose();
}
