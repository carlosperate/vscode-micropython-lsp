import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// `npm run test:integration` unpacks a whole VS Code into
		// `.vscode-test-web/`, and upstream's own `*.test.mts` files are not ours
		// to collect: vitest fails them for having no suite.
		exclude: [...configDefaults.exclude, '**/.vscode-test-web/**'],
	},
});
