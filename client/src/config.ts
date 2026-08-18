/**
 * The ids and names VS Code knows us by, and the reads of our own settings, in
 * one place: each of these is also written in `package.json`, and a second copy
 * in the code is a copy that drifts.
 */

import { workspace, WorkspaceConfiguration } from 'vscode';

import { type LogLevel, resolveLogLevel } from './log-level';
import { AUTO_TARGET } from './target';

/** What a user sees us called. Never "MicroPython" alone: most boards are CircuitPython. */
export const PRODUCT = 'MicroPython & CircuitPython IntelliSense';

export const SECTION = 'micropython-lsp';
export const TARGET_KEY = 'target';

/** Full ids, for the `affectsConfiguration` checks that decide what to rebuild. */
export const ENABLE_SECTION = `${SECTION}.enable`;
export const TARGET_SECTION = `${SECTION}.${TARGET_KEY}`;

/** Ours alone. Nothing here ever reads `python.*` or `basedpyright.*`. */
export const settings = (): WorkspaceConfiguration => workspace.getConfiguration(SECTION);

export const isEnabled = (): boolean => settings().get<boolean>('enable', true);

/**
 * An unset or emptied value is the default, not a missing target: `get` answers
 * `''` for a setting a user cleared rather than removed.
 */
export const readTarget = (): string => settings().get<string>(TARGET_KEY) || AUTO_TARGET;

/** Normalised, so the engine is sent the level our own messages are filtered by. */
export const readLogLevel = (): LogLevel => resolveLogLevel(settings().get<string>('logLevel'));

export const mirrorsLogsToConsole = (): boolean => settings().get<boolean>('mirrorLogsToConsole', false);
