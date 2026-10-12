import { describe, expect, it } from 'vitest'
import { RemoteRunnerRegistry } from '../web/index.js'
import { tasksHandler } from './server.js'

function makeRegistry() {
	const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
	registry.registerTask('demo', () => [async () => {}])
	return registry
}

describe('tasksHandler', () => {
	it('delegates to handleRemoteRequest and returns the response', async () => {
		const registry = makeRegistry()
		const handle = tasksHandler(registry, { base: '/tasks' })
		const res = await handle({
			request: new Request('http://x/tasks', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ task: 'demo' }),
			}),
		} as any)
		expect(res.status).toBe(201)
		const { runId } = (await res.json()) as { runId: string }
		expect(runId).toBeDefined()
		registry.dispose(runId)
	})

	it('returns 404 for off-base requests', async () => {
		const registry = makeRegistry()
		const handle = tasksHandler(registry, { base: '/tasks' })
		const res = await handle({ request: new Request('http://x/other') } as any)
		expect(res.status).toBe(404)
		expect(await res.text()).toBe('Not found')
	})

	it('passes heartbeatMs through to SSE streams', async () => {
		const registry = makeRegistry()
		const runId = registry.create({ task: 'demo' })
		const handle = tasksHandler(registry, { base: '/tasks', heartbeatMs: 0 })
		const res = await handle({
			request: new Request(`http://x/tasks/${runId}/events`),
		} as any)
		expect(res.headers.get('content-type')).toBe('text/event-stream')
		await res.body!.cancel()
		registry.dispose(runId)
	})
})
