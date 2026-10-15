// Framework-agnostic back-end for web taskgraph execution.
//
// `RemoteRunnerRegistry` creates and follows task-runners. It is explicitly
// *not* a singleton: one registry holds many concurrent runs (`Map<RunId, …>`),
// each run owning its own `TasksRunner` instance and its own execution unit
// (so `TaskIO` ids are scoped per run).
//
// No `fetch`, `EventSource`, Svelte, React or Vue imports here — the HTTP/SSE
// wire mapping lives in `http.ts`, framework adapters only translate their
// native request/response objects to standard `Request`/`Response`.

import { AGroupRunner, AWorkerStatus, type IWorkerTask, TasksRunner } from '../runner.js'
import {
	GenericSemaphore,
	GenericTaskIO,
	localExecutionUnit,
	type LocalExecutionUnit,
	type LocalExecutionUnitOptions,
	type TaskIOUnit,
	TaskSyncError,
} from '../task-sync.js'
import type {
	CreateRunRequest,
	ProvideInputRequest,
	RunId,
	RunnerEvent,
	RunnerEventInput,
	RunSnapshot,
	WorkerSnapshot,
} from './shared.js'

export type { CreateRunRequest, ProvideInputRequest }

//#region Headless runner (default, no visuals)

export type RemoteWorkerTask = IWorkerTask<RemoteWorkerStatus>

/** Plain status: `waitInput` just awaits the promise, no UI hooks. */
export class RemoteWorkerStatus extends AWorkerStatus {
	async waitInput(promise: Promise<void>): Promise<void> {
		await promise
	}
}

export class RemoteGroupRunner extends AGroupRunner<RemoteWorkerStatus, RemoteWorkerTask> {
	readonly status: RemoteWorkerStatus
	constructor(
		parent: ConstructorParameters<typeof AGroupRunner<RemoteWorkerStatus, RemoteWorkerTask>>[0],
		text?: string,
		workers?: RemoteWorkerTask | Iterable<RemoteWorkerTask>
	) {
		super(parent, workers)
		this.status = new RemoteWorkerStatus()
		if (text) this.status.text = text
	}
}

export interface RunnerHooks {
	onError(error: unknown): void
}

/** Concrete non-singleton runner used by default (one instance per run). */
export class RemoteRunner extends TasksRunner<
	RemoteWorkerStatus,
	RemoteWorkerTask,
	RemoteGroupRunner
> {
	constructor(private readonly hooks?: RunnerHooks) {
		super()
	}
	reportWorkerError(error: unknown): void {
		this.hooks?.onError(error)
	}
	protected newStatus(): RemoteWorkerStatus {
		return new RemoteWorkerStatus()
	}
}

//#endregion
//#region Task factories

/** Anything a task factory may return; kept loose on purpose (see `TaskFactory`). */
export type AnyWorkerTask = (_: { status: any; group: any }) => Promise<void>

/** Per-run execution context handed to task factories. */
export interface RunContext {
	runId: RunId
	params: unknown
	/**
	 * Run-scoped semaphore/task-I/O classes. Both are bound to the run's own
	 * local unit, so `Semaphore`/`TaskIO` ids live only within this run and
	 * concurrent runs of the same task never share state. Factories must use
	 * these classes — the raw units are never exposed.
	 */
	Semaphore: ReturnType<typeof GenericSemaphore>
	TaskIO: ReturnType<typeof GenericTaskIO>
	/**
	 * Client-backed task-I/O class, bound to the run's `clientInputUnit`.
	 * `query` asks the browser client over SSE; BE code must never `provide`
	 * (values arrive through `provideInput`). May be mixed freely with the
	 * local `TaskIO` — each instance carries its own unit.
	 */
	ClientIO: ReturnType<typeof GenericTaskIO>
	/** The run's own runner (root group) — combine with `GroupRunner` for nested groups. */
	runner: TasksRunner<any, any, any>
	GroupRunner: typeof RemoteGroupRunner
}

/**
 * Builds the workers of one run. Factories are registered under a task name
 * (`registerTask`) and receive a run-scoped context, so the same task can run
 * concurrently in many runs without sharing `TaskIO` state.
 */
export type TaskFactory = (ctx: RunContext) => AnyWorkerTask | Iterable<AnyWorkerTask>

//#endregion
//#region Registry

export interface RegistryOptions {
	/** How often to poll runners for status changes (ms). Default `150`. */
	pollMs?: number
	/** How long finished runs are kept for snapshot/event replay (ms). Default `5 * 60_000`. */
	ttlMs?: number
	/** Maximum buffered events per run (replay window). Default `500`. */
	maxEvents?: number
	/**
	 * How long a client input may stay pending before the worker's `query`
	 * rejects (`TaskSyncError`). `0` disables. Default `10 * 60_000`.
	 */
	inputTimeoutMs?: number
	/** Override the runner implementation (default: headless {@link RemoteRunner}). */
	newRunner?: (hooks: RunnerHooks) => TasksRunner<any, any, any>
	/**
	 * Max concurrent holders per semaphore id for the run's local unit
	 * (e.g. `{ serp: 3 }`). Unknown ids default to 1. Mutable per run via
	 * `record.localUnit.freeInstances` — see {@link LocalExecutionUnit}.
	 */
	freeInstances?: LocalExecutionUnitOptions['freeInstances']
}

type RunRecord = {
	runId: RunId
	task: string
	runner: TasksRunner<any, any, any>
	localUnit: LocalExecutionUnit
	inputUnit: TaskIOUnit & {
		resolve(ioId: string, value: unknown): void
		rejectAll(error: unknown): void
	}
	pendingInputs: Set<string>
	events: RunnerEvent[]
	seq: number
	listeners: Set<(event: RunnerEvent) => void>
	errors: string[]
	keys: Map<object, string>
	nextKey: number
	lastSnapshotJson: string
	pollTimer?: ReturnType<typeof setInterval>
	ttlTimer?: ReturnType<typeof setTimeout>
	done: boolean
}

function unref(timer: unknown): void {
	;(timer as { unref?: () => void } | undefined)?.unref?.()
}

export class UnknownRunError extends Error {}
export class UnknownTaskError extends Error {}
export class UnknownInputError extends Error {}

/**
 * Non-singleton registry of task-runner instances.
 *
 * Lifecycle per run: `create` → (`snapshot` | `subscribe` | `provideInput`)*
 * → `done` → TTL expiry → `dispose` (or explicit `dispose` via `DELETE`).
 */
export class RemoteRunnerRegistry {
	readonly pollMs: number
	readonly ttlMs: number
	readonly maxEvents: number
	readonly inputTimeoutMs: number
	readonly freeInstances: LocalExecutionUnitOptions['freeInstances']
	private readonly runs = new Map<RunId, RunRecord>()
	private readonly tasks = new Map<string, TaskFactory>()
	private readonly newRunner: (hooks: RunnerHooks) => TasksRunner<any, any, any>

	constructor(opts: RegistryOptions = {}) {
		this.pollMs = opts.pollMs ?? 150
		this.ttlMs = opts.ttlMs ?? 5 * 60_000
		this.maxEvents = opts.maxEvents ?? 500
		this.inputTimeoutMs = opts.inputTimeoutMs ?? 10 * 60_000
		this.freeInstances = opts.freeInstances
		this.newRunner = opts.newRunner ?? ((hooks) => new RemoteRunner(hooks))
	}

	/** Registers a task factory under `name` (`POST {base}` with `{ task: name }` starts it). */
	registerTask(name: string, factory: TaskFactory): void {
		this.tasks.set(name, factory)
	}

	hasTask(name: string): boolean {
		return this.tasks.has(name)
	}

	listTasks(): string[] {
		return [...this.tasks.keys()]
	}

	/** Starts a new run and returns its opaque {@link RunId}. */
	create(req: CreateRunRequest): RunId {
		const factory = this.tasks.get(req.task)
		if (!factory) throw new UnknownTaskError(`Unknown task: ${req.task}`)
		const runId: RunId = crypto.randomUUID()
		const record: RunRecord = {
			runId,
			task: req.task,
			runner: undefined as unknown as TasksRunner<any, any, any>,
			localUnit: localExecutionUnit({ freeInstances: this.freeInstances }),
			inputUnit: undefined as unknown as RunRecord['inputUnit'],
			pendingInputs: new Set<string>(),
			events: [],
			seq: 0,
			listeners: new Set(),
			errors: [],
			keys: new Map(),
			nextKey: 1,
			lastSnapshotJson: '',
			done: false,
		}
		record.inputUnit = this.clientInputUnit(record)
		record.runner = this.newRunner({
			onError: (error) => {
				const message = error instanceof Error ? error.message : JSON.stringify(error)
				record.errors.push(message)
				this.emit(record, { type: 'error', message })
				this.emitSnapshot(record)
			},
		})
		this.runs.set(runId, record)
		const ctx: RunContext = {
			runId,
			params: req.params,
			Semaphore: GenericSemaphore(record.localUnit),
			TaskIO: GenericTaskIO(record.localUnit),
			ClientIO: GenericTaskIO(record.inputUnit),
			runner: record.runner,
			GroupRunner: RemoteGroupRunner,
		}
		const produced = factory(ctx) as AnyWorkerTask | Iterable<AnyWorkerTask>
		const workers =
			typeof produced === 'function'
				? [produced as IWorkerTask<any>]
				: [...(produced as Iterable<IWorkerTask<any>>)]
		record.runner.start(workers, req.concurrent)
		this.emitSnapshot(record)
		record.pollTimer = setInterval(() => this.poll(record), this.pollMs)
		unref(record.pollTimer)
		record.runner.finished.then(
			() => this.finish(record),
			(error) => {
				record.errors.push(error instanceof Error ? error.message : String(error))
				this.finish(record)
			}
		)
		return runId
	}

	/** Current snapshot of a run (throws {@link UnknownRunError}). */
	getSnapshot(runId: RunId): RunSnapshot {
		return this.snapshot(this.require(runId))
	}

	/** Events with `seq > from` (for `Last-Event-ID` / `?from=` resume). */
	eventsSince(runId: RunId, from = 0): RunnerEvent[] {
		return this.require(runId).events.filter((e) => e.seq > from)
	}

	/**
	 * Live subscription: replays missed events, then pushes new ones.
	 * Returns an unsubscribe function.
	 */
	subscribe(runId: RunId, listener: (event: RunnerEvent) => void, from = 0): () => void {
		const record = this.require(runId)
		for (const event of record.events.filter((e) => e.seq > from)) listener(event)
		record.listeners.add(listener)
		return () => {
			record.listeners.delete(listener)
		}
	}

	/**
	 * Resolves a pending client input (JSON pass-through, no validation in
	 * milestone 1). Goes through the input unit's internal `resolve` — never
	 * `TaskIOUnit.provide`, which throws by design (BE code must never
	 * provide client input; values only arrive here).
	 */
	provideInput(runId: RunId, req: ProvideInputRequest): void {
		const record = this.require(runId)
		if (!record.pendingInputs.has(req.ioId))
			throw new UnknownInputError(`Unknown input: ${req.ioId}`)
		record.inputUnit.resolve(req.ioId, req.value)
	}

	/** Drops all server state for a run (running tasks are left detached). */
	dispose(runId: RunId): void {
		const record = this.runs.get(runId)
		if (!record) return
		clearInterval(record.pollTimer)
		clearTimeout(record.ttlTimer)
		record.listeners.clear()
		record.inputUnit.rejectAll(new TaskSyncError(`run disposed: ${runId}`))
		this.runs.delete(runId)
	}

	has(runId: RunId): boolean {
		return this.runs.has(runId)
	}

	private require(runId: RunId): RunRecord {
		const record = this.runs.get(runId)
		if (!record) throw new UnknownRunError(`Unknown run: ${runId}`)
		return record
	}

	private emit(record: RunRecord, event: RunnerEventInput): RunnerEvent {
		const full = { ...event, seq: ++record.seq } as RunnerEvent
		record.events.push(full)
		if (record.events.length > this.maxEvents)
			record.events.splice(0, record.events.length - this.maxEvents)
		for (const listener of [...record.listeners]) listener(full)
		return full
	}

	private keyFor(record: RunRecord, obj: object): string {
		let key = record.keys.get(obj)
		if (!key) {
			key = `w${record.nextKey++}`
			record.keys.set(obj, key)
		}
		return key
	}

	private snapshot(record: RunRecord): RunSnapshot {
		const workers: WorkerSnapshot[] = []
		const walk = (
			group: { active: Map<any, any>; infos?: Record<string, string> },
			depth: number,
			groupKey?: string
		) => {
			for (const [status, sub] of group.active) {
				const key = this.keyFor(record, status)
				const progress = status.progress()
				workers.push({
					key,
					groupKey,
					depth,
					state: status.state ?? 'active',
					icon: status.icon,
					text: status.text,
					progress: Number.isNaN(progress) ? null : progress,
					progressMax: status.progressMax ?? 1,
					waitingInput: !!status.waitingInput,
				})
				if (sub) walk(sub, depth + 1, key)
			}
		}
		walk(record.runner, 0)
		return {
			runId: record.runId,
			task: record.task,
			running: record.runner.running,
			infos: { ...record.runner.infos },
			errors: [...record.errors],
			workers,
			pendingInputs: [...record.pendingInputs],
			seq: record.seq,
		}
	}

	private emitSnapshot(record: RunRecord): void {
		const snapshot = this.snapshot(record)
		const { seq: _omit, ...body } = snapshot
		const json = JSON.stringify(body)
		if (json === record.lastSnapshotJson) return
		record.lastSnapshotJson = json
		this.emit(record, { type: 'snapshot', snapshot: { ...body, seq: record.seq + 1 } })
	}

	private poll(record: RunRecord): void {
		if (record.done || !this.runs.has(record.runId)) {
			clearInterval(record.pollTimer)
			return
		}
		this.emitSnapshot(record)
	}

	private finish(record: RunRecord): void {
		if (record.done) return
		record.done = true
		clearInterval(record.pollTimer)
		this.emitSnapshot(record)
		this.emit(record, { type: 'done' })
		record.ttlTimer = setTimeout(() => this.dispose(record.runId), this.ttlMs)
		unref(record.ttlTimer)
	}

	/**
	 * Client-backed `TaskIOUnit` for one run. Standalone — it wraps nothing:
	 * `query` notifies the client (`input-required` event + snapshot pending
	 * set) and returns a promise settled by `provideInput` (via the internal
	 * `resolve` side channel) or by the input timeout. `provide` throws: BE
	 * code must never provide client input.
	 */
	private clientInputUnit(record: RunRecord): RunRecord['inputUnit'] {
		type Waiter = {
			resolve(value: unknown): void
			reject(error: unknown): void
			timer?: ReturnType<typeof setTimeout>
		}
		// Several `query` calls may target the same ioId (e.g. two `require`
		// of one TaskIO) — every waiter must settle, like the shared promise
		// of the local unit.
		const waiters = new Map<string, Set<Waiter>>()
		const settle = (ioId: string, done: (waiter: Waiter) => void) => {
			const set = waiters.get(ioId)
			if (!set) return
			waiters.delete(ioId)
			record.pendingInputs.delete(ioId)
			for (const waiter of set) {
				clearTimeout(waiter.timer)
				done(waiter)
			}
		}
		const fail = (ioId: string, error: unknown, silent = false) => {
			const message = error instanceof Error ? error.message : String(error)
			settle(ioId, (waiter) => waiter.reject(error))
			if (silent) return
			record.errors.push(message)
			this.emit(record, { type: 'error', message })
			this.emitSnapshot(record)
		}
		const unit: TaskIOUnit = {
			uid: `client-input-${record.runId}`,
			query: (ioId: string) => {
				if (!waiters.has(ioId)) {
					waiters.set(ioId, new Set())
					record.pendingInputs.add(ioId)
					this.emit(record, { type: 'input-required', ioId })
					this.emitSnapshot(record)
				}
				return new Promise((resolve, reject) => {
					const timer =
						this.inputTimeoutMs > 0
							? setTimeout(
									() => fail(ioId, new TaskSyncError(`input timed out: ${ioId}`)),
									this.inputTimeoutMs
								)
							: undefined
					if (timer) unref(timer)
					waiters.get(ioId)!.add({ resolve, reject, timer })
				})
			},
			provide: () => {
				throw new TaskSyncError(
					'BE code must never provide client input; values arrive via provideInput()'
				)
			},
		}
		return Object.assign(unit, {
			resolve: (ioId: string, value: unknown) => {
				settle(ioId, (waiter) => waiter.resolve(value))
				this.emit(record, { type: 'input-provided', ioId })
				this.emitSnapshot(record)
			},
			rejectAll: (error: unknown) => {
				for (const ioId of [...waiters.keys()]) fail(ioId, error, true)
			},
		})
	}
}

//#endregion
