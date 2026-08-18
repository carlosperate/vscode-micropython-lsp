import { Disposable, ExtensionContext, OutputChannel, window, workspace } from 'vscode';

import { mirrorsLogsToConsole, PRODUCT, readLogLevel, SECTION } from './config';
import { DEFAULT_LOG_LEVEL, type Logger, type LogLevel, shouldLog } from './log-level';

/**
 * One channel for all three streams: this extension's own logs, the engine's, and
 * the LSP protocol trace. `logLevel` sizes it, and `mirrorLogsToConsole` also
 * prints it to the developer console, the only place a headless run can read it.
 */

/** The language client's own labels, so one channel reads as one log. */
const LABELS: Record<LogLevel, string> = {
	error: 'Error',
	warning: 'Warn',
	information: 'Info',
	trace: 'Trace',
};

let channel: OutputChannel | undefined;
let listener: Disposable | undefined;
let level: LogLevel = DEFAULT_LOG_LEVEL;
let mirrorToConsole = false;

/** Once, from `activate`, so the channel and its listener go when the extension does. */
export function initLogging(context: ExtensionContext): OutputChannel {
	const target = ensureChannel();
	context.subscriptions.push(
		new Disposable(() => {
			listener?.dispose();
			target.dispose();
			// Cleared, or a reactivation in the same host would log into the
			// channel this just disposed.
			channel = undefined;
			listener = undefined;
		})
	);
	return target;
}

function ensureChannel(): OutputChannel {
	if (!channel) {
		channel = window.createOutputChannel(PRODUCT);
		listener = workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(SECTION)) refresh();
		});
	}
	refresh();
	return channel;
}

function refresh(): void {
	level = readLogLevel();
	mirrorToConsole = mirrorsLogsToConsole();
}

export const logger: Logger = {
	error: (message) => write('error', message),
	warn: (message) => write('warning', message),
	info: (message) => write('information', message),
	trace: (message) => write('trace', message),
};

function write(messageLevel: LogLevel, message: string): void {
	if (!shouldLog(messageLevel, level)) return;
	const line = `[${LABELS[messageLevel].padEnd(5)} - ${new Date().toLocaleTimeString()}] ${message}`;
	channel?.appendLine(line);
	mirror(line);
}

function mirror(line: string): void {
	if (mirrorToConsole) console.log(`[micropython-lsp] ${line}`);
}

/**
 * The channel handed to the language client, so the engine's logs and the LSP
 * trace are mirrored like ours rather than going straight to the real channel.
 *
 * Nothing is filtered here. The engine self-filters against the same
 * `logLevel` we send it, and the trace stream is gated by the trace level
 * derived from it, so a second filter could only drop lines we asked for.
 *
 * `dispose` is inert on purpose: the real channel outlives any one client, and
 * the client only disposes a channel it created itself.
 *
 * Every member of `OutputChannel` is implemented. The cast is for `show` alone,
 * which has a second, deprecated overload taking a `ViewColumn`.
 */
export function clientChannel(): OutputChannel {
	const target = ensureChannel();
	// `append` carries only the first half of a trace record, so it is held back
	// to keep one channel line as one console line.
	let partial = '';
	return {
		name: target.name,
		append: (value: string) => {
			target.append(value);
			partial += value;
		},
		appendLine: (value: string) => {
			target.appendLine(value);
			mirror(partial + value);
			partial = '';
		},
		replace: (value: string) => {
			target.replace(value);
			partial = '';
			mirror(value);
		},
		clear: () => {
			target.clear();
			partial = '';
		},
		// The argument matters: the client reveals the channel with `show(true)`
		// from an error notification, and dropping it would steal focus.
		show: (preserveFocus?: boolean) => target.show(preserveFocus),
		hide: () => target.hide(),
		dispose: () => {},
	} as OutputChannel;
}
