import { describe, expect, it } from 'vitest';

import { compareMembers, rstMembers, stubMembers } from '../stubs/members.mjs';

/**
 * Every case in `stubMembers` below is a name the report got wrong before the
 * parser handled it, and each was wrong in the same direction: claiming a stub
 * lacks something it has, which reads as a defect in what we ship. A report
 * nobody can trust is worse than no report, so they are pinned here.
 */
describe('stubMembers', () => {
	it('reads plain declarations', () => {
		expect([...stubMembers('def poll() -> Poll: ...\nclass Poll: ...\nPOLLIN: Final[int]\n')].sort()).toEqual([
			'POLLIN',
			'Poll',
			'poll',
		]);
	});

	it('reads a declaration guarded by a version check', () => {
		// Typeshed writes `builtins` this way, so column-zero matching reported
		// `eval`, `exec` and `Ellipsis` as missing from the standard library.
		const stub = 'if sys.version_info >= (3, 13):\n    def exec(source: str, /) -> None: ...\nelse:\n    def exec(source: str) -> None: ...\n';
		expect([...stubMembers(stub)]).toEqual(['exec']);
	});

	it('leaves class members out', () => {
		// A method belongs to the class, not the module, and `poll.register` is not
		// something `select.` offers.
		expect([...stubMembers('class Poll:\n    def register(self) -> None: ...\n    flags: int\n')]).toEqual(['Poll']);
	});

	it('does not mistake a parameter for a member', () => {
		// A signature broken across lines indents its parameters exactly like a
		// conditional indents a declaration.
		expect([...stubMembers('def eval(\n    source: str,\n    globals: dict | None = None,\n) -> Any: ...\n')]).toEqual([
			'eval',
		]);
	});

	it('reads a constant however it is written', () => {
		// `re` assigns its flags and `select` annotates its own.
		expect([...stubMembers('DEBUG = sre_compile.SRE_FLAG_DEBUG\nA: int = 2\nI: int\n')].sort()).toEqual([
			'A',
			'DEBUG',
			'I',
		]);
	});

	it('reads a re-export, which is a member with no declaration', () => {
		// `io.pyi` is barely more than this, so missing it reported `FileIO` and
		// `TextIOWrapper` as absent from a module that is mostly them. The doubled
		// `X as X` is what makes a re-export public in a stub; a bare import is
		// private and stays out.
		const stub = 'from _io import (\n    FileIO as FileIO,\n    TextIOWrapper as TextIOWrapper,\n)\nfrom _io import BytesIO\n';
		expect([...stubMembers(stub)].sort()).toEqual(['FileIO', 'TextIOWrapper']);
	});

	it('ignores prose that reads like code', () => {
		// These stubs open with a docstring carrying lines like `Module: 'select' on
		// micropython-v1.28.0`, which is an annotated assignment as far as a regex
		// is concerned.
		expect([...stubMembers('"""\nModule: \'select\' on micropython-v1.28.0\nNote: nothing here is code\n"""\ndef poll() -> None: ...\n')]).toEqual([
			'poll',
		]);
	});
});

describe('rstMembers', () => {
	const doc = [
		'.. module:: select',
		'.. function:: poll()',
		'.. function:: select(rlist, wlist, xlist[, timeout])',
		'.. method:: poll.register(obj)',
		'.. data:: select.SOMETHING',
		'.. admonition:: Difference to CPython',
	].join('\n');

	it('reads what a module documents, qualified or not', () => {
		// Both projects write both forms, and `.. data:: sys.argv` means `argv`.
		expect([...rstMembers(doc, 'select')].sort()).toEqual(['SOMETHING', 'poll', 'select']);
	});

	it('leaves out members of a class and prose directives', () => {
		// `poll.register` is a method on `poll`, not something the module offers,
		// and an admonition is a paragraph.
		expect([...rstMembers(doc, 'select')]).not.toContain('register');
		expect([...rstMembers(doc, 'select')]).not.toContain('Difference');
	});
});

describe('compareMembers', () => {
	it('lists what the docs promise and the stub lacks', () => {
		// The half worth acting on: correct code with a red line under it.
		const { missing } = compareMembers(new Set(['processor', 'system']), new Set(['system']));
		expect(missing).toEqual(['processor']);
	});

	it('counts the other direction rather than listing it', () => {
		// The borrowed stubs are typeshed-derived and describe CPython's shape, so
		// they carry dozens of names no embedded firmware documents. Listing those
		// buries the handful that mean something.
		const { extra } = compareMembers(new Set(['system']), new Set(['system', 'node', 'release', '_private']));
		expect(extra).toBe(2);
	});
});
