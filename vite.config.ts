import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		expect: { requireAssertions: true },
		// Browser files in parallel race the SSR module runner at teardown:
		// after the last file finishes, a pending `fetchModule` fires on a
		// closed transport (`transport was disconnected`, exit still 0).
		// Sequential files avoid it entirely (~same duration: 7s either way).
		fileParallelism: false,
	},
})
