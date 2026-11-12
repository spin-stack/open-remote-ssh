import * as vscode from 'vscode';
import Log from './logger';
import { SpinboxResolver, SPIN_AUTHORITY } from './spin/resolver';

export const SHOW_LOG_COMMAND = 'spinremote.showLog';

export function activate(context: vscode.ExtensionContext) {
    const logger = new Log('Spinbox Remote');
    context.subscriptions.push(logger);

    const resolver = new SpinboxResolver(logger);
    context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(SPIN_AUTHORITY, resolver));
    context.subscriptions.push(resolver);

    context.subscriptions.push(vscode.commands.registerCommand(SHOW_LOG_COMMAND, () => logger.show()));
}

export function deactivate() {
}
