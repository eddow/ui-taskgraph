// Framework-agnostic front-end client for web taskgraph execution.
//
// `RemoteRunnerClient` holds the workstatuses (`Map<key, WorkerSnapshot>`)
// and their evolution (ordered event log → `status_{t+1} = apply(status_t,
// event_t)`). It only talks to the injected {@link Requester} /
// {@link EventStream} — no `fetch`, `EventSource`, Svelte, React or Vue
// imports here. Framework adapters map this client onto stores/composables/hooks.

import type {
	CreateRunRequest,
	CreateRunResponse,
	RunId,
	RunnerEvent,
	RunSnapshot,
	WorkerSnapshot,
} from './shared.js'
import type { EventStream, Requester } from './transport.js'

export { parseSseFrames } from './transport.js'

export type { RunnerEvent, RunSnapshot, WorkerSnapshot }

export interface RemoteClientOptions {
	base: string
	requester: Requester
	stream: EventStream
}

export type ClientListener = () => void

/** Applies one event to a snapshot map. Exported for tests and custom stores. */
export function applyEvent(
	workers: Map<string, WorkerSnapshot>,
	event: RunnerEvent
): Map<string, WorkerSnapshot> {
	if (event.type === 'snapshot') {
		workers.clear()
		for (const w of event.snapshot.workers) workers.set(w.key, w)
	}
	return workers
}

/** Parses one SSE `data` payload into a {@link RunnerEvent}. */
export function parseRunnerEvent(type: string, data: string, id?: string): RunnerEvent | undefined {
	const seq = Number(id ?? 0) || 0
	let body: any = {}
	if (data) {
		try {
			body = JSON.parse(data)
		} catch {
			return undefined
		}
	}
	switch (type) {
		case 'snapshot':
			return body?.runId && Array.isArray(body?.workers)
				? { seq, type: 'snapshot', snapshot: body }
				: undefined
		case 'input-required':
			return body?.ioId ? { seq, type: 'input-required', ioId: body.ioId } : undefined
		case 'input-provided':
			return body?.ioId ? { seq, type: 'input-provided', ioId: body.ioId } : undefined
		case 'done':
			return { seq, type: 'done' }
		case 'error':
			return { seq, type: 'error', message: String(body?.message ?? 'Unknown error') }
		default:
			return undefined
	}
}

export class RemoteRunnerClient {
	readonly base: string
	private readonly requester: Requester
	private readonly stream: EventStream
	private readonly listeners = new Set<ClientListener>()
	private unsubscribeSse?: () => void

	runId?: RunId
	snapshot?: RunSnapshot
	readonly workers = new Map<string, WorkerSnapshot>()
	readonly pendingInputs = new Set<string>()
	readonly errors: string[] = []
	done = false
	lastSeq = 0

	constructor(opts: RemoteClientOptions) {
		this.base = opts.base.replace(/\/$/, '')
		this.requester = opts.requester
		this.stream = opts.stream
	}

	/** Subscribe to state changes. Returns an unsubscribe function. */
	onChange(listener: ClientListener): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener()
	}

	/** `POST {base}` — starts a run and opens the SSE stream. */
	async start(req: CreateRunRequest): Promise<RunId> {
		this.reset()
		const { runId } = await this.requester.post<CreateRunResponse>(this.base, req)
		this.runId = runId
		await this.refresh()
		this.connect()
		return runId
	}

	/** `GET {base}/{runId}` — full snapshot refresh (also used on reconnect). */
	async refresh(): Promise<void> {
		if (!this.runId) throw new Error('No run started')
		const snapshot = await this.requester.get<RunSnapshot>(`${this.base}/${this.runId}`)
		this.ingestSnapshot(snapshot)
	}

	/** Attaches to `GET {base}/{runId}/events` with `?from=` resume. */
	connect(): void {
		if (!this.runId) throw new Error('No run started')
		this.disconnect()
		this.unsubscribeSse = this.stream.subscribe(
			`${this.base}/${this.runId}/events`,
			(frame) => {
				const event = parseRunnerEvent(frame.type, frame.data, frame.id)
				if (event) this.ingest(event)
			},
			{ from: this.lastSeq }
		)
	}

	disconnect(): void {
		this.unsubscribeSse?.()
		this.unsubscribeSse = undefined
	}

	/** `POST {base}/{runId}/input` — resolves a pending `TaskIO` query. */
	async sendInput(ioId: string, value: unknown): Promise<void> {
		if (!this.runId) throw new Error('No run started')
		await this.requester.post(`${this.base}/${this.runId}/input`, { ioId, value })
	}

	/** `DELETE {base}/{runId}` — disposes server state and closes the stream. */
	async dispose(): Promise<void> {
		if (!this.runId) return
		this.disconnect()
		await this.requester.del(`${this.base}/${this.runId}`)
		this.runId = undefined
	}

	/** Ingests one ordered event (`status_{t+1} = apply(status_t, event_t)`). */
	ingest(event: RunnerEvent): void {
		if (event.seq <= this.lastSeq) return
		this.lastSeq = event.seq
		switch (event.type) {
			case 'snapshot':
				this.ingestSnapshot(event.snapshot)
				break
			case 'input-required':
				this.pendingInputs.add(event.ioId)
				break
			case 'input-provided':
				this.pendingInputs.delete(event.ioId)
				break
			case 'done':
				this.done = true
				break
			case 'error':
				this.errors.push(event.message)
				break
		}
		applyEvent(this.workers, event)
		this.notify()
	}

	private ingestSnapshot(snapshot: RunSnapshot): void {
		this.snapshot = snapshot
		this.workers.clear()
		for (const w of snapshot.workers) this.workers.set(w.key, w)
		if (snapshot.seq > this.lastSeq) this.lastSeq = snapshot.seq
		this.errors.length = 0
		this.errors.push(...snapshot.errors)
		// Snapshots are authoritative for pending inputs: an `input-required`
		// event may predate the snapshot `seq` (skipped by `?from=` resume),
		// so reconcile instead of only tracking events.
		this.pendingInputs.clear()
		for (const ioId of snapshot.pendingInputs ?? []) this.pendingInputs.add(ioId)
		this.notify()
	}

	private reset(): void {
		this.disconnect()
		this.runId = undefined
		this.snapshot = undefined
		this.workers.clear()
		this.pendingInputs.clear()
		this.errors.length = 0
		this.done = false
		this.lastSeq = 0
	}
}
