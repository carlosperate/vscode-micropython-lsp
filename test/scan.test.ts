import { describe, expect, it } from 'vitest';

import { DIRECTORY, FILE, SYMLINK, scanWorkspace, type DirEntry } from '../client/src/scan';

/** A whole workspace as a literal, keyed on the relative directory path. */
function reader(tree: Record<string, DirEntry[]>) {
	return async (dir: string) => {
		const entries = tree[dir];
		if (!entries) throw new Error(`ENOENT: ${dir}`);
		return entries;
	};
}

describe('scanWorkspace', () => {
	it('collects Python sources from the root', async () => {
		const scan = await scanWorkspace(reader({ '': [['main.py', FILE], ['helper.py', FILE]] }));
		expect(scan.files).toEqual(['helper.py', 'main.py']);
	});

	it('recurses, and returns paths relative to the root', async () => {
		const scan = await scanWorkspace(
			reader({
				'': [['main.py', FILE], ['lib', DIRECTORY]],
				lib: [['util.py', FILE], ['pkg', DIRECTORY]],
				'lib/pkg': [['__init__.py', FILE]],
			})
		);
		expect(scan.files).toEqual(['lib/pkg/__init__.py', 'lib/util.py', 'main.py']);
	});

	it('takes .pyi stubs as sources too', async () => {
		const scan = await scanWorkspace(reader({ '': [['board.pyi', FILE], ['main.py', FILE]] }));
		expect(scan.files).toEqual(['board.pyi', 'main.py']);
	});

	it('leaves everything that is not Python', async () => {
		const tree = {
			'': [
				['main.py', FILE],
				['README.md', FILE],
				['boot_out.txt', FILE],
				['main.py.bak', FILE],
				['pyrightconfig.json', FILE],
				['pyproject.toml', FILE],
				['py.typed', FILE],
			] as DirEntry[],
		};
		expect((await scanWorkspace(reader(tree))).files).toEqual(['main.py']);
	});

	it('does not descend into directories that are never source', async () => {
		const tree = {
			'': [
				['main.py', FILE],
				['.git', DIRECTORY],
				['.venv', DIRECTORY],
				['__pycache__', DIRECTORY],
				['node_modules', DIRECTORY],
			] as DirEntry[],
			// Present so a walk that wrongly descended would return something.
			'.git': [['hooks.py', FILE]] as DirEntry[],
			'.venv': [['site.py', FILE]] as DirEntry[],
			__pycache__: [['main.pyc', FILE]] as DirEntry[],
			node_modules: [['index.py', FILE]] as DirEntry[],
		};
		expect((await scanWorkspace(reader(tree))).files).toEqual(['main.py']);
	});

	it('skips hidden files', async () => {
		const scan = await scanWorkspace(reader({ '': [['.secret.py', FILE], ['main.py', FILE]] }));
		expect(scan.files).toEqual(['main.py']);
	});

	it('follows symlinks, which arrive as a bitmask', async () => {
		const scan = await scanWorkspace(
			reader({
				'': [['main.py', FILE | SYMLINK], ['lib', DIRECTORY | SYMLINK]],
				lib: [['util.py', FILE]],
			})
		);
		expect(scan.files).toEqual(['lib/util.py', 'main.py']);
	});

	it('reports an unreadable directory instead of abandoning the walk', async () => {
		// One folder the user did not grant access to must not cost them the mirror.
		const scan = await scanWorkspace(
			reader({
				'': [['main.py', FILE], ['locked', DIRECTORY], ['lib', DIRECTORY]],
				lib: [['util.py', FILE]],
			})
		);
		expect(scan.files).toEqual(['lib/util.py', 'main.py']);
		expect(scan.unreadable).toEqual(['locked']);
	});

	it('handles an empty workspace', async () => {
		const scan = await scanWorkspace(reader({ '': [] }));
		expect(scan).toEqual({ files: [], unreadable: [] });
	});

	it('reports an unreadable root rather than throwing', async () => {
		const scan = await scanWorkspace(reader({}));
		expect(scan).toEqual({ files: [], unreadable: [''] });
	});
});
