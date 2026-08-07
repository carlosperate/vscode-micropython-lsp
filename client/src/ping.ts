/**
 * The liveness probe's message, and what counts as a reply to it.
 *
 * Kept apart from the client so the rule can be unit-tested. Getting it wrong is
 * silent in both directions: too loose and a dead server keeps looking healthy,
 * too strict and a healthy one restarts every few seconds.
 */

/** Deliberately unimplemented, the error reply *is* the proof of life. */
export const PING_METHOD = '$/micropython-lsp/ping';

/**
 * JSON-RPC 2.0 "Method not found", which `vscode-jsonrpc` answers for any
 * request with no handler. Taken from the spec rather than the engine, so it
 * outlives an engine swap.
 */
const METHOD_NOT_FOUND = -32601;

interface RequestSender {
	sendRequest(method: string, param: unknown): Promise<unknown>;
}

/**
 * Resolves only when the worker itself answered.
 *
 * **A rejection is not an answer.** `vscode-languageclient` rejects a stopped
 * client with a `ResponseError` of its own (`ConnectionInactive`), and the
 * writer and the connection reject without the message ever reaching the
 * worker. Treating those as alive is how a dead server keeps its cover.
 */
export async function ping(client: RequestSender): Promise<void> {
	try {
		await client.sendRequest(PING_METHOD, {});
	} catch (error) {
		if ((error as { code?: unknown } | null)?.code !== METHOD_NOT_FOUND) throw error;
	}
}
