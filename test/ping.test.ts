import { describe, expect, it } from 'vitest';

import { ping } from '../client/src/ping';

/** Both the server's response errors and the client's local ones look like this. */
const failure = (code: number) => Object.assign(new Error('rejected'), { code });

const sender = (reject: unknown) => ({ sendRequest: () => Promise.reject(reject) });

describe('ping', () => {
	it('accepts MethodNotFound, the only reply an unimplemented method can get', async () => {
		await expect(ping(sender(failure(-32601)))).resolves.toBeUndefined();
	});

	it('accepts a successful reply, should an engine ever implement it', async () => {
		await expect(ping({ sendRequest: () => Promise.resolve(null) })).resolves.toBeUndefined();
	});

	it('rejects ConnectionInactive, which the client raises without asking the server', async () => {
		// The trap: vscode-languageclient answers a stopped client with a
		// ResponseError too, so "it threw a ResponseError" proves nothing.
		await expect(ping(sender(failure(-32801)))).rejects.toThrow();
	});

	it('rejects a transport failure that never reached the worker', async () => {
		await expect(ping(sender(new Error('write failed')))).rejects.toThrow();
	});

	it('rejects a thrown non-object', async () => {
		await expect(ping(sender('boom'))).rejects.toBeTruthy();
	});
});
