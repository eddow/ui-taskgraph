// Framework-agnostic HTTP+SSE handler for web taskgraph execution.
//
// `handleRemoteRequest` speaks only standard `Request`/`Response` (plus an
// optional `ReadableStream` for SSE). Framework adapters (SvelteKit, Nuxt,
// Next, ...) translate their native objects to/from these — the protocol
// logic itself stays here, written once.
//
// Protocol (same route, `Accept`-negotiated — no `/api/` prefix):
// - `POST   {base}`               (`Accept: application/json`) → `{ runId }`
// - `GET    {base}/{runId}`       (`Accept: application/json`) → `RunSnapshot`
// - `GET    {base}/{runId}/events`(`Accept: text/event-stream`) → SSE stream
// - `POST   {base}/{runId}/input` (`Accept: application/json`) → `{}`
// - `DELETE {base}/{runId}`       → `{}`

import {
	type RemoteRunnerRegistry,
	UnknownInputError,
	UnknownRunError,
	UnknownTaskError,
} from './backend.js'
import type { CreateRunRequest, ProvideInputRequest, RunnerEvent } from './shared.js'
import { formatSseFrame } from './transport.js'

export interface RemoteHttpOptions {
	/** Route prefix the adapter mounted us on, e.g. `/tasks`. Default `''`. */
	base?: string
	/** Heartbeat comment interval (ms). `0` disables. Default `15_000`. */
	heartbeatMs?: number
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function sseResponse(
	registry: RemoteRunnerRegistry,
	runId: string,
	from: number,
	heartbeatMs: number
): Response {
	let unsubscribe: (() => void) | undefined
	let heartbeat: ReturnType<typeof setInterval> | undefined
	const stream = new ReadableStream<string>({
		start(controller) {
			const send = (event: RunnerEvent) => {
				if (event.type === 'snapshot')
					controller.enqueue(formatSseFrame(event.seq, 'snapshot', event.snapshot))
				else if (event.type === 'input-required')
					controller.enqueue(formatSseFrame(event.seq, 'input-required', { ioId: event.ioId }))
				else if (event.type === 'input-provided')
					controller.enqueue(formatSseFrame(event.seq, 'input-provided', { ioId: event.ioId }))
				else if (event.type === 'done') controller.enqueue(formatSseFrame(event.seq, 'done', {}))
				else controller.enqueue(formatSseFrame(event.seq, 'error', { message: event.message }))
			}
			try {
				unsubscribe = registry.subscribe(runId, send, from)
			} catch {
				controller.close()
				return
			}
			if (heartbeatMs > 0) {
				heartbeat = setInterval(() => {
					try {
						controller.enqueue(': ping\n\n')
					} catch {
						/* client gone */
					}
				}, heartbeatMs)
				;(heartbeat as unknown as { unref?: () => void }).unref?.()
			}
		},
		cancel() {
			clearInterval(heartbeat)
			unsubscribe?.()
		},
	})
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	})
}

/**
 * Handles one HTTP request for the web taskgraph protocol.
 * Returns `undefined` when the request does not target our routes
 * (adapter should fall through to its normal page/API handling).
 */
export async function handleRemoteRequest(
	request: Request,
	registry: RemoteRunnerRegistry,
	opts: RemoteHttpOptions = {}
): Promise<Response | undefined> {
	const url = new URL(request.url)
	const base = (opts.base ?? '').replace(/\/$/, '')
	let path = url.pathname
	if (base) {
		if (path !== base && !path.startsWith(`${base}/`)) return undefined
		path = path.slice(base.length) || '/'
	}
	const parts = path.split('/').filter(Boolean)
	const method = request.method.toUpperCase()

	try {
		if (method === 'GET' && parts.length === 0) {
			return json({ tasks: registry.listTasks() })
		}
		if (method === 'POST' && parts.length === 0) {
			const body = (await request.json().catch(() => ({}))) as CreateRunRequest
			if (!body.task) return json({ error: 'Missing `task`' }, 400)
			const runId = registry.create(body)
			return json({ runId }, 201)
		}
		if (parts.length === 1 && (method === 'GET' || method === 'HEAD')) {
			return json(registry.getSnapshot(parts[0]))
		}
		if (parts.length === 2 && parts[1] === 'events' && method === 'GET') {
			const fromHeader = request.headers.get('last-event-id')
			const from = Number(url.searchParams.get('from') ?? fromHeader ?? 0) || 0
			return sseResponse(registry, parts[0], from, opts.heartbeatMs ?? 15_000)
		}
		if (parts.length === 2 && parts[1] === 'input' && method === 'POST') {
			const body = (await request.json().catch(() => ({}))) as ProvideInputRequest
			if (!body.ioId) return json({ error: 'Missing `ioId`' }, 400)
			registry.provideInput(parts[0], body)
			return json({})
		}
		if (parts.length === 1 && method === 'DELETE') {
			registry.dispose(parts[0])
			return json({})
		}
	} catch (error) {
		if (error instanceof UnknownRunError) return json({ error: error.message }, 404)
		if (error instanceof UnknownTaskError) return json({ error: error.message }, 404)
		if (error instanceof UnknownInputError) return json({ error: error.message }, 404)
		throw error
	}
	return undefined
}
