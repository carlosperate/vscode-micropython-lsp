import { describe, expect, it } from 'vitest';

import {
	DEFAULT_LOG_LEVEL,
	type LogLevel,
	resolveLogLevel,
	shouldLog,
	SILENT_LOGGER,
	traceValueFor,
} from '../client/src/log-level';

const ALL: LogLevel[] = ['error', 'warning', 'information', 'trace'];

// One setting sizes both sides, so these names are the engine's own and their
// order is what a user sees at the default level.
describe('shouldLog', () => {
	it('passes a message at the configured level', () => {
		expect(shouldLog('information', 'information')).toBe(true);
	});

	it('passes anything more severe than the configured level', () => {
		expect(shouldLog('error', 'warning')).toBe(true);
		expect(shouldLog('warning', 'information')).toBe(true);
	});

	it('drops anything less severe than the configured level', () => {
		expect(shouldLog('trace', 'information')).toBe(false);
		expect(shouldLog('information', 'error')).toBe(false);
	});

	it('lets errors through at every level', () => {
		for (const configured of ALL) expect(shouldLog('error', configured)).toBe(true);
	});

	it('lets everything through at trace', () => {
		for (const level of ALL) expect(shouldLog(level, 'trace')).toBe(true);
	});
});

// The single normalisation point. It matters that there is only one: the same
// value is applied to our own messages and sent to the engine, and if the two
// disagreed about what an unrecognised value means they would log different
// amounts from one setting.
describe('resolveLogLevel', () => {
	it('keeps every level it knows', () => {
		for (const level of ALL) expect(resolveLogLevel(level)).toBe(level);
	});

	// A hand-edited settings.json can hold anything. Silence would be the worst
	// answer: it hides the errors that explain why nothing works.
	it('falls back to the default for anything else', () => {
		expect(resolveLogLevel('verbose')).toBe(DEFAULT_LOG_LEVEL);
		expect(resolveLogLevel('')).toBe(DEFAULT_LOG_LEVEL);
		expect(resolveLogLevel(undefined)).toBe(DEFAULT_LOG_LEVEL);
	});

	it('is case sensitive, so the engine never receives a name it rejects', () => {
		expect(resolveLogLevel('Trace')).toBe(DEFAULT_LOG_LEVEL);
	});
});

// The language client owns `trace.server` and re-reads it on every configuration
// change, so the level has to be derived rather than contributed.
describe('traceValueFor', () => {
	it('traces LSP messages only at the trace level', () => {
		expect(traceValueFor('trace')).toBe('messages');
	});

	it('stays off at every other level', () => {
		for (const level of ALL.filter((l) => l !== 'trace')) expect(traceValueFor(level)).toBe('off');
	});

	// `Trace.fromString` silently answers `off` for anything it does not know,
	// which would disagree with the level the rest of the extension is using.
	it('answers a value the language client understands', () => {
		for (const level of ALL) expect(['off', 'messages']).toContain(traceValueFor(level));
	});
});

describe('SILENT_LOGGER', () => {
	it('accepts every level and does nothing', () => {
		expect(() => {
			SILENT_LOGGER.error('e');
			SILENT_LOGGER.warn('w');
			SILENT_LOGGER.info('i');
			SILENT_LOGGER.trace('t');
		}).not.toThrow();
	});
});
