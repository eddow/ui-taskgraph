import { describe, expect, it, vi } from 'vitest'
import {
	eventSourceStream,
	fetchRequester,
	formatSseFrame,
	parseSseFrames,
	RUNNER_EVENT_NAMES,
} from './transport.js'

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

describe('fetchRequester', () => {
	it('sends GET with Accept header and parses json', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }))
		const r = fetchRequester(fetchImpl as unknown as typeof fetch)
		await expect(r.get('/x')).resolves.toEqual({ ok: true })
		expect(fetchImpl).toHaveBeenCalledWith('/x', {
			headers: { Accept: 'application/json' },
		})
	})

	it('sends POST with JSON body', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ id: 1 }, 201))
		const r = fetchRequester(fetchImpl as unknown as typeof fetch)
		await expect(r.post('/x', { a: 1 })).resolves.toEqual({ id: 1 })
		expect(fetchImpl).toHaveBeenCalledWith('/x', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ a: 1 }),
		})
	})

	it('sends POST without body when undefined', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}))
		const r = fetchRequester(fetchImpl as unknown as typeof fetch)
		await r.post('/x')
		expect(fetchImpl.mock.calls[0][1].body).toBeUndefined()
	})

	it('sends DELETE', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}))
		const r = fetchRequester(fetchImpl as unknown as typeof fetch)
		await r.del('/x/1')
		expect(fetchImpl).toHaveBeenCalledWith('/x/1', {
			method: 'DELETE',
			headers: { Accept: 'application/json' },
		})
	})

	it('throws on HTTP error status', async () => {
		const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }))
		const r = fetchRequester(fetchImpl as unknown as typeof fetch)
		await expect(r.get('/missing')).rejects.toThrow('404')
	})

	it('returns text for non-JSON responses', async () => {
		const fetchImpl = vi.fn(async () => new Response('plain text'))
		const r = fetchRequester(fetchImpl as unknown as typeof fetch)
		await expect(r.get('/t')).resolves.toBe('plain text')
	})
})

describe('eventSourceStream', () => {
	function fakeCtor() {
		const listeners = new Map<string, ((e: any) => void)[]>()
		const instances: any[] = []
		const Ctor = vi.fn(function (this: any, url: string | URL) {
			this.url = String(url)
			this.closed = false
			this.close = () => {
				this.closed = true
			}
			this.addEventListener = (name: string, fn: any) => {
				listeners.set(name, [...(listeners.get(name) ?? []), fn])
			}
			this.removeEventListener = (name: string, fn: any) => {
				listeners.set(
					name,
					(listeners.get(name) ?? []).filter((f) => f !== fn)
				)
			}
			instances.push(this)
		})
		return { Ctor: Ctor as unknown as new (url: string | URL) => EventSource, listeners, instances }
	}

	it('subscribes to all runner event names plus message', () => {
		const { Ctor, listeners, instances } = fakeCtor()
		const stream = eventSourceStream(Ctor)
		const onFrame = vi.fn()
		const off = stream.subscribe('/ev', onFrame)
		for (const name of [...RUNNER_EVENT_NAMES, 'message']) {
			expect(listeners.get(name)?.length).toBe(1)
		}
		// dispatch one event
		listeners.get('done')![0]({ lastEventId: '9', data: '{}' })
		expect(onFrame).toHaveBeenCalledWith({ id: '9', type: 'done', data: '{}' })
		off()
		expect(instances[0].closed).toBe(true)
	})

	it('appends ?from= resume param respecting existing query', () => {
		const { Ctor, instances } = fakeCtor()
		const stream = eventSourceStream(Ctor)
		stream.subscribe('/ev', () => {}, { from: 5 })
		expect(instances[0].url).toBe('/ev?from=5')
		stream.subscribe('/ev?a=b', () => {}, { from: 7 })
		expect(instances[1].url).toBe('/ev?a=b&from=7')
	})

	it('handles missing lastEventId', () => {
		const { Ctor, listeners } = fakeCtor()
		const stream = eventSourceStream(Ctor)
		const onFrame = vi.fn()
		stream.subscribe('/ev', onFrame)
		listeners.get('snapshot')![0]({ data: '{}' })
		expect(onFrame).toHaveBeenCalledWith({ id: undefined, type: 'snapshot', data: '{}' })
	})
})

describe('SSE codec', () => {
	it('serializes string payloads verbatim', () => {
		expect(formatSseFrame(1, 'done', 'raw')).toBe('id: 1\nevent: done\ndata: raw\n\n')
	})

	it('parses multi-line data and skips comments/heartbeats', () => {
		const frames = parseSseFrames(': ping\n\nevent: x\ndata: a\ndata: b\nid: 3\n\n')
		expect(frames).toEqual([{ type: 'x', data: 'a\nb', id: '3' }])
	})

	it('defaults type to message and drops frames without data', () => {
		const frames = parseSseFrames('id: 1\n\n')
		expect(frames).toEqual([])
		const frames2 = parseSseFrames('data: hello\n\n')
		expect(frames2).toEqual([{ type: 'message', data: 'hello' }])
	})
})
