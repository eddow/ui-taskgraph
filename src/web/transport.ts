// Framework-agnostic transport abstractions for web taskgraph execution.
//
// The agnostic client (`client.ts`) only talks to these interfaces.
// Each framework (SvelteKit, Nuxt, Next, ...) injects its own `fetch` and
// `EventSource` implementations — no framework imports here.

/** Minimal JSON requester. Implemented by `fetchRequester` below. */
export interface Requester {
	get<T = unknown>(url: string): Promise<T>
	post<T = unknown>(url: string, body?: unknown): Promise<T>
	del<T = unknown>(url: string): Promise<T>
}

/** Creates a {@link Requester} from any `fetch`-compatible function. */
export function fetchRequester(fetchImpl: typeof fetch = fetch): Requester {
	async function handle<T>(response: Response): Promise<T> {
		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
		const contentType = response.headers.get('content-type') ?? ''
		if (contentType.includes('application/json')) return (await response.json()) as T
		return (await response.text()) as unknown as T
	}
	return {
		get: <T>(url: string) =>
			fetchImpl(url, { headers: { Accept: 'application/json' } }).then((r) => handle<T>(r)),
		post: <T>(url: string, body?: unknown) =>
			fetchImpl(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
			}).then((r) => handle<T>(r)),
		del: <T>(url: string) =>
			fetchImpl(url, { method: 'DELETE', headers: { Accept: 'application/json' } }).then((r) =>
				handle<T>(r)
			),
	}
}

/** A single parsed SSE frame. */
export interface SseFrame {
	id?: string
	type: string
	data: string
}

/** Minimal SSE subscription. Implemented by `eventSourceStream` below. */
export interface EventStream {
	subscribe(url: string, onFrame: (frame: SseFrame) => void, opts?: { from?: number }): () => void
}

/** Constructor type for the DOM `EventSource` (or a polyfill). */
export type EventSourceCtor = new (url: string | URL, init?: EventSourceInit) => EventSource

/** Event names the web protocol emits (see `shared.ts` `RunnerEvent`). */
export const RUNNER_EVENT_NAMES = [
	'snapshot',
	'input-required',
	'input-provided',
	'done',
	'error',
] as const

/**
 * Creates an {@link EventStream} from any `EventSource` constructor.
 * Resume uses the `?from=` query parameter (native `EventSource` cannot set
 * the `Last-Event-ID` header on the initial request; automatic reconnects
 * still use it).
 *
 * Note: the protocol emits *named* SSE events, which never reach
 * `EventSource.onmessage` — hence the explicit `addEventListener` per name.
 */
export function eventSourceStream(EventSourceImpl: EventSourceCtor): EventStream {
	return {
		subscribe(url, onFrame, opts) {
			const withFrom =
				opts?.from !== undefined ? `${url}${url.includes('?') ? '&' : '?'}from=${opts.from}` : url
			const source = new EventSourceImpl(withFrom)
			const handler = (type: string) => (event: MessageEvent) => {
				onFrame({ id: event.lastEventId || undefined, type, data: event.data })
			}
			const handlers = new Map<string, (event: MessageEvent) => void>()
			for (const name of [...RUNNER_EVENT_NAMES, 'message']) {
				const fn = handler(name)
				handlers.set(name, fn)
				source.addEventListener(name, fn as EventListener)
			}
			return () => {
				for (const [name, fn] of handlers) source.removeEventListener(name, fn as EventListener)
				source.close()
			}
		},
	}
}

/** Serializes one event into SSE wire format (`id` doubles as resume cursor). */
export function formatSseFrame(seq: number, type: string, data: unknown): string {
	const payload = typeof data === 'string' ? data : JSON.stringify(data)
	return `id: ${seq}\nevent: ${type}\ndata: ${payload}\n\n`
}

/** Parses SSE wire text into frames (used by tests and non-`EventSource` consumers). */
export function parseSseFrames(text: string): SseFrame[] {
	const frames: SseFrame[] = []
	for (const chunk of text.split('\n\n')) {
		const frame: SseFrame = { type: 'message', data: '' }
		let hasData = false
		for (const line of chunk.split('\n')) {
			if (line.startsWith('data:')) {
				frame.data += (hasData ? '\n' : '') + line.slice(5).trimStart()
				hasData = true
			} else if (line.startsWith('event:')) frame.type = line.slice(6).trim()
			else if (line.startsWith('id:')) frame.id = line.slice(3).trim()
			else if (line.startsWith(':')) continue
		}
		if (hasData) frames.push(frame)
	}
	return frames
}
