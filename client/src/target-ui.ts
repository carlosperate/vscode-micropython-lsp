/**
 * The board picker, its status bar item and the command behind both. A QuickPick
 * because the Settings dropdown only jumps to the next option whose *first
 * character* matches, and 629 of our 648 labels start with `C`. The setting stays
 * the source of truth: this writes it, reads it back, and rebuilds nothing itself.
 */

import {
	commands,
	ConfigurationTarget,
	Disposable,
	QuickPickItem,
	QuickPickItemKind,
	StatusBarAlignment,
	window,
	workspace,
} from 'vscode';

import { isEnabled, PRODUCT, readTarget, SECTION, settings, TARGET_KEY } from './config';
import { logger } from './log';
import { type Catalogue, loadCatalogue, type ReadStub, type Target } from './target';
import { buildTargetPicks, chooseWriteScope, describeTarget, type TargetStatus } from './target-pick';

/** Contributed in `package.json`, and linked from the setting's own description. */
export const SELECT_TARGET_COMMAND = `${SECTION}.selectTarget`;

/** The right-hand group, high enough not to be pushed out of sight. */
const STATUS_PRIORITY = 100;

export interface TargetUi extends Disposable {
	/** Test seam, not API: what the status bar item says right now. */
	readonly status: TargetStatus & { readonly visible: boolean };
}

/**
 * The item is hidden unless a Python file is in front of the user, and when the
 * extension is off: the board affects nothing else, and a permanent item in every
 * window is clutter a host app cannot remove.
 */
export function createTargetUi(read: ReadStub): TargetUi {
	const item = window.createStatusBarItem(StatusBarAlignment.Right, STATUS_PRIORITY);
	item.command = SELECT_TARGET_COMMAND;
	item.name = `${PRODUCT} Board`;

	let shown: TargetStatus = { text: '', tooltip: '' };
	let visible = false;

	// Read once, since the asset cannot change under us. Failures are not cached.
	let catalogue: Promise<Catalogue> | undefined;
	const targets = async (): Promise<readonly Target[]> => {
		catalogue ??= loadCatalogue(read).catch((error: unknown) => {
			catalogue = undefined;
			throw error;
		});
		return (await catalogue).targets;
	};

	const refresh = async (): Promise<void> => {
		// Nothing honest to show without the list: an id that has not been looked up
		// yet reads exactly like one the catalogue dropped.
		const list = await targets().catch((error: unknown) => {
			logger.warn(`the board list could not be read, so the status bar stays hidden: ${String(error)}`);
			return undefined;
		});
		if (list) {
			shown = describeTarget(list, readTarget());
			item.text = `$(circuit-board) ${shown.text}`;
			item.tooltip = shown.tooltip;
		}

		visible = Boolean(list) && wanted();
		if (visible) item.show();
		else item.hide();
	};

	const subscriptions = [
		item,
		commands.registerCommand(SELECT_TARGET_COMMAND, () => selectTarget(targets)),
		// The target decides the text, `enable` whether to show it at all.
		workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(SECTION)) void refresh();
		}),
		window.onDidChangeActiveTextEditor(() => void refresh()),
		// A language-mode change re-opens the document, and no other event reports
		// it. Also the only retry a failed catalogue read gets.
		workspace.onDidOpenTextDocument(() => void refresh()),
	];

	void refresh();

	const disposable = Disposable.from(...subscriptions);
	return {
		get status() {
			return { ...shown, visible };
		},
		dispose: () => disposable.dispose(),
	};
}

/** A Python file in front of the user, and an extension that is switched on. */
const wanted = () => isEnabled() && window.activeTextEditor?.document.languageId === 'python';

/**
 * `createQuickPick` rather than `showQuickPick` for one reason, `activeItems`:
 * with 648 rows, opening on the board already in force is worth the extra code.
 */
async function selectTarget(targets: () => Promise<readonly Target[]>): Promise<void> {
	let list: readonly Target[];
	try {
		list = await targets();
	} catch (error) {
		logger.error(`the board list could not be read: ${String(error)}`);
		await window.showErrorMessage(
			`${PRODUCT} could not read its board list. The installation may be incomplete.`
		);
		return;
	}

	const current = readTarget();
	const items: BoardItem[] = buildTargetPicks(list, current).map((pick) =>
		pick.separator
			? { label: pick.label, kind: QuickPickItemKind.Separator }
			: { label: pick.label, description: pick.description, id: pick.id }
	);

	const picker = window.createQuickPick<BoardItem>();
	picker.title = 'Select the board to analyse against';
	picker.placeholder = 'Search by board name, or by the id a project commits to its settings';
	// The description holds the id and firmware release, both worth searching.
	picker.matchOnDescription = true;
	picker.items = items;
	picker.activeItems = items.filter((item) => item.id === current);

	let chosen: BoardItem | undefined;
	try {
		chosen = await new Promise<BoardItem | undefined>((resolve) => {
			picker.onDidAccept(() => resolve(picker.selectedItems[0]));
			picker.onDidHide(() => resolve(undefined));
			picker.show();
		});
	} finally {
		// Before the write, so 648 rows are not left over the editor while a slow
		// settings update runs, or until an error notification is dismissed.
		picker.dispose();
	}

	// An unchanged pick is not a write: it would pin the shipped default into the
	// user's settings, where a later change to that default can never reach them.
	if (chosen?.id && chosen.id !== current) await applyTarget(chosen.id);
}

/** A board is chosen by writing the setting, which is what everything else reads. */
async function applyTarget(id: string): Promise<void> {
	const config = settings();
	const scope = chooseWriteScope(config.inspect<string>(TARGET_KEY));
	const target = scope === 'workspace' ? ConfigurationTarget.Workspace : ConfigurationTarget.Global;
	logger.info(`board picker: writing ${SECTION}.${TARGET_KEY} = "${id}" (${scope})`);
	try {
		await config.update(TARGET_KEY, id, target);
	} catch (error) {
		// A read-only workspace can refuse it, and silence reads as a broken picker.
		logger.error(`could not write ${SECTION}.${TARGET_KEY}: ${String(error)}`);
		await window.showErrorMessage(
			`${PRODUCT} could not save the board: ${String(error)}`
		);
	}
}

/** A row that remembers which target it stands for. Separators carry no id. */
interface BoardItem extends QuickPickItem {
	readonly id?: string;
}
