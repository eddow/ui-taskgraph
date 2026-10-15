import { describe, expect, it, vi } from 'vitest'
import { applyEvent, parseRunnerEvent, RemoteRunnerClient } from './client.js'
import type { RunnerEvent } from './shared.js'
import type { Requester } from './transport.js'

function mockRequester(overrides: Partial<Record<'get' | 'post' | 'del', any>> = {}) {
	return {
		get: vi.fn(async () => ({})),
		post: vi.fn(async () => ({ runId: 'r1' })),
		del: vi.fn(async () => ({})),
		...overrides,
	} as unknown as Requester & { get: any; post: any; del: any }
}
const noopStream = { subscribe: () => () => {} }

describe('parseRunnerEvent edge cases', () => {
	it('rejects invalid JSON', () => {
		expect(parseRunnerEvent('snapshot', '{oops')).toBeUndefined()
	})

	it('rejects snapshot without runId/workers', () => {
		expect(parseRunnerEvent('snapshot', '{}', '1')).toBeUndefined()
		expect(parseRunnerEvent('snapshot', JSON.stringify({ runId: 'r' }), '1')).toBeUndefined()
	})

	it('rejects input events without ioId', () => {
		expect(parseRunnerEvent('input-required', '{}', '1')).toBeUndefined()
		expect(parseRunnerEvent('input-provided', '{}', '1')).toBeUndefined()
	})

	it('parses input-provided', () => {
		expect(parseRunnerEvent('input-provided', JSON.stringify({ ioId: 'a' }), '4')).toEqual({
			seq: 4,
			type: 'input-provided',
			ioId: 'a',
		})
	})

	it('parses done with empty payload and defaults error message', () => {
		expect(parseRunnerEvent('done', '', '5')).toEqual({ seq: 5, type: 'done' })
		// non-JSON payloads are unparseable → undefined (even for `done`)
		expect(parseRunnerEvent('done', 'whatever', '5')).toBeUndefined()
		expect(parseRunnerEvent('error', '{}', '6')).toEqual({
			seq: 6,
			type: 'error',
			message: 'Unknown error',
		})
		expect(parseRunnerEvent('error', JSON.stringify({ message: 'x' }), '6')).toEqual({
			seq: 6,
			type: 'error',
			message: 'x',
		})
	})

	it('rejects unknown event types and empty data', () => {
		expect(parseRunnerEvent('nope', '{}', '1')).toBeUndefined()
		expect(parseRunnerEvent('done', '', '2')).toEqual({ seq: 2, type: 'done' })
		expect(parseRunnerEvent('snapshot', '', '3')).toBeUndefined()
	})

	it('defaults seq to 0 without id', () => {
		expect(parseRunnerEvent('done', '')).toEqual({ seq: 0, type: 'done' })
	})
})

describe('applyEvent', () => {
	it('leaves map untouched for non-snapshot events', () => {
		const m = new Map([['k', { key: 'k' } as any]])
		const out = applyEvent(m, { seq: 1, type: 'done' })
		expect(out).toBe(m)
		expect(m.size).toBe(1)
	})

	it('replaces map content on snapshot', () => {
		const m = new Map([['old', { key: 'old' } as any]])
		applyEvent(m, {
			seq: 2,
			type: 'snapshot',
			snapshot: {
				runId: 'r',
				task: 't',
				running: false,
				infos: {},
				errors: [],
				pendingInputs: [],
				seq: 2,
				workers: [
					{
						key: 'n',
						depth: 0,
						state: 'active',
						progress: null,
						progressMax: 1,
						waitingInput: false,
					},
				],
			},
		})
		expect([...m.keys()]).toEqual(['n'])
	})
})

describe('RemoteRunnerClient lifecycle guards', () => {
	it('throws when no run started', async () => {
		const c = new RemoteRunnerClient({
			base: '/tasks/',
			requester: mockRequester(),
			stream: noopStream,
		})
		expect(c.base).toBe('/tasks')
		await expect(c.refresh()).rejects.toThrow('No run started')
		expect(() => c.connect()).toThrow('No run started')
		await expect(c.sendInput('x', 1)).rejects.toThrow('No run started')
		await expect(c.dispose()).resolves.toBeUndefined()
	})

	it('onChange subscribe/unsubscribe', async () => {
		const requester = mockRequester({
			get: vi.fn(async () => ({
				runId: 'r1',
				task: 't',
				running: true,
				infos: {},
				errors: [],
				workers: [],
				pendingInputs: [],
				seq: 0,
			})),
		})
		const c = new RemoteRunnerClient({ base: '/t', requester, stream: noopStream })
		const fn = vi.fn()
		const off = c.onChange(fn)
		await c.start({ task: 't' })
		expect(fn).toHaveBeenCalled()
		off()
		fn.mockClear()
		c.ingest({ seq: 99, type: 'done' })
		expect(fn).not.toHaveBeenCalled()
	})

	it('ignores stale events with seq <= lastSeq', async () => {
		const requester = mockRequester({
			get: vi.fn(async () => ({
				runId: 'r1',
				task: 't',
				running: true,
				infos: {},
				errors: [],
				workers: [],
				pendingInputs: [],
				seq: 10,
			})),
		})
		const c = new RemoteRunnerClient({ base: '/t', requester, stream: noopStream })
		await c.start({ task: 't' })
		expect(c.lastSeq).toBe(10)
		c.ingest({ seq: 5, type: 'done' })
		expect(c.done).toBe(false)
		c.ingest({ seq: 10, type: 'done' })
		expect(c.done).toBe(false)
	})

	it('ingest snapshot event refreshes workers/errors/pending', async () => {
		const requester = mockRequester({
			get: vi.fn(async () => ({
				runId: 'r1',
				task: 't',
				running: true,
				infos: {},
				errors: [],
				workers: [],
				pendingInputs: [],
				seq: 0,
			})),
		})
		const c = new RemoteRunnerClient({ base: '/t', requester, stream: noopStream })
		await c.start({ task: 't' })
		const snapshot = {
			runId: 'r1',
			task: 't',
			running: true,
			infos: { a: 'b' },
			errors: ['e1'],
			workers: [
				{
					key: 'w1',
					depth: 0,
					state: 'active',
					progress: 0.5,
					progressMax: 1,
					waitingInput: false,
					text: 'hi',
				},
			],
			pendingInputs: ['io1'],
			seq: 3,
		}
		c.ingest({ seq: 3, type: 'snapshot', snapshot } as RunnerEvent)
		expect(c.workers.get('w1')?.text).toBe('hi')
		expect(c.errors).toEqual(['e1'])
		expect(c.pendingInputs.has('io1')).toBe(true)
		expect(c.snapshot?.infos).toEqual({ a: 'b' })
	})

	it('start resets previous state', async () => {
		let n = 0
		const requester = mockRequester({
			get: vi.fn(async () => ({
				runId: 'rx',
				task: 't',
				running: true,
				infos: {},
				errors: [],
				workers: [],
				pendingInputs: [],
				seq: 0,
			})),
			post: vi.fn(async () => ({ runId: `r${++n}` })),
		})
		const c = new RemoteRunnerClient({ base: '/t', requester, stream: noopStream })
		await c.start({ task: 't' })
		c.ingest({ seq: 1, type: 'done' })
		c.ingest({ seq: 2, type: 'error', message: 'x' })
		expect(c.done).toBe(true)
		await c.start({ task: 't' })
		expect(c.done).toBe(false)
		expect(c.errors).toEqual([])
		expect(c.runId).toBe('r2')
	})

	it('connect passes ?from resume and dispose clears runId', async () => {
		const seen: any[] = []
		const unsub = vi.fn()
		const stream = {
			subscribe: vi.fn((_url: string, _cb: any, opts?: any) => {
				seen.push(opts)
				return unsub
			}),
		}
		const requester = mockRequester({
			get: vi.fn(async () => ({
				runId: 'r1',
				task: 't',
				running: true,
				infos: {},
				errors: [],
				workers: [],
				pendingInputs: [],
				seq: 4,
			})),
		})
		const c = new RemoteRunnerClient({ base: '/t', requester, stream })
		await c.start({ task: 't' })
		expect(stream.subscribe).toHaveBeenCalled()
		expect(seen[0]).toEqual({ from: 4 })
		// reconnect disconnects first
		c.connect()
		expect(unsub).toHaveBeenCalled()
		await c.dispose()
		expect(requester.del).toHaveBeenCalledWith('/t/r1')
		expect(c.runId).toBeUndefined()
	})

	it('stream frames flow into ingest via connect callback', async () => {
		let cb!: (f: any) => void
		const stream = {
			subscribe: (_url: string, onFrame: any) => {
				cb = onFrame
				return () => {}
			},
		}
		const requester = mockRequester({
			get: vi.fn(async () => ({
				runId: 'r1',
				task: 't',
				running: true,
				infos: {},
				errors: [],
				workers: [],
				pendingInputs: [],
				seq: 0,
			})),
		})
		const c = new RemoteRunnerClient({ base: '/t', requester, stream })
		await c.start({ task: 't' })
		cb({ type: 'input-required', data: JSON.stringify({ ioId: 'n' }), id: '1' })
		expect(c.pendingInputs.has('n')).toBe(true)
		cb({ type: 'bogus', data: '{}', id: '2' })
		expect(c.lastSeq).toBe(1)
	})
})
