import type { RequireParams } from './task-sync.js'
import * as generic from './task-sync.js'

export { TaskSyncError } from './task-sync.js'

export type Semaphore<WorkerStatus extends AWorkerStatus> = generic.Semaphore<WorkerStatus>
export const Semaphore = generic.Semaphore<AWorkerStatus>
export type TaskIO<T> = generic.TaskIO<AWorkerStatus, T>
export const TaskIO = generic.TaskIO

// TODO: detect deadlocks
// TODO: manage concurrent infinite tasks generator
export abstract class AWorkerStatus {
	prefix?: string
	text?: string
	progressMax = 1
	currentProgress = NaN
	progress(value?: number, max?: number) {
		if (max) this.progressMax = max
		if (value !== undefined)
			this.currentProgress = Math.min(1, Math.max(0, value / this.progressMax))
		return this.currentProgress
	}
	require<T extends RequireParams<typeof this>>(tio: T) {
		return generic.require(this, tio)
	}
	acquire(...semaphores: Semaphore<AWorkerStatus>[]) {
		return generic.acquire(this, ...semaphores)
	}
	abstract waitInput(promise: Promise<void>): void
	#waitingInput?: () => void
	get waitingInput() {
		return !!this.#waitingInput
	}
	set waitingInput(value: boolean) {
		if (value && !this.#waitingInput) {
			this.waitInput(
				new Promise((resolve) => {
					this.#waitingInput = resolve
				})
			)
		} else if (!value && this.#waitingInput) {
			this.#waitingInput()
			this.#waitingInput = undefined
		}
	}
}

export type IWorkerTask<WorkerStatus extends AWorkerStatus = AWorkerStatus> = (_: {
	status: WorkerStatus
	group: ATaskGroup<
		WorkerStatus,
		IWorkerTask<WorkerStatus>,
		AGroupRunner<WorkerStatus, IWorkerTask<WorkerStatus>>
	>
}) => Promise<void>
type Pointer<
	WorkerStatus extends AWorkerStatus,
	WorkerTask extends IWorkerTask<WorkerStatus>,
	GroupRunner extends AGroupRunner<WorkerStatus, WorkerTask>,
> = {
	readonly task: WorkerTask
	readonly group: ATaskGroup<WorkerStatus, WorkerTask, GroupRunner>
}
type PointerGen<
	WorkerStatus extends AWorkerStatus,
	WorkerTask extends IWorkerTask<WorkerStatus>,
	GroupRunner extends AGroupRunner<WorkerStatus, WorkerTask>,
> = {
	next(): IteratorResult<Pointer<WorkerStatus, WorkerTask, GroupRunner>>
}

export abstract class ATaskGroup<
	WorkerStatus extends AWorkerStatus,
	WorkerTask extends IWorkerTask<WorkerStatus>,
	GroupRunner extends AGroupRunner<WorkerStatus, WorkerTask>,
> {
	abstract readonly runner: TasksRunner<WorkerStatus, WorkerTask, GroupRunner>
	infos: Record<string, string> = {}
	#finished: Promise<void> = Promise.resolve()
	get finished() {
		return this.#finished
	}
	get running() {
		return !!this.#resolveRunner
	}
	readonly active = new Map<WorkerStatus, GroupRunner | undefined>()
	#resolveRunner?: () => void
	wrapEach?: (task: () => Promise<void>, workerStatus: WorkerStatus) => Promise<void>
	protected startRun() {
		if (this.#resolveRunner) return
		this.#finished = new Promise((resolve) => {
			this.#resolveRunner = () => {
				this.#resolveRunner = undefined
				resolve()
			}
		})
	}
	protected endRun() {
		if (!this.#resolveRunner) return
		this.#resolveRunner!()
		this.#resolveRunner = undefined
	}
	start(workers: WorkerTask | Iterable<WorkerTask>) {
		register(this.runner, asIterable(workers, this))
	}
	async launched(worker: WorkerTask, status: WorkerStatus) {
		if (!this.#resolveRunner) this.startRun()
		try {
			this.active.set(status, undefined)
			const arg = { status, group: this }
			generic.registerTaskSpace(status)
			await (this.wrapEach ? this.wrapEach!(() => worker(arg), status) : worker(arg))
		} catch (x: any) {
			this.runner.reportWorkerError(x, worker)
		}
		this.active.delete(status)
		if (!this.active.size) this.endRun()
	}
}
function asIterable<
	WorkerStatus extends AWorkerStatus,
	WorkerTask extends IWorkerTask<WorkerStatus>,
>(
	iterable: WorkerTask | Iterable<WorkerTask>,
	group: ATaskGroup<WorkerStatus, WorkerTask, AGroupRunner<WorkerStatus, WorkerTask>>
): PointerGen<WorkerStatus, WorkerTask, AGroupRunner<WorkerStatus, WorkerTask>> {
	if (typeof iterable === 'function') iterable = [iterable]
	return (function* () {
		for (const item of iterable) yield { task: item, group }
	})()[Symbol.iterator]()
}

export abstract class AGroupRunner<
	WorkerStatus extends AWorkerStatus,
	WorkerTask extends IWorkerTask<WorkerStatus>,
> extends ATaskGroup<WorkerStatus, WorkerTask, AGroupRunner<WorkerStatus, WorkerTask>> {
	readonly runner: TasksRunner<WorkerStatus, WorkerTask, AGroupRunner<WorkerStatus, WorkerTask>>
	constructor(
		readonly parent: ATaskGroup<WorkerStatus, WorkerTask, AGroupRunner<WorkerStatus, WorkerTask>>,
		workers?: WorkerTask | Iterable<WorkerTask>
	) {
		super()
		this.runner = parent.runner
		if (workers) this.start(workers)
	}
	abstract readonly status: WorkerStatus
	#wrappedFinished: Promise<void> = super.finished
	get finished() {
		return this.#wrappedFinished
	}
	wrapAll?: (task: () => Promise<void>, groupStatus: WorkerStatus) => Promise<void>
	protected startRun() {
		const started = () => {
			super.startRun()
			return super.finished
		}
		this.#wrappedFinished = this.wrapAll?.(started, this.status) || started()
		this.parent.active.set(this.status, this)
	}
	protected endRun(): void {
		super.endRun()
		this.parent.active.delete(this.status)
	}
}

export abstract class TasksRunner<
	WorkerStatus extends AWorkerStatus,
	WorkerTask extends IWorkerTask<WorkerStatus>,
	GroupRunner extends AGroupRunner<WorkerStatus, WorkerTask>,
> extends ATaskGroup<WorkerStatus, WorkerTask, GroupRunner> {
	get runner() {
		return this
	}
	abstract reportWorkerError(error: any, worker: WorkerTask): void
	private readonly iterators: PointerGen<WorkerStatus, WorkerTask, GroupRunner>[] = []
	protected abstract newStatus(): WorkerStatus
	#concurrent: number = 5
	readonly workers = new Map<WorkerStatus, ATaskGroup<WorkerStatus, WorkerTask, GroupRunner>>()
	get concurrent() {
		;``
		return this.#concurrent
	}
	set concurrent(value: number) {
		this.#concurrent = value
		this.ensureWorkers()
	}

	private ensureWorkers() {
		const runWorker = async (
			pointer: Pointer<WorkerStatus, WorkerTask, GroupRunner>,
			status: WorkerStatus
		) => {
			await pointer.group.launched(pointer.task, status)
			this.workers.delete(status)
			this.ensureWorkers()
		}
		while (this.workers.size < this.#concurrent) {
			let next = this.iterators[0]?.next()
			while (next?.done) {
				this.iterators.shift()
				next = this.iterators[0]?.next()
			}
			if (!next || next.done) break
			const status = this.newStatus()
			const pointer = next.value
			if (!status.text) status.text = pointer.task.name
			this.workers.set(status, pointer.group)
			runWorker(pointer, status)
		}
		if (!this.workers.size) this.endRun()
	}
	start(workers: WorkerTask | Iterable<WorkerTask>, setConcurrent?: number) {
		if (setConcurrent !== undefined) this.#concurrent = setConcurrent
		super.start(workers)
	}
}
//#region Internal to the library

function register(runner: any, iterable: PointerGen<any, any, any>) {
	runner.iterators.push(iterable)
	runner.startRun()
	runner.ensureWorkers()
}

//#endregion
