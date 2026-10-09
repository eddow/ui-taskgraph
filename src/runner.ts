export interface IWorkerStatus {
	readonly advance: number
	prefix?: string
	text?: string
	pause: string | false
}

export type IWorkerTask<Status extends IWorkerStatus = IWorkerStatus> = (
	status: Status,
	group: ATaskGroup<Status, AGroupRunner<Status>, IWorkerTask<Status>>
) => Promise<void>
type Pointer<
	Status extends IWorkerStatus,
	GroupRunnerType extends AGroupRunner<Status>,
	WorkerTask extends IWorkerTask<Status>,
> = {
	readonly task: WorkerTask
	readonly group: ATaskGroup<Status, GroupRunnerType, WorkerTask>
}
type PointerGen<
	Status extends IWorkerStatus,
	GroupRunnerType extends AGroupRunner<Status>,
	WorkerTask extends IWorkerTask<Status>,
> = {
	next(): IteratorResult<Pointer<Status, GroupRunnerType, WorkerTask>>
}

export abstract class ATaskGroup<
	Status extends IWorkerStatus,
	GroupRunnerType extends AGroupRunner<Status>,
	WorkerTask extends IWorkerTask<Status>,
> {
	abstract readonly runner: TasksRunner<Status>
	infos: Record<string, string> = {}
	#finished: Promise<void> = Promise.resolve()
	get finished() {
		return this.#finished
	}
	get running() {
		return !!this.#resolveRunner
	}
	readonly active = new Map<Status, GroupRunnerType | undefined>()
	#resolveRunner?: () => void
	wrapEach?: (task: () => Promise<void>, workerStatus: Status) => Promise<void>
	protected startRun() {
		if (!this.#resolveRunner)
			this.#finished = new Promise((resolve) => {
				this.#resolveRunner = () => {
					this.#resolveRunner = undefined
					resolve()
				}
			})
	}
	protected endRun() {
		if (this.#resolveRunner) {
			this.#resolveRunner!()
			this.#resolveRunner = undefined
		}
	}
	start(workers: WorkerTask | Iterable<WorkerTask>) {
		register(this.runner, asIterable(workers, this))
	}
	async launched(worker: WorkerTask, status: Status) {
		if (!this.#resolveRunner) this.startRun()
		try {
			this.active.set(status, undefined)
			await (this.wrapEach
				? this.wrapEach!(() => worker(status, this), status)
				: worker(status, this))
		} catch (x: any) {
			this.runner.reportWorkerError(x, worker)
		}
		this.active.delete(status)
		if (!this.active.size) this.endRun()
	}
}
function asIterable<Status extends IWorkerStatus, WorkerTask extends IWorkerTask<Status>>(
	iterable: WorkerTask | Iterable<WorkerTask>,
	group: ATaskGroup<Status, AGroupRunner<Status>, WorkerTask>
): PointerGen<Status, AGroupRunner<Status>, WorkerTask> {
	if (typeof iterable === 'function') iterable = [iterable]
	return (function* () {
			for (const item of iterable) yield { task: item, group }
		})()[Symbol.iterator]()
}

export abstract class AGroupRunner<
	Status extends IWorkerStatus = IWorkerStatus,
	WorkerTask extends IWorkerTask<Status> = IWorkerTask<Status>,
> extends ATaskGroup<Status, AGroupRunner<Status>, WorkerTask> {
	readonly runner: TasksRunner<Status>
	constructor(
		readonly parent: ATaskGroup<Status, AGroupRunner<Status>, WorkerTask>,
		workers?: WorkerTask | Iterable<WorkerTask>
	) {
		super()
		this.runner = parent.runner
		if (workers) this.start(workers)
	}
	abstract readonly status: Status
	#wrappedFinished: Promise<void> = super.finished
	get finished() {
		return this.#wrappedFinished
	}
	wrapAll?: (task: () => Promise<void>, groupStatus: Status) => Promise<void>
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
	Status extends IWorkerStatus = IWorkerStatus,
	GroupRunner extends AGroupRunner<Status> = AGroupRunner<Status>,
	WorkerTask extends IWorkerTask<Status> = IWorkerTask<Status>,
> extends ATaskGroup<Status, GroupRunner, WorkerTask> {
	get runner() {
		return this
	}
	abstract reportWorkerError(error: any, worker: WorkerTask): void
	private readonly iterators: PointerGen<Status, GroupRunner, WorkerTask>[] = []
	protected abstract newStatus(): Status
	#concurrent: number = 5
	readonly workers = new Map<Status, ATaskGroup<Status, GroupRunner, WorkerTask>>()
	get concurrent() {
		;``
		return this.#concurrent
	}
	set concurrent(value: number) {
		this.#concurrent = value
		this.ensureWorkers()
	}

	private ensureWorkers() {
		const runWorker = async (pointer: Pointer<Status, GroupRunner, WorkerTask>, status: Status) => {
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
