// Shared protocol types for web taskgraph execution.
//
// Framework-agnostic: no `fetch`, `EventSource`, Svelte, React or Vue imports here.

/** Opaque run identifier. One UUID per `start()`, in-memory scoped, no persistence (milestone 1). */
export type RunId = string

/** JSON-safe snapshot of a single worker status (`NaN` progress becomes `null` on the wire). */
export interface WorkerSnapshot {
	key: string
	groupKey?: string
	depth: number
	state: string
	icon?: string
	text?: string
	progress: number | null
	progressMax: number
	/** Derived from `state === 'waiting-input'`. Kept during migration. */
	waitingInput: boolean
}

/** JSON-safe snapshot of a whole run. */
export interface RunSnapshot {
	runId: RunId
	task: string
	running: boolean
	infos: Record<string, string>
	errors: string[]
	workers: WorkerSnapshot[]
	/** `TaskIO` ids currently awaiting `provideInput` (JSON pass-through, no schema). */
	pendingInputs: string[]
	/** Sequence number of the latest event included in this snapshot. */
	seq: number
}

/**
 * Ordered events emitted per run. `seq` is monotonic per `runId` and is used
 * as the SSE `id` for `Last-Event-ID` resume.
 *
 * `status_{t+1} = apply(status_t, event_t)` on the client.
 */
export type RunnerEvent =
	| { seq: number; type: 'snapshot'; snapshot: RunSnapshot }
	| { seq: number; type: 'input-required'; ioId: string }
	| { seq: number; type: 'input-provided'; ioId: string }
	| { seq: number; type: 'done' }
	| { seq: number; type: 'error'; message: string }

/** Body of `POST {base}` — creates a run. */
export interface CreateRunRequest {
	task: string
	params?: unknown
	concurrent?: number
}

/** Body returned by `POST {base}`. */
export interface CreateRunResponse {
	runId: RunId
}

/** Body of `POST {base}/{runId}/input` — JSON pass-through, no schema validation (milestone 1). */
export interface ProvideInputRequest {
	ioId: string
	value: unknown
}

/**
 * A {@link RunnerEvent} without the server-assigned `seq` (used when emitting).
 * Distributed over the union so each variant keeps its own required fields.
 */
export type RunnerEventInput = {
	[K in RunnerEvent['type']]: Omit<Extract<RunnerEvent, { type: K }>, 'seq'>
}[RunnerEvent['type']]
