/**
 * The one verbosity scale, shared by this extension and the engine it bundles.
 *
 * The names are the engine's own, because `micropython-lsp.logLevel` is sent to
 * it verbatim (see `settings.ts`) as well as applied here. Keeping one scale is
 * the whole point: a user raising the level sees more from both sides at once.
 *
 * Free of `vscode` and of the language client, so the modules that take a logger
 * stay testable in Node.
 */

export type LogLevel = 'error' | 'warning' | 'information' | 'trace';

/** Ascending verbosity. Reordering this changes what the default level shows. */
const LEVELS: readonly LogLevel[] = ['error', 'warning', 'information', 'trace'];

export const DEFAULT_LOG_LEVEL: LogLevel = 'information';

/** `warn`/`info` are the conventional method names for the `warning`/`information` levels. */
export interface Logger {
	error(message: string): void;
	warn(message: string): void;
	info(message: string): void;
	trace(message: string): void;
}

/** For the seams that take a logger but are given none. */
export const SILENT_LOGGER: Logger = {
	error: () => {},
	warn: () => {},
	info: () => {},
	trace: () => {},
};

export function shouldLog(message: LogLevel, configured: LogLevel): boolean {
	return LEVELS.indexOf(message) <= LEVELS.indexOf(configured);
}

/**
 * The one place a configured value becomes a level.
 *
 * Both readers go through it, so the level applied to our own messages and the
 * one sent to the engine can never disagree, and the engine is never handed a
 * name it does not recognise. An unreadable setting must not mean silence:
 * errors are what explain it.
 */
export function resolveLogLevel(configured: string | undefined): LogLevel {
	return LEVELS.includes(configured as LogLevel) ? (configured as LogLevel) : DEFAULT_LOG_LEVEL;
}

/**
 * The LSP protocol trace level to run at.
 *
 * `messages` rather than `verbose`: the mirror pushes whole file contents through
 * `didOpen`, so bodies would bury the import resolution that `trace` is usually
 * turned on for.
 */
export function traceValueFor(level: LogLevel): 'off' | 'messages' {
	return level === 'trace' ? 'messages' : 'off';
}
