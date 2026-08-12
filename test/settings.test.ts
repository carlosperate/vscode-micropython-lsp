import { describe, expect, it } from 'vitest';

import { SERVER_TYPESHED, serverSettings } from '../client/src/settings';
import { TARGET_TYPESHED_URI } from '../client/src/target';

// The engine asks for sections named after the extension it was built for, and
// answering out of VS Code's settings would mean contributing those names.
// Every case here is a setting that must not cross between the two extensions.
describe('serverSettings', () => {
	const user = { logLevel: 'information', typeshed: SERVER_TYPESHED };

	it('answers the analysis section with exactly the keys the engine should see', () => {
		// `toEqual`, not `toMatchObject`: an extra key here is the cross-extension
		// leak this whole suite exists to catch, and only an exact shape sees it.
		// `typeshedPaths` is load-bearing on its own; without it nothing resolves,
		// `builtins` included. `reportMissingModuleSource` is silenced because a
		// target is stubs and nothing else, so it would fire on every device import.
		expect(serverSettings('basedpyright.analysis', user)).toEqual({
			typeshedPaths: [SERVER_TYPESHED],
			logLevel: 'information',
			diagnosticSeverityOverrides: { reportMissingModuleSource: 'none' },
		});
	});

	it('points the engine at the target root once a target is seeded', () => {
		// The whole bypass in one value: the engine only ever reads one stdlib
		// root, and this is the choice between the board's and CPython's.
		expect(serverSettings('basedpyright.analysis', { ...user, typeshed: TARGET_TYPESHED_URI })).toMatchObject({
			typeshedPaths: [TARGET_TYPESHED_URI],
		});
	});

	it('passes the user log level through', () => {
		expect(serverSettings('basedpyright.analysis', { ...user, logLevel: 'trace' })).toMatchObject({
			logLevel: 'trace',
		});
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
