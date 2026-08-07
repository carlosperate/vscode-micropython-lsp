import { OutputChannel, window, workspace } from 'vscode';

/**
 * Everything goes to the "MicroPython LSP" output channel. With
 * `micropython-lsp.debug` on it is mirrored to the console too, which is the
 * only place worker boot and relay activity is visible, and the only thing a
 * headless test run captures.
 */

let channel: OutputChannel | undefined;
let debugEnabled = false;

export function initLogging(): OutputChannel {
	if (!channel) {
		channel = window.createOutputChannel('MicroPython LSP');
		workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('micropython-lsp.debug')) refresh();
		});
	}
	refresh();
	return channel;
}

function refresh(): void {
	debugEnabled = workspace.getConfiguration('micropython-lsp').get<boolean>('debug', false);
}

/** Always logged. For things a user might need to see. */
export function log(message: string): void {
	channel?.appendLine(message);
	if (debugEnabled) console.log(`[micropython-lsp] ${message}`);
}

/** Only when `micropython-lsp.debug` is on. For protocol-level detail. */
export function debug(message: string): void {
	if (!debugEnabled) return;
	channel?.appendLine(message);
	console.log(`[micropython-lsp] ${message}`);
}

/**
 * Trace sink for the language client, sharing the same channel.
 *
 * Each method must delegate to its namesake. `logTrace` writes whole records
 * with `appendLine` and no trailing newline of its own, so routing that to
 * `append` runs the entire trace together into one unreadable line.
 */
export function traceChannel(): OutputChannel {
	const target = initLogging();
	const mirror = (value: string) => {
		if (debugEnabled) console.log(`[lsp] ${value}`);
	};
	return {
		name: 'MicroPython LSP Trace',
		append: (value: string) => {
			target.append(value);
			mirror(value);
		},
		appendLine: (value: string) => {
			target.appendLine(value);
			mirror(value);
		},
		replace: (value: string) => {
			target.replace(value);
			mirror(value);
		},
		clear: () => target.clear(),
		show: () => target.show(),
		hide: () => target.hide(),
		dispose: () => {},
	} as OutputChannel;
}
