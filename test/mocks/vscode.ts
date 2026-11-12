// The `vscode` module for the unit tests, aliased in by vitest.config.ts: the real one exists only
// in the extension host. It holds what the extension calls, and records what it registers and
// shows, so a test asserts what a person would see.

export const version = '1.146.0';

export const env = {
    appRoot: '/vscode/appRoot',
    openExternal(_uri: unknown): Promise<boolean> {
        return Promise.resolve(true);
    },
};

/** Settings a test sets, by their whole id (remote.spin.cliPath); the rest are their defaults. */
export const configOverrides = new Map<string, unknown>();

/** The resolvers activate registered, by authority. */
export const resolvers = new Map<string, unknown>();

export const workspace = {
    getConfiguration(section?: string) {
        return {
            get<T>(key: string, defaultValue?: T): T | undefined {
                const id = section ? `${section}.${key}` : key;
                return configOverrides.has(id) ? configOverrides.get(id) as T : defaultValue;
            },
        };
    },
    registerRemoteAuthorityResolver(authority: string, resolver: unknown) {
        resolvers.set(authority, resolver);
        return { dispose: () => resolvers.delete(authority) };
    },
};

export const extensions = {
    getExtension(_id: string): { extensionPath: string } | undefined {
        return undefined;
    },
};

class MockOutputChannel {
    public readonly lines: string[] = [];
    public constructor(public readonly name: string) { }
    public appendLine(value: string): void {
        this.lines.push(value);
    }
    public show(): void { }
    public dispose(): void { }
}

/** What window.showErrorMessage was asked to show: the message, the options, the buttons. */
export const shownErrors: unknown[][] = [];

export enum ProgressLocation {
    Notification = 15,
}

export const window = {
    createOutputChannel(name: string): MockOutputChannel {
        return new MockOutputChannel(name);
    },
    withProgress<T>(_options: unknown, task: () => Promise<T>): Promise<T> {
        return task();
    },
    showErrorMessage(message: string, ...items: unknown[]): Promise<unknown> {
        shownErrors.push([message, ...items]);
        return Promise.resolve(undefined);
    },
    createTerminal(_options: unknown) {
        return { show() { }, sendText(_text: string) { } };
    },
};

/** The commands activate registered, by id. */
export const registeredCommands = new Map<string, () => unknown>();

export const commands = {
    registerCommand(id: string, handler: () => unknown) {
        registeredCommands.set(id, handler);
        return { dispose: () => registeredCommands.delete(id) };
    },
};

export const Uri = {
    parse(value: string) {
        return { toString: () => value };
    },
};

export class ResolvedAuthority {
    public constructor(public readonly host: string, public readonly port: number, public readonly connectionToken?: string) { }
}

export class RemoteAuthorityResolverError extends Error {
    private constructor(message: string, public readonly temporary: boolean) {
        super(message);
    }
    public static NotAvailable(message: string, _handled?: boolean) {
        return new RemoteAuthorityResolverError(message, false);
    }
    public static TemporarilyNotAvailable(message: string) {
        return new RemoteAuthorityResolverError(message, true);
    }
}
