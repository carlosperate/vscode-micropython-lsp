/**
 * Turning a downloaded `.tar.gz` into a verified tree of files, in memory.
 *
 * Hand-rolled rather than shelled out or taken from a package: `tar` is not a
 * command every developer's platform spells the same way, and the format we
 * actually meet is the narrow one GitHub and PyPI emit. Everything here is pure
 * over buffers, so the whole acquisition path is unit-testable without a
 * network or a temporary directory.
 *
 * Corruption is already caught upstream of this file: `gunzipSync` validates
 * gzip's own CRC32 and throws, which is why the per-header tar checksum is read
 * past rather than verified.
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

/** Typeflags that carry file content. A NUL is what older writers leave for a plain file. */
const FILE_TYPES = new Set(['0', '\0']);

/**
 * Read whichever archive format a source ships as.
 *
 * Dispatching on a declared format rather than sniffing the URL, because a
 * source's URL need not end in its extension: GitHub's is
 * `.../tar.gz/refs/tags/v0.4.0`. An unknown format throws rather than being
 * guessed at, so adding zip for the MicroPython wheels is a change here and
 * nowhere else.
 *
 * @param {Buffer} buffer
 * @param {string} format
 * @returns {Map<string, Buffer>}
 */
export function extractArchive(buffer, format) {
	if (format === 'tar.gz') return extractTarGz(buffer);
	throw new Error(`unsupported archive format "${format}"`);
}

/**
 * Every regular file in the archive, keyed on its full path.
 *
 * Directories, and the `pax_global_header` that opens every GitHub tarball, are
 * dropped: only bytes we intend to write matter here.
 *
 * @param {Buffer} gzipped
 * @returns {Map<string, Buffer>}
 */
export function extractTarGz(gzipped) {
	return extractTar(gunzipSync(gzipped));
}

/**
 * @param {Buffer} tar
 * @returns {Map<string, Buffer>}
 */
export function extractTar(tar) {
	const files = new Map();

	for (let offset = 0; offset + BLOCK <= tar.length; ) {
		const head = tar.subarray(offset, offset + BLOCK);
		// Two zero blocks end an archive, and writers pad well beyond them.
		if (head.every((byte) => byte === 0)) break;

		const name = field(head, 0, 100);
		// A path over 100 characters is split across two fields, so reading the
		// name alone silently loses files from any deep tree.
		const prefix = field(head, 345, 155);
		const path = prefix ? `${prefix}/${name}` : name;
		const type = String.fromCharCode(head[156]);

		// Validated rather than trusted: a non-octal size parses to NaN, every
		// arithmetic result downstream is NaN, the loop condition goes false, and
		// extraction ends early returning whatever it had. That is a truncated
		// tree with no error anywhere, which is the worst shape this can fail in.
		const raw = field(head, 124, 12).trim();
		const size = raw === '' ? 0 : Number.parseInt(raw, 8);
		if (!Number.isSafeInteger(size) || size < 0) {
			throw new Error(`tar entry "${path}" has an unreadable size field "${raw}"`);
		}
		offset += BLOCK;
		if (offset + size > tar.length) {
			throw new Error(`tar entry "${path}" runs past the end of the archive`);
		}

		if (FILE_TYPES.has(type)) files.set(path, tar.subarray(offset, offset + size));
		offset += Math.ceil(size / BLOCK) * BLOCK;
	}

	return files;
}

/**
 * Narrow a tree to the parts worth keeping, addressed from the archive root.
 *
 * `strip` drops leading path components, which is how the version-stamped
 * directory a source archive wraps everything in goes away. `include` then
 * keeps anything under any of its prefixes, paths otherwise untouched, so the
 * cache mirrors upstream and can be read against it.
 *
 * More than one prefix because a source is not only its stubs: a licence file at
 * the repository root has to travel with them, and it is the upstream text that
 * gets redistributed rather than a summary of it that can go stale.
 *
 * Pinning the selection rather than the whole download is deliberate: an
 * upstream change to a locale or a CI file we never read must not invalidate the
 * pin. Each prefix must match something, so a path that moves upstream fails
 * here rather than assembling a layer with a hole in it.
 *
 * @param {Map<string, Buffer>} files
 * @param {{strip?: number, include?: string[]}} options
 * @returns {Map<string, Buffer>}
 */
export function selectTree(files, { strip = 0, include = [] } = {}) {
	const prefixes = include.length ? include : [''];
	const matched = new Set();
	const selected = new Map();

	for (const [path, content] of files) {
		// Tar slip. These paths are written to disk, so an archive must not be
		// able to name a file outside the directory we chose for it.
		if (path.startsWith('/') || path.split('/').includes('..')) {
			throw new Error(`refusing an archive path that escapes the tree: "${path}"`);
		}
		const stripped = path.split('/').slice(strip).join('/');
		const prefix = prefixes.find((candidate) => stripped.startsWith(candidate));
		if (prefix === undefined) continue;
		matched.add(prefix);
		selected.set(stripped, content);
	}

	const missing = prefixes.filter((prefix) => !matched.has(prefix));
	if (missing.length) {
		throw new Error(
			`nothing under ${missing.map((prefix) => `"${prefix}"`).join(', ')} after stripping ${strip} path component(s)`
		);
	}
	return selected;
}

/**
 * The pin: a plain checksum of the archive as downloaded.
 *
 * Not a digest of the unpacked content, which was tried and was not worth what
 * it cost to explain. Hashing the bytes means a cache hit is one file read and
 * one hash, with no unpacking at all, and it is the checksum anyone can
 * reproduce against the same URL with any tool they like.
 *
 * The trade is that GitHub does not guarantee its auto-generated archives are
 * byte-stable: regenerating them in early 2023 broke Homebrew, Go and Bazel,
 * and the revert came with no promise. That has happened once, and re-pinning
 * by hand when it does is cheaper than the machinery for avoiding it.
 *
 * @param {Buffer} buffer
 * @returns {string} hex sha256
 */
export function digest(buffer) {
	return createHash('sha256').update(buffer).digest('hex');
}

/**
 * @param {string} id source name, for the message
 * @param {Buffer} buffer the archive as downloaded
 * @param {string} expected hex sha256 from the committed pin
 */
export function verifyArchive(id, buffer, expected) {
	const actual = digest(buffer);
	if (actual === expected) return;
	throw new Error(
		`stub source "${id}" does not match its pin.\n` +
			`  expected ${expected}\n  actual   ${actual}\n` +
			'Either the upstream archive was regenerated, in which case re-pin deliberately after ' +
			'checking the content, or the download is not what it claims.'
	);
}

/** Trailing NULs pad every fixed-width tar field. */
function field(block, at, length) {
	return block.subarray(at, at + length).toString('utf8').replace(/\0.*$/s, '');
}
