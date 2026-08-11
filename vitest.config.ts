import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// The VS Code downloads under `.vscode-test-web/` and `.vscode-test/` carry
		// upstream's own `*.test.mts` files, which are not ours to collect: vitest
		// fails them for having no suite.
		exclude: [...configDefaults.exclude, '**/.vscode-test-web/**', '**/.vscode-test/**'],
	},
});
