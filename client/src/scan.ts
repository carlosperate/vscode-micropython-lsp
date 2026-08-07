/**
 * Which files this workspace contributes to the server.
 *
 * Pure, over an injected directory reader, so the filter and the recursion are
 * unit-testable in Node. Paths come back relative to the workspace root and the
 * caller turns them into URIs with `Uri.joinPath`, which is the only encoder
 * that agrees with the URIs VS Code hands out for open editors. Building them
 * here by string concatenation would give the server a second identity for any
 * file whose name needs escaping.
 */

/** `vscode.FileType`, which is a bitmask: a symlinked file arrives as `FILE | SYMLINK`. */
export const FILE = 1;
export const DIRECTORY = 2;
export const SYMLINK = 64;

export type DirEntry = readonly [name: string, type: number];

/** Reads one directory, addressed relative to the workspace root (`''` is the root). */
export type ReadDirectory = (relativePath: string) => Promise<readonly DirEntry[]>;

export interface WorkspaceScan {
	/** Relative POSIX paths, sorted, so a rescan can be diffed against the last one. */
	readonly files: string[];
	/** Directories that could not be read. The caller logs them; the mirror carries on. */
	readonly unreadable: string[];
}

/**
 * `.py` and `.pyi` only.
 *
 * `pyrightconfig.json` and `pyproject.toml` are deliberately not mirrored: we
 * seed our own config at the server root to point the engine at the device
 * typeshed, and a user's file would land on that exact path and silently undo
 * it. `py.typed` marks an *installed* package as typed and does nothing for
 * workspace sources, so it buys nothing today.
 */
const SOURCE = /\.pyi?$/;

/** Big, never source, and `.venv` in particular would drag a whole CPython stdlib in. */
const SKIP_DIRECTORIES = new Set(['__pycache__', 'node_modules', '.venv', '.vscode', '.git', '.hg', '.svn']);

export async function scanWorkspace(readDirectory: ReadDirectory): Promise<WorkspaceScan> {
	const files: string[] = [];
	const unreadable: string[] = [];

	const walk = async (dir: string): Promise<void> => {
		let entries: readonly DirEntry[];
		try {
			entries = await readDirectory(dir);
		} catch {
			unreadable.push(dir);
			return;
		}

		for (const [name, type] of entries) {
			if (name.startsWith('.') || SKIP_DIRECTORIES.has(name)) continue;
			const path = dir ? `${dir}/${name}` : name;
			if (type & DIRECTORY) await walk(path);
			else if (type & FILE && SOURCE.test(name)) files.push(path);
		}
	};

	await walk('');
	return { files: files.sort(), unreadable };
}
