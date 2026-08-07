/**
 * One identity per file: the URI VS Code owns, and the URI the server sees.
 *
 * Pyright's browser build is backed by an in-memory filesystem keyed on POSIX
 * paths, so everything it is told about must be `file:`. A workspace on any
 * other scheme (`memfs:`, `idbfs:`, `localfs:`, `vscode-vfs:`) is transplanted
 * onto one synthetic root; a `file:` workspace already speaks the server's
 * language and passes straight through.
 *
 * Strings rather than `vscode.Uri`, so it is unit-testable in Node. Only the
 * suffix ever moves, which leaves each scheme's own escaping untouched.
 */

/**
 * Not `file:///`. The embedded typeshed lives at `file:///typeshed` in the same
 * VFS, and a workspace rooted at `/` would swallow all 5,407 stubs as user code.
 */
export const SERVER_ROOT = 'file:///workspace';

export interface UriMap {
	/** The root to report as the client's workspace folder. */
	readonly serverRoot: string;
	/** `undefined` when the URI is outside the workspace, so callers can leave it alone. */
	toServerUri(workspaceUri: string): string | undefined;
	/** `undefined` for anything the server owns itself, typeshed above all. */
	toWorkspaceUri(serverUri: string): string | undefined;
}

export function createUriMap(workspaceRoot: string, serverRoot: string = SERVER_ROOT): UriMap {
	const workspace = trimSlash(workspaceRoot);
	if (workspace.startsWith('file:')) {
		return { serverRoot: workspace, toServerUri: identity, toWorkspaceUri: identity };
	}

	const server = trimSlash(serverRoot);
	return {
		serverRoot: server,
		toServerUri: (uri) => rebase(uri, workspace, server),
		toWorkspaceUri: (uri) => rebase(uri, server, workspace),
	};
}

function rebase(uri: string, from: string, to: string): string | undefined {
	const trimmed = trimSlash(uri);
	if (trimmed === from) return to;
	// The `/` matters: 'memfs:/welcome-old' is not inside 'memfs:/welcome'.
	if (!trimmed.startsWith(`${from}/`)) return undefined;
	return to + trimmed.slice(from.length);
}

const identity = (uri: string) => uri;

const trimSlash = (uri: string) => (uri.endsWith('/') ? uri.slice(0, -1) : uri);
