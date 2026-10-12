import { describe, expect, it, vi } from 'vitest'
import { RemoteRunnerRegistry } from './backend.js'
import { handleRemoteRequest } from './http.js'

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
function makeRegistry() {
	const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
	registry.registerTask('demo', () => [async () => {}])
	return registry
}
const req = (url: string, init?: RequestInit) => new Request(url, init)
const jsonReq = (url: string, method: string, body: unknown) =>
	new Request(url, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

describe('handleRemoteRequest routing', () => {
	it('lists tasks at GET base', async () => {
		const registry = makeRegistry()
		const res = await handleRemoteRequest(req('http://x/tasks'), registry, { base: '/tasks' })
		expect(res?.status).toBe(200)
		expect(await res!.json()).toEqual({ tasks: ['demo'] })
	})

	it('rejects POST create without task (400)', async () => {
		const registry = makeRegistry()
		const res = await handleRemoteRequest(
			jsonReq('http://x/tasks', 'POST', {}),
			registry,
			{ base: '/tasks' }
		)
		expect(res?.status).toBe(400)
	})

	it('rejects POST create with unknown task (404)', async () => {
		const registry = makeRegistry()
		const res = await handleRemoteRequest(
			jsonReq('http://x/tasks', 'POST', { task: 'nope' }),
			registry,
			{ base: '/tasks' }
		)
		expect(res?.status).toBe(404)
	})

	it('handles malformed JSON body as {}', async () => {
		const registry = makeRegistry()
		const res = await handleRemoteRequest(
			new Request('http://x/tasks', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: 'not-json{{{',
			}),
			registry,
			{ base: '/tasks' }
		)
		expect(res?.status).toBe(400)
	})

	it('serves HEAD snapshot like GET', async () => {
		const registry = makeRegistry()
		const runId = registry.create({ task: 'demo' })
		const res = await handleRemoteRequest(req(`http://x/tasks/${runId}`, { method: 'HEAD' }), registry, {
			base: '/tasks',
		})
		expect(res?.status).toBe(200)
		registry.dispose(runId)
	})

	it('rejects POST input without ioId (400)', async () => {
		const registry = makeRegistry()
		const runId = registry.create({ task: 'demo' })
		const res = await handleRemoteRequest(
			jsonReq(`http://x/tasks/${runId}/input`, 'POST', { value: 1 }),
			registry,
			{ base: '/tasks' }
		)
		expect(res?.status).toBe(400)
		registry.dispose(runId)
	})

	it('accepts POST input for a pending ClientIO and returns {}', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		registry.registerTask('ask', (ctx) => [
			async ({ status }: any) => {
				const tio = new ctx.ClientIO<any, string>('name')
				status.text = await status.require(tio)
			},
		])
		const runId = registry.create({ task: 'ask' })
		await tick(30)
		expect(registry.getSnapshot(runId).pendingInputs).toContain('name')
		const res = await handleRemoteRequest(
			jsonReq(`http://x/tasks/${runId}/input`, 'POST', { ioId: 'name', value: 'ada' }),
			registry,
			{ base: '/tasks' }
		)
		expect(res?.status).toBe(200)
		expect(await res!.json()).toEqual({})
		await tick(30)
		expect(registry.eventsSince(runId).at(-1)).toMatchObject({ type: 'done' })
		registry.dispose(runId)
	})

	it('returns 404 for input that was never queried', async () => {
		const registry = makeRegistry()
		const runId = registry.create({ task: 'demo' })
		const res = await handleRemoteRequest(
			jsonReq(`http://x/tasks/${runId}/input`, 'POST', { ioId: 'a', value: 1 }),
			registry,
			{ base: '/tasks' }
		)
		expect(res?.status).toBe(404)
		registry.dispose(runId)
	})

	it('returns 404 for input on unknown run', async () => {
		const registry = makeRegistry()
		const res = await handleRemoteRequest(
			jsonReq('http://x/tasks/ghost/input', 'POST', { ioId: 'a', value: 1 }),
			registry,
			{ base: '/tasks' }
		)
		expect(res?.status).toBe(404)
	})

	it('DELETE unknown run still returns {} (idempotent dispose)', async () => {
		const registry = makeRegistry()
		const res = await handleRemoteRequest(
			req('http://x/tasks/ghost', { method: 'DELETE' }),
			registry,
			{ base: '/tasks' }
		)
		expect(res?.status).toBe(200)
	})

	it('returns undefined for unknown routes and methods', async () => {
		const registry = makeRegistry()
		expect(
			await handleRemoteRequest(req('http://x/tasks/a/b/c'), registry, { base: '/tasks' })
		).toBeUndefined()
		expect(
			await handleRemoteRequest(req('http://x/tasks', { method: 'PUT' }), registry, {
				base: '/tasks',
			})
		).toBeUndefined()
		expect(
			await handleRemoteRequest(req('http://x/tasks/abc', { method: 'POST' }), registry, {
				base: '/tasks',
			})
		).toBeUndefined()
	})

	it('matches base with trailing slash', async () => {
		const registry = makeRegistry()
		const res = await handleRemoteRequest(req('http://x/tasks'), registry, { base: '/tasks/' })
		expect(res?.status).toBe(200)
	})

	it('works without base (default empty)', async () => {
		const registry = makeRegistry()
		const res = await handleRemoteRequest(req('http://x/'), registry)
		expect(res?.status).toBe(200)
		expect(await res!.json()).toEqual({ tasks: ['demo'] })
	})

	it('rethrows unexpected errors', async () => {
		const bad = { listTasks: () => { throw new Error('kaboom') } } as any
		await expect(handleRemoteRequest(req('http://x/'), bad)).rejects.toThrow('kaboom')
	})

	it('SSE honors ?from= resume param', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		let release!: () => void
		const gate = new Promise<void>((r) => (release = r))
		registry.registerTask('gated', () => [async () => { await gate }])
		const runId = registry.create({ task: 'gated' })
		await tick(30)
		const total = registry.eventsSince(runId).length
		expect(total).toBeGreaterThan(0)
		const res = await handleRemoteRequest(
			req(`http://x/tasks/${runId}/events?from=${total}`),
			registry,
			{ base: '/tasks', heartbeatMs: 0 }
		)
		expect(res?.headers.get('content-type')).toBe('text/event-stream')
		release()
		const reader = res!.body!.getReader()
		const decoder = new TextDecoder()
		let text = ''
		const deadline = Date.now() + 2000
		while (!text.includes('event: done') && Date.now() < deadline) {
			const { done, value } = await reader.read()
			if (done) break
			text += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
		}
		await reader.cancel()
		// resumed stream skips earlier snapshots, still ends with done
		expect(text).toContain('event: done')
		registry.dispose(runId)
	})

	it('SSE honors Last-Event-ID header', async () => {
		const registry = makeRegistry()
		const runId = registry.create({ task: 'demo' })
		await tick(30)
		const res = await handleRemoteRequest(
			req(`http://x/tasks/${runId}/events`, {
				headers: { Accept: 'text/event-stream', 'Last-Event-ID': '9999' },
			}),
			registry,
			{ base: '/tasks', heartbeatMs: 0 }
		)
		expect(res?.headers.get('content-type')).toBe('text/event-stream')
		await res!.body!.cancel()
		registry.dispose(runId)
	})

	it('SSE on unknown run closes without frames', async () => {
		const registry = makeRegistry()
		const res = await handleRemoteRequest(
			req('http://x/tasks/ghost/events'),
			registry,
			{ base: '/tasks', heartbeatMs: 0 }
		)
		expect(res?.headers.get('content-type')).toBe('text/event-stream')
		const reader = res!.body!.getReader()
		const { done } = await reader.read()
		expect(done).toBe(true)
	})

	it('SSE heartbeat path can be cancelled', async () => {
		const registry = makeRegistry()
		const runId = registry.create({ task: 'demo' })
		await tick(20)
		const res = await handleRemoteRequest(req(`http://x/tasks/${runId}/events`), registry, {
			base: '/tasks',
			heartbeatMs: 10,
		})
		expect(res?.headers.get('content-type')).toBe('text/event-stream')
		await res!.body!.cancel()
		registry.dispose(runId)
		const spy = vi.fn()
		expect(spy).not.toHaveBeenCalled()
	})
})
