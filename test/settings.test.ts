import { describe, expect, it } from 'vitest';

import { SERVER_TYPESHED, serverSettings } from '../client/src/settings';

// The engine asks for sections named after the extension it was built for, and
// answering out of VS Code's settings would mean contributing those names.
// Every case here is a setting that must not cross between the two extensions.
describe('serverSettings', () => {
	const user = { logLevel: 'information' };

	it('answers the analysis section with the typeshed root', () => {
		// Load-bearing: without it nothing resolves, `builtins` included.
		expect(serverSettings('basedpyright.analysis', user)).toEqual({
			typeshedPaths: [SERVER_TYPESHED],
			logLevel: 'information',
		});
	});

	it('passes the user log level through', () => {
		expect(serverSettings('basedpyright.analysis', { logLevel: 'trace' })).toMatchObject({ logLevel: 'trace' });
	});

	it('answers the basedpyright section, so the pyright fallback never runs', () => {
		// A falsy reply makes the engine ask for `pyright` instead, where a user's
		// `pyright.disableLanguageServices` would silence this extension.
		expect(serverSettings('basedpyright', user)).toBeTruthy();
		expect(serverSettings('basedpyright', user)).not.toHaveProperty('disableLanguageServices');
	});

	it('keeps the python section empty', () => {
		// `python.pythonPath` and `python.venvPath` name paths that cannot exist in
		// an in-memory filesystem, and `python.analysis.*` belongs to Pylance.
		expect(serverSettings('python', user)).toEqual({});
		expect(serverSettings('python.analysis', user)).toEqual({});
	});

	it('answers an unknown or absent section with an object, never null', () => {
		// Pyright reads properties off the reply without guarding.
		expect(serverSettings('editor', user)).toEqual({});
		expect(serverSettings(undefined, user)).toEqual({});
		expect(serverSettings(null, user)).toEqual({});
	});
});
