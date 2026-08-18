/**
 * Reading member names out of the two things upstream publishes: reference
 * documentation, and stubs.
 *
 * CircuitPython inherits part of its standard library from MicroPython and
 * generates stubs for none of it, so we ship MicroPython's. Both firmwares run
 * the same C and document it separately, and that documentation is the only
 * place the difference is written down. This turns it into a list, for the
 * report in `check.mjs`.
 *
 * **Both are approximations, and the report says so.** Neither format is really
 * being parsed: enough to say which names a reader would find, not enough to
 * fail a build over, which is why nothing here decides an exit code.
 */

/**
 * Names a `docs/library/<module>.rst` documents for the module itself.
 *
 * `.. function:: foo()` and the qualified `.. function:: sys.exit()` both
 * appear, so the module prefix comes off. What is left containing a dot is a
 * member of a class in that module rather than of the module, and is dropped:
 * both projects document `Pattern.match` under `re`, and it is not `re.match`.
 *
 * `method` and `attribute` are deliberately not read for the same reason. Nor is
 * `admonition`, which carries prose.
 *
 * @param {string} text the `.rst` source
 * @param {string} module the module it documents
 * @returns {Set<string>}
 */
export function rstMembers(text, module) {
	const names = new Set();
	const directive = /^\s*\.\.\s+(?:py:)?(?:function|class|data|exception|decorator)::\s*([A-Za-z_][\w.]*)/gm;
	for (let match = directive.exec(text); match; match = directive.exec(text)) {
		const name = match[1].startsWith(`${module}.`) ? match[1].slice(module.length + 1) : match[1];
		if (!name.includes('.')) names.add(name);
	}
	return names;
}

/** Keywords that open a block and are not declarations. */
const KEYWORDS = new Set(['if', 'else', 'elif', 'try', 'except', 'finally', 'while', 'for', 'with', 'return']);

/**
 * Top-level names a stub declares: what a reader gets from `module.`.
 *
 * Three things make this more than one regex, each found by a name the report
 * got wrong.
 *
 * **Indentation does not mean nesting.** Typeshed guards declarations behind `if
 * sys.version_info >= …`, so `eval`, `exec` and `Ellipsis` are indented while
 * being module members in every branch.
 *
 * **A class body is nesting**, so `class` opens a region skipped until the
 * indentation comes back out.
 *
 * **A signature spans lines**, so anything inside brackets is skipped; without
 * it `def eval(\n source: str` contributes `source`.
 *
 * Docstrings come off first, being full of lines like `Module: 'select' on …`
 * that read exactly like an annotated assignment.
 *
 * @param {string} text the `.pyi` source
 * @returns {Set<string>}
 */
export function stubMembers(text) {
	const code = stripDocstrings(text);
	const names = reexported(code);
	let classAt = null;
	let depth = 0;

	for (const raw of code.split('\n')) {
		const line = raw.replace(/#.*$/, '');
		const trimmed = line.trim();
		if (!trimmed) continue;

		const indent = line.length - line.trimStart().length;
		if (classAt !== null && indent <= classAt) classAt = null;

		if (depth === 0) {
			const declared = /^class\s+([A-Za-z_]\w*)/.exec(trimmed);
			const name = declared?.[1] ??
				/^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(trimmed)?.[1] ??
				// `DEBUG: int`, `DEBUG = 1` and `DEBUG: int = 1` alike: a constant is a
				// member however it was written, and `re` writes its flags as plain
				// assignments while `select` annotates its own.
				/^([A-Za-z_]\w*)\s*(?::\s*\S|=\s*\S)/.exec(trimmed)?.[1];
			if (name && classAt === null && !KEYWORDS.has(name)) names.add(name);
			if (declared && classAt === null) classAt = indent;
		}
		depth += (trimmed.match(/[([{]/g) ?? []).length - (trimmed.match(/[)\]}]/g) ?? []).length;
	}
	return names;
}

/** Prose, which reads like code often enough to matter. */
const stripDocstrings = (text) => text.replace(/(['"])\1\1[\s\S]*?\1\1\1/g, '');

/**
 * Names a stub re-exports, which are its members as much as what it declares.
 *
 * `io.pyi` is barely more than `from _io import (FileIO as FileIO, …)`, so a
 * reader of `io.` sees names that appear nowhere as a declaration. In a stub the
 * doubled `X as X` is what marks a re-export as public, which is exactly the
 * form to look for: a bare `from x import y` is private and would be wrong to
 * count.
 */
function reexported(code) {
	const names = new Set();
	const statement = /^from\s+[\w.]+\s+import\s+(?:\(([\s\S]*?)\)|(.+))$/gm;
	for (let match = statement.exec(code); match; match = statement.exec(code)) {
		for (const clause of (match[1] ?? match[2]).split(',')) {
			const alias = /^\s*([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)\s*$/.exec(clause);
			if (alias) names.add(alias[2]);
		}
	}
	return names;
}

/**
 * What a user of one borrowed module would notice, in both directions.
 *
 * `missing` is the half worth listing: documented upstream, absent from the stub
 * we ship, so correct code gets a red line under it.
 *
 * `extra` is counted rather than listed. The borrowed stubs are typeshed-derived
 * and describe CPython's shape, so they carry dozens of names no firmware
 * documents (`builtins` alone about forty), which is a property of the strategy
 * rather than a change upstream. Listing them buries the ones that mean
 * something. Private names are left out entirely.
 *
 * @param {Set<string>} documented what the firmware's own docs declare
 * @param {Set<string>} shipped what our stub declares
 */
export function compareMembers(documented, shipped) {
	const missing = [...documented].filter((name) => !shipped.has(name)).sort();
	const extra = [...shipped].filter((name) => !documented.has(name) && !name.startsWith('_'));
	return { missing, extra: extra.length };
}
