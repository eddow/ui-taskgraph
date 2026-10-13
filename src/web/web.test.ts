import { describe, expect, it, vi } from 'vitest'
import { RemoteRunnerRegistry } from './backend.js'
import { applyEvent, parseRunnerEvent, RemoteRunnerClient } from './client.js'
import { handleRemoteRequest } from './http.js'
import type { RunnerEvent } from './shared.js'
import { formatSseFrame, parseSseFrames } from './transport.js'

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

function registryWith() {
	const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
	let releaseGate!: () => void
	const gate = new Promise<void>((r) => (releaseGate = r))
	registry.registerTask('demo', () => [
		async ({ status }: any) => {
			status.text = 'hello'
			status.progress(0.5, 1)
			await gate
		},
	])
	return { registry, releaseGate: () => releaseGate() }
}

describe('web backend', () => {
	it('creates isolated non-singleton runs', async () => {
		const { registry, releaseGate } = registryWith()
		const a = registry.create({ task: 'demo' })
		const b = registry.create({ task: 'demo' })
		expect(a).not.toBe(b)
		expect(registry.has(a)).toBe(true)
		expect(registry.has(b)).toBe(true)
		await tick(30)
		const sa = registry.getSnapshot(a)
		const sb = registry.getSnapshot(b)
		expect(sa.runId).toBe(a)
		expect(sb.runId).toBe(b)
		expect(sa.workers[0]?.text).toBe('hello')
		expect(sb.workers[0]?.text).toBe('hello')
		releaseGate()
		registry.dispose(a)
		registry.dispose(b)
		expect(registry.has(a)).toBe(false)
	})

	it('emits input-required / input-provided around TaskIO', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		registry.registerTask('ask', (ctx) => [
			async ({ status }: any) => {
				const tio = new ctx.ClientIO<any, string>('name')
				status.text = await status.require(tio)
			},
		])
		const runId = registry.create({ task: 'ask' })
		await tick(30)
		const required = registry.eventsSince(runId).find((e) => e.type === 'input-required')
		expect(required).toMatchObject({ type: 'input-required', ioId: 'name' })
		expect(registry.getSnapshot(runId).workers[0]?.waitingInput).toBe(true)
		registry.provideInput(runId, { ioId: 'name', value: 'ada' })
		await tick(30)
		expect(registry.eventsSince(runId)).toContainEqual(
			expect.objectContaining({ type: 'input-provided', ioId: 'name' })
		)
		expect(registry.eventsSince(runId).at(-1)).toMatchObject({ type: 'done' })
		registry.dispose(runId)
	})

	it('emits done and keeps monotonic seq', async () => {
		const { registry, releaseGate } = registryWith()
		const runId = registry.create({ task: 'demo' })
		const seen: RunnerEvent[] = []
		const off = registry.subscribe(runId, (e) => seen.push(e))
		releaseGate()
		await tick(40)
		off()
		expect(seen.at(-1)).toMatchObject({ type: 'done' })
		const seqs = seen.map((e) => e.seq)
		expect([...seqs].sort((x, y) => x - y)).toEqual(seqs)
		registry.dispose(runId)
	})

	it('rejects unknown task and unknown run', () => {
		const registry = new RemoteRunnerRegistry()
		expect(() => registry.create({ task: 'nope' })).toThrow()
		expect(() => registry.getSnapshot('missing')).toThrow()
	})
})

describe('web http', () => {
	it('POST create → GET snapshot → POST input → DELETE', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		registry.registerTask('demo', () => [async () => {}])
		const created = await handleRemoteRequest(
			new Request('http://x/tasks', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ task: 'demo' }),
			}),
			registry,
			{ base: '/tasks' }
		)
		expect(created?.status).toBe(201)
		const { runId } = (await created!.json()) as { runId: string }
		const snap = await handleRemoteRequest(
			new Request(`http://x/tasks/${runId}`, { headers: { Accept: 'application/json' } }),
			registry,
			{ base: '/tasks' }
		)
		expect(snap?.status).toBe(200)
		expect(((await snap!.json()) as any).runId).toBe(runId)
		const gone = await handleRemoteRequest(
			new Request(`http://x/tasks/${runId}`, { method: 'DELETE' }),
			registry,
			{ base: '/tasks' }
		)
		expect(gone?.status).toBe(200)
		expect(registry.has(runId)).toBe(false)
	})

	it('streams SSE frames with ids', async () => {
		const { registry, releaseGate } = registryWith()
		const runId = registry.create({ task: 'demo' })
		await tick(30)
		const response = await handleRemoteRequest(
			new Request(`http://x/tasks/${runId}/events`, {
				headers: { Accept: 'text/event-stream' },
			}),
			registry,
			{ base: '/tasks', heartbeatMs: 0 }
		)
		expect(response?.headers.get('content-type')).toBe('text/event-stream')
		releaseGate()
		const reader = response!.body!.getReader()
		const decoder = new TextDecoder()
		let text = ''
		const deadline = Date.now() + 2000
		while (!text.includes('event: done') && Date.now() < deadline) {
			const { done, value } = await reader.read()
			if (done) break
			text += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
		}
		await reader.cancel()
		const frames = parseSseFrames(text)
		expect(frames.length).toBeGreaterThan(0)
		expect(frames[0].id).toMatch(/^\d+$/)
		registry.dispose(runId)
	})

	it('returns undefined off-base and 404 for unknown run', async () => {
		const registry = new RemoteRunnerRegistry()
		expect(
			await handleRemoteRequest(new Request('http://x/other'), registry, { base: '/tasks' })
		).toBeUndefined()
		const missing = await handleRemoteRequest(new Request('http://x/tasks/nope'), registry, {
			base: '/tasks',
		})
		expect(missing?.status).toBe(404)
	})
})

describe('web client', () => {
	it('reduces snapshot events into worker map', () => {
		const workers = new Map()
		applyEvent(workers, {
			seq: 1,
			type: 'snapshot',
			snapshot: {
				runId: 'r',
				task: 't',
				running: true,
				infos: {},
				errors: [],
				pendingInputs: [],
				seq: 1,
				workers: [
					{
						key: 'w1',
						depth: 0,
						progress: 0.5,
						progressMax: 1,
						waitingInput: false,
						text: 'hi',
					},
				],
			},
		})
		expect(workers.get('w1').text).toBe('hi')
	})

	it('tracks pending inputs, errors and done', async () => {
		const requester = {
			get: vi.fn(async (): Promise<unknown> => ({})),
			post: vi.fn(async (): Promise<unknown> => ({ runId: 'r1' })),
			del: vi.fn(async (): Promise<unknown> => ({})),
		}
		const frames: any[] = []
		const stream = {
			subscribe: (_url: string, onFrame: any) => {
				for (const f of frames) onFrame(f)
				return () => {}
			},
		}
		const client = new RemoteRunnerClient({
			base: '/tasks',
			requester: requester as unknown as import('./transport.js').Requester,
			stream,
		})
		requester.get.mockResolvedValue({
			runId: 'r1',
			task: 'demo',
			running: true,
			infos: {},
			errors: [],
			workers: [],
			pendingInputs: [],
			seq: 0,
		})
		await client.start({ task: 'demo' })
		client.ingest({ seq: 1, type: 'input-required', ioId: 'name' })
		expect(client.pendingInputs.has('name')).toBe(true)
		client.ingest({ seq: 2, type: 'input-provided', ioId: 'name' })
		expect(client.pendingInputs.has('name')).toBe(false)
		client.ingest({ seq: 3, type: 'error', message: 'boom' })
		expect(client.errors).toContain('boom')
		client.ingest({ seq: 4, type: 'done' })
		expect(client.done).toBe(true)
		await client.sendInput('name', 'ada')
		expect(requester.post).toHaveBeenCalledWith('/tasks/r1/input', {
			ioId: 'name',
			value: 'ada',
		})
	})

	it('reconciles pending inputs from snapshots (resume-safe)', async () => {
		const requester = {
			get: vi.fn(async (): Promise<unknown> => ({})),
			post: vi.fn(async (): Promise<unknown> => ({ runId: 'r1' })),
			del: vi.fn(async (): Promise<unknown> => ({})),
		}
		const stream = { subscribe: () => () => {} }
		const client = new RemoteRunnerClient({
			base: '/tasks',
			requester: requester as unknown as import('./transport.js').Requester,
			stream,
		})
		// The `input-required` event predates the snapshot seq (skipped by
		// `?from=` resume) — the snapshot itself must restore pending inputs.
		requester.get.mockResolvedValue({
			runId: 'r1',
			task: 'ask',
			running: true,
			infos: {},
			errors: [],
			workers: [],
			pendingInputs: ['name'],
			seq: 5,
		})
		await client.start({ task: 'ask' })
		expect(client.pendingInputs.has('name')).toBe(true)
		client.ingest({ seq: 6, type: 'input-provided', ioId: 'name' })
		expect(client.pendingInputs.has('name')).toBe(false)
	})

	it('round-trips SSE codec', () => {
		const wire = formatSseFrame(7, 'input-required', { ioId: 'name' })
		const [frame] = parseSseFrames(wire)
		expect(parseRunnerEvent(frame.type, frame.data, frame.id)).toEqual({
			seq: 7,
			type: 'input-required',
			ioId: 'name',
		})
	})

	it('parses server-sent snapshot frames (data is the snapshot itself)', () => {
		const snapshot = {
			runId: 'r',
			task: 't',
			running: true,
			infos: {},
			errors: [],
			pendingInputs: [],
			seq: 3,
			workers: [],
		}
		const wire = formatSseFrame(3, 'snapshot', snapshot)
		const [frame] = parseSseFrames(wire)
		expect(parseRunnerEvent(frame.type, frame.data, frame.id)).toEqual({
			seq: 3,
			type: 'snapshot',
			snapshot,
		})
	})
})
