import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	ssr: {
		external: ['better-sqlite3', 'bindings'],
	},
	server: {
		watch: {
			ignored: ['**/docs/**', '**/services/friday/**', '**/packages/cli/**'],
		},
	},
});
