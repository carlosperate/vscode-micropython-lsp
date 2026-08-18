import { gunzipSync, gzipSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
	digest,
	extractArchive,
	extractTar,
	extractTarGz,
	extractZip,
	selectTree,
	verifyArchive,
} from '../stubs/archive.mjs';

const BLOCK = 512;

/**
 * A real ustar header, checksum included, so the fixtures below are archives a
 * `tar` would accept rather than something shaped to suit the reader.
 */
function header({ name = '', prefix = '', size = 0, type = '0' }) {
	const block = Buffer.alloc(BLOCK);
	const put = (text, at, len) => block.write(text.slice(0, len), at, 'utf8');
	put(name, 0, 100);
	put('000644 \0', 100, 8);
	put(`${size.toString(8).padStart(11, '0')} `, 124, 12);
	put('00000000000 ', 136, 12);
	block.write('        ', 148, 8); // the checksum field counts as spaces while summing
	block[156] = type.charCodeAt(0);
	put('ustar\0', 257, 6);
	put('00', 263, 2);
	put(prefix, 345, 155);

	const sum = block.reduce((total, byte) => total + byte, 0);
	block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
	return block;
}

const pad = (buffer) => Buffer.concat([buffer, Buffer.alloc((BLOCK - (buffer.length % BLOCK)) % BLOCK)]);

/** @param entries {{name?: string, prefix?: string, type?: string, body?: string}[]} */
function tarGz(entries) {
	const blocks = entries.flatMap(({ body = '', ...entry }) => {
		const content = Buffer.from(body, 'utf8');
		return [header({ ...entry, size: entry.type === '5' ? 0 : content.length }), pad(content)];
	});
	// Two zero blocks end an archive, and real tars pad well past them.
	return gzipSync(Buffer.concat([...blocks, Buffer.alloc(BLOCK * 6)]));
}

const text = (files, path) => files.get(path)?.toString('utf8');

describe('extractTarGz', () => {
	it('reads regular files with their content', () => {
		const files = extractTarGz(tarGz([
			{ name: 'pkg/VERSIONS', body: 'sys: 3.0-\n' },
			{ name: 'pkg/sys.pyi', body: 'platform: str\n' },
		]));
		expect([...files.keys()]).toEqual(['pkg/VERSIONS', 'pkg/sys.pyi']);
		expect(text(files, 'pkg/sys.pyi')).toBe('platform: str\n');
	});

	it('skips directories and the pax global header', () => {
		// GitHub's tarballs open with one `pax_global_header`, and every directory
		// gets its own entry. Neither is a file and both would pollute the tree.
		const files = extractTarGz(tarGz([
			{ name: 'pax_global_header', type: 'g', body: '52 comment=0000\n' },
			{ name: 'pkg/', type: '5' },
			{ name: 'pkg/sys.pyi', body: 'x' },
		]));
		expect([...files.keys()]).toEqual(['pkg/sys.pyi']);
	});

	it('takes a long path from the pax header that precedes an entry', () => {
		// The other way a path over 100 characters travels, and the one Python's
		// `tarfile` writes: the entry's own name field is truncated, so reading it
		// turns `__init__.pyi` into `__init__.py`. Two of CircuitPython's 628 board
		// definitions arrive this way.
		const long = `pkg/${'d'.repeat(96)}/__init__.pyi`;
		const files = extractTarGz(tarGz([
			{ name: 'pax', type: 'x', body: `${long.length + 12} path=${long}\n22 mtime=1778623324.0\n` },
			{ name: long.slice(0, 100), body: 'GP0: Pin\n' },
			{ name: 'pkg/sys.pyi', body: 'x' },
		]));
		expect([...files.keys()]).toEqual([long, 'pkg/sys.pyi']);
		expect(text(files, long)).toBe('GP0: Pin\n');
	});

	it('takes a long path from a GNU long-name entry too', () => {
		// `tar czf` still defaults to GNU rather than pax, so a future source could
		// arrive this way and truncate in exactly the same silent fashion.
		const long = `pkg/${'d'.repeat(96)}/__init__.pyi`;
		const files = extractTarGz(tarGz([
			{ name: '././@LongLink', type: 'L', body: `${long}\0` },
			{ name: long.slice(0, 100), body: 'GP0: Pin\n' },
		]));
		expect([...files.keys()]).toEqual([long]);
	});

	it('joins the ustar prefix onto the name', () => {
		// How a path over 100 characters is carried, and the reason a plain read of
		// the name field silently loses files from a deep tree.
		const files = extractTarGz(tarGz([{ prefix: 'pkg/lang/en/typeshed', name: 'stdlib/microbit/__init__.pyi', body: 'x' }]));
		expect([...files.keys()]).toEqual(['pkg/lang/en/typeshed/stdlib/microbit/__init__.pyi']);
	});

	it('reads content that does not fill its last block', () => {
		const body = 'a'.repeat(BLOCK + 7);
		const files = extractTarGz(tarGz([{ name: 'a.pyi', body }, { name: 'b.pyi', body: 'second' }]));
		expect(text(files, 'a.pyi')).toBe(body);
		expect(text(files, 'b.pyi')).toBe('second');
	});

	it('treats a NUL typeflag as a regular file', () => {
		// Older writers leave it unset rather than writing '0'.
		const files = extractTarGz(tarGz([{ name: 'a.pyi', type: '\0', body: 'x' }]));
		expect(text(files, 'a.pyi')).toBe('x');
	});

	it('refuses a size field it cannot read', () => {
		// The quiet failure this prevents: a non-octal size parses to NaN, every
		// offset after it is NaN, the loop condition goes false, and extraction
		// ends early returning a truncated tree with no error anywhere.
		const tar = gunzipSync(tarGz([{ name: 'a.pyi', body: 'x' }]));
		tar.write('garbage     ', 124, 12);
		expect(() => extractTar(tar)).toThrow(/a\.pyi.*size/);
	});

	it('refuses an entry running past the end of the archive', () => {
		const tar = gunzipSync(tarGz([{ name: 'a.pyi', body: 'x' }]));
		tar.write(`${(999999).toString(8).padStart(11, '0')} `, 124, 12);
		expect(() => extractTar(tar)).toThrow(/past the end/);
	});

	// Contract, pinned so a second caller cannot assume otherwise: the reader
	// reports what the archive says. Refusing a path that escapes the tree is
	// `selectTree`'s job, because it is the step that decides where files land.
	it('reports archive paths verbatim, leaving the tar-slip guard to selectTree', () => {
		const files = extractTarGz(tarGz([{ name: '../escape.pyi', body: 'x' }]));
		expect([...files.keys()]).toEqual(['../escape.pyi']);
		expect(() => selectTree(files)).toThrow(/escape/i);
	});
});

describe('extractZip', () => {
	it('reads entries with their content, directories dropped', () => {
		// The wheels carry both compression methods, deflate for stubs and stored
		// for anything deflate cannot shrink, so the fixture uses both.
		const files = extractZip(Buffer.from(zipSync({
			'stdlib/VERSIONS': strToU8('sys: 3.0-\n'),
			'machine.pyi': [strToU8('x'), { level: 0 }],
			'rp2/': strToU8(''),
		})));
		expect([...files.keys()].sort()).toEqual(['machine.pyi', 'stdlib/VERSIONS']);
		expect(text(files, 'stdlib/VERSIONS')).toBe('sys: 3.0-\n');
	});

	it('refuses something that is not a zip at all', () => {
		expect(() => extractZip(Buffer.from('not an archive'))).toThrow();
	});
});

describe('extractArchive', () => {
	it('reads the format a source declares', () => {
		expect([...extractArchive(tarGz([{ name: 'a.pyi', body: 'x' }]), 'tar.gz').keys()]).toEqual(['a.pyi']);
		expect([...extractArchive(Buffer.from(zipSync({ 'a.pyi': strToU8('x') })), 'zip').keys()]).toEqual(['a.pyi']);
	});

	it('takes a source that is one file as a one-entry tree', () => {
		// A licence pinned on its own, because the package it belongs to ships no
		// copy of it. Everything downstream reads a tree, so this stays a tree.
		const licence = extractArchive(Buffer.from('The MIT License (MIT)\n'), 'raw', 'LICENSE');
		expect([...licence.keys()]).toEqual(['LICENSE']);
		expect(text(licence, 'LICENSE')).toBe('The MIT License (MIT)\n');
	});

	it('refuses a raw source with nowhere to file it', () => {
		// The name comes from the URL's last segment, so an empty one means the pin
		// points at a directory. Left unchecked it becomes a file with no name.
		expect(() => extractArchive(Buffer.from('x'), 'raw')).toThrow(/name/);
	});

	it('refuses a format it does not know rather than guessing', () => {
		// Dispatching on a declared format, so a config naming something we cannot
		// read has to fail here rather than hand a stream to the wrong reader.
		expect(() => extractArchive(Buffer.alloc(0), '7z')).toThrow(/7z/);
	});
});

describe('selectTree', () => {
	const files = new Map([
		['repo-1.0/lang/en/typeshed/stdlib/VERSIONS', Buffer.from('v')],
		['repo-1.0/lang/en/typeshed/stdlib/microbit/__init__.pyi', Buffer.from('m')],
		['repo-1.0/lang/fr/typeshed/stdlib/VERSIONS', Buffer.from('fr')],
		['repo-1.0/README.md', Buffer.from('r')],
	]);

	it('drops the archive root and everything outside the wanted subtree', () => {
		// Pinning the selection rather than the whole download is deliberate: an
		// upstream change to another locale or to CI must not churn the checksum.
		const selected = selectTree(files, { strip: 1, include: ['lang/en/typeshed/'] });
		expect([...selected.keys()].sort()).toEqual([
			'lang/en/typeshed/stdlib/VERSIONS',
			'lang/en/typeshed/stdlib/microbit/__init__.pyi',
		]);
		expect(selected.get('lang/en/typeshed/stdlib/VERSIONS')?.toString()).toBe('v');
	});

	it('keeps a licence beside the stubs', () => {
		// It is the upstream text that gets redistributed, so it is fetched rather
		// than summarised into something that can quietly go stale.
		const selected = selectTree(files, { strip: 1, include: ['lang/en/typeshed/', 'README.md'] });
		expect([...selected.keys()]).toContain('README.md');
		expect([...selected.keys()]).not.toContain('lang/fr/typeshed/stdlib/VERSIONS');
	});

	it('takes everything under the root when no subtree is named', () => {
		expect([...selectTree(files, { strip: 1 }).keys()]).toContain('README.md');
	});

	it('refuses a path that escapes the tree', () => {
		// Tar slip: these paths are written to disk, so a crafted archive must not
		// be able to name one outside the cache.
		const evil = new Map([['repo-1.0/../../../etc/passwd', Buffer.from('x')]]);
		expect(() => selectTree(evil, { strip: 1 })).toThrow(/escape/i);
		expect(() => selectTree(new Map([['/etc/passwd', Buffer.from('x')]]), { strip: 0 })).toThrow(/escape/i);
	});

	it('fails on any prefix that matches nothing', () => {
		// A path moved upstream would otherwise assemble a layer with a hole in
		// it, and a typeshed root missing files resolves nothing while looking
		// like a working build. Each prefix is checked, not just the set.
		expect(() => selectTree(files, { strip: 1, include: ['lang/es/typeshed/'] })).toThrow(/lang\/es\/typeshed\//);
		expect(() => selectTree(files, { strip: 1, include: ['lang/en/typeshed/', 'NOTICE'] })).toThrow(/"NOTICE"/);
	});
});

describe('digest', () => {
	it('is the plain sha256 of the bytes, reproducible with any other tool', () => {
		// Not a scheme of our own: `sha256sum` on the downloaded file has to agree,
		// which is what makes a pin checkable by hand.
		expect(digest(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});

	it('changes with the content', () => {
		expect(digest(Buffer.from('a'))).not.toBe(digest(Buffer.from('b')));
	});
});

describe('verifyArchive', () => {
	const archive = Buffer.from('a tarball');

	it('accepts an archive matching its pin', () => {
		expect(() => verifyArchive('microbit', archive, digest(archive))).not.toThrow();
	});

	it('names the source and both checksums when it does not', () => {
		// The message is the whole value of this check: it has to say what to look
		// at, since the fix is either a deliberate re-pin or a bad download.
		expect(() => verifyArchive('microbit', archive, 'deadbeef')).toThrow(/microbit/);
		expect(() => verifyArchive('microbit', archive, 'deadbeef')).toThrow(new RegExp(digest(archive)));
	});
});
