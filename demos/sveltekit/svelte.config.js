import adapter from '@sveltejs/adapter-node'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		alias: {
			'ui-taskgraph/web': '../../src/web/index.ts',
			'ui-taskgraph/sveltekit/server': '../../src/sveltekit/server.ts',
			'ui-taskgraph/sveltekit/client': '../../src/sveltekit/client.svelte.ts',
		},
	},
}

export default config
