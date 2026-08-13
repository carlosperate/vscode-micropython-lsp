import { configDefaults, defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This config lives in config/, but the test root is the repo root: vitest's
// own root otherwise defaults to the config file's directory, which would
// stop it discovering test/**/*.test.ts.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: path.join(here, '..'),
	test: {
		// The VS Code downloads under `.vscode-test-web/` and `.vscode-test/` carry
		// upstream's own `*.test.mts` files, which are not ours to collect: vitest
		// fails them for having no suite.
		exclude: [...configDefaults.exclude, '**/.vscode-test-web/**', '**/.vscode-test/**'],
	},
});
