/**
 * What the board picker and the status bar say, as data, with no `vscode` import
 * so the decisions run under vitest. Grouped by flavour rather than by the
 * catalogue's chip `group`: that keeps one alphabetical run of board names, and
 * nothing on a Feather M4 says `atmel-samd`.
 */

import { AUTO_TARGET, type Target } from './target';

/** One row of the picker: a board, or a heading with no board behind it. */
export interface TargetPick {
	readonly label: string;
	readonly description?: string;
	/** The target id to write. Absent on a heading, which cannot be picked. */
	readonly id?: string;
	/** A heading rather than a board. */
	readonly separator?: true;
}

/** What the status bar item shows, and what its hover explains. */
export interface TargetStatus {
	readonly text: string;
	readonly tooltip: string;
}

/** Where the picker writes the setting. `window` scope, so folder scope cannot apply. */
export type WriteScope = 'global' | 'workspace';

/**
 * The picker's rows, in the order `orderTargets` in `assemble.mjs` decided.
 * Headings reuse the flavour prefix in the labels rather than keeping a second
 * copy of the flavour names; a run of one gets none, since it would repeat it.
 */
export function buildTargetPicks(targets: readonly Target[], current?: string): TargetPick[] {
	const picks: TargetPick[] = [];
	let heading: string | undefined;
	targets.forEach((target, index) => {
		const key = splitLabel(target.label).flavour;
		if (key !== heading) {
			heading = key;
			if (runLength(targets, index) > 1) picks.push({ label: key, separator: true });
		}
		picks.push({
			label: target.label,
			// The id and firmware release, which the picker also matches on.
			description: describePick(target, current),
			id: target.id,
		});
	});
	return picks;
}

/**
 * How many targets from `start` share its flavour without interruption. This run
 * rather than the whole list: an order that splits a flavour in two must not head
 * both halves, and a run of one would only repeat itself.
 */
function runLength(targets: readonly Target[], start: number): number {
	const flavour = splitLabel(targets[start].label).flavour;
	let end = start;
	while (end < targets.length && splitLabel(targets[end].label).flavour === flavour) end++;
	return end - start;
}

/**
 * What the status bar says about a target id. The board name alone, since there is
 * no room for the flavour prefix, which the hover keeps along with the id. An id
 * the catalogue lacks is a real state: a project can pin a board a bump dropped.
 */
export function describeTarget(targets: readonly Target[], id: string): TargetStatus {
	const target = targets.find((entry) => entry.id === id);
	if (!target) {
		return {
			text: 'Unknown board',
			tooltip: `"${id}" is not in this version's board list, so no board modules resolve. Click to choose a board.`,
		};
	}

	// The default answers "which board" with "none", so it prompts instead.
	if (target.id === AUTO_TARGET) {
		return {
			// "Python": the status bar is shared, so "board" alone says whose.
			text: 'Select Python board',
			tooltip: 'No board selected, so only the standard library resolves. Click to choose a board.',
		};
	}

	return {
		text: splitLabel(target.label).board,
		tooltip: `Analysing against ${target.label} (${target.id}). Click to choose a different board.`,
	};
}

/**
 * Follow the value in force: writing the user scope under a workspace value
 * changes nothing visible. Otherwise the user scope, so picking a board does not
 * drop a `.vscode/settings.json` into a learner's project.
 */
export function chooseWriteScope(inspected: { workspaceValue?: unknown } | undefined): WriteScope {
	return inspected?.workspaceValue === undefined ? 'global' : 'workspace';
}

/** The catalogue's own description, plus a marker on the row already in force. */
function describePick(target: Target, current?: string): string {
	const meta = target.description ?? target.id;
	return target.id === current ? `${meta} (current)` : meta;
}

/** A label is `<flavour>: <board>`; one with no prefix is already a board name. */
function splitLabel(label: string): { flavour: string; board: string } {
	const colon = label.indexOf(': ');
	if (colon === -1) return { flavour: label, board: label };
	return { flavour: label.slice(0, colon), board: label.slice(colon + 2) };
}
