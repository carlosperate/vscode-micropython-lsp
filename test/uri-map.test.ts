import { describe, expect, it } from 'vitest';

import { createUriMap, SERVER_ROOT } from '../client/src/uri-map';

// The mirror's whole correctness rests on this pair, and a gap in it is silent:
// the server keeps answering, just about a file that does not exist.
describe('createUriMap, virtual workspace', () => {
	const map = createUriMap('memfs:/welcome');

	it('transplants a workspace file onto the server root', () => {
		expect(map.toServerUri('memfs:/welcome/main.py')).toBe(`${SERVER_ROOT}/main.py`);
	});

	it('keeps nested directories', () => {
		expect(map.toServerUri('memfs:/welcome/lib/util.py')).toBe(`${SERVER_ROOT}/lib/util.py`);
	});

	it('maps the workspace root itself', () => {
		expect(map.toServerUri('memfs:/welcome')).toBe(SERVER_ROOT);
		expect(map.toWorkspaceUri(SERVER_ROOT)).toBe('memfs:/welcome');
	});

	it('round-trips', () => {
		for (const uri of ['memfs:/welcome/main.py', 'memfs:/welcome/pkg/__init__.py', 'memfs:/welcome']) {
			expect(map.toWorkspaceUri(map.toServerUri(uri)!)).toBe(uri);
		}
	});

	it('refuses a URI outside the workspace', () => {
		expect(map.toServerUri('memfs:/other/main.py')).toBeUndefined();
		expect(map.toServerUri('idbfs:/welcome/main.py')).toBeUndefined();
	});

	it('refuses a sibling that merely starts with the root', () => {
		// The prefix bug: 'memfs:/welcome-old' is not inside 'memfs:/welcome'.
		expect(map.toServerUri('memfs:/welcome-old/main.py')).toBeUndefined();
	});

	it('leaves server URIs outside the server root alone', () => {
		// Go-to-definition into a stub answers with the typeshed root, which is a
		// real server path and must not be rewritten into the workspace.
		expect(map.toWorkspaceUri('file:///typeshed/stdlib/builtins.pyi')).toBeUndefined();
		expect(map.toWorkspaceUri(`${SERVER_ROOT}-other/main.py`)).toBeUndefined();
	});

	it('preserves each scheme\'s own escaping', () => {
		// Only the suffix moves, so nothing re-encodes and the round trip is exact.
		expect(map.toServerUri('memfs:/welcome/my%20folder/main.py')).toBe(`${SERVER_ROOT}/my%20folder/main.py`);
		expect(map.toWorkspaceUri(`${SERVER_ROOT}/my%20folder/main.py`)).toBe('memfs:/welcome/my%20folder/main.py');
	});
});

describe('createUriMap, root shapes', () => {
	it('tolerates a trailing slash on the workspace root', () => {
		expect(createUriMap('memfs:/welcome/').toServerUri('memfs:/welcome/main.py')).toBe(`${SERVER_ROOT}/main.py`);
	});

	it('handles a whole-scheme root', () => {
		const map = createUriMap('idbfs:/');
		expect(map.toServerUri('idbfs:/main.py')).toBe(`${SERVER_ROOT}/main.py`);
		expect(map.toWorkspaceUri(`${SERVER_ROOT}/main.py`)).toBe('idbfs:/main.py');
	});

	it('handles a root with an authority', () => {
		const map = createUriMap('vscode-vfs://github/user/repo');
		expect(map.toServerUri('vscode-vfs://github/user/repo/main.py')).toBe(`${SERVER_ROOT}/main.py`);
		expect(map.toWorkspaceUri(`${SERVER_ROOT}/main.py`)).toBe('vscode-vfs://github/user/repo/main.py');
	});
});

describe('createUriMap, file workspace', () => {
	// Desktop, where the workspace already speaks the server's language. Rewriting
	// would be the only way to get it wrong.
	const map = createUriMap('file:///home/me/proj');

	it('passes both directions through untouched', () => {
		expect(map.toServerUri('file:///home/me/proj/main.py')).toBe('file:///home/me/proj/main.py');
		expect(map.toWorkspaceUri('file:///home/me/proj/main.py')).toBe('file:///home/me/proj/main.py');
	});

	it('reports the workspace root as the server root', () => {
		expect(map.serverRoot).toBe('file:///home/me/proj');
	});

	it('passes through a path outside the workspace too', () => {
		expect(map.toWorkspaceUri('file:///typeshed/stdlib/builtins.pyi')).toBe('file:///typeshed/stdlib/builtins.pyi');
	});
});
