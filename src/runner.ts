

export interface IWorkerStatus {
	readonly advance: number
	prefix?: string
	text?: string
	pause: string | false
}

export type IWorkerTask<Status extends IWorkerStatus = IWorkerStatus> = (status: Status) => Promise<void>
export const Spinning = Symbol('spinning')

export abstract class TaskGroup<Status extends IWorkerStatus = IWorkerStatus> {
	#finished: Promise<void>
	get finished() {
		return this.#finished
	}
	constructor() {
		this.#finished = Promise.resolve()
	}
	readonly active: Status[] = []
	#resolveRunner?: () => void
	protected startRun() {
		if (!this.#resolveRunner) {
			this.#finished = new Promise((resolve) => {
				this.#resolveRunner = () => {
					this.#resolveRunner = undefined
					resolve()
				}
			})
		}
	}
	protected endRun() {
		this.#resolveRunner?.()
	}
}
export abstract class GroupRunner<Status extends IWorkerStatus = IWorkerStatus> extends TaskGroup<Status> {
	abstract readonly status: Status
}
export abstract class TasksRunner<Status extends IWorkerStatus = IWorkerStatus> extends TaskGroup<Status> {
	protected abstract reportWorkerError(error: any, worker: IWorkerTask<Status>): void
	protected abstract newStatus(): Status
	#concurrent: number = 5
	readonly workers: Status[] = []
	readonly #iterators: Iterator<IWorkerTask<Status>>[] = []

	#ensureWorkers() {
		const wrapWorker = async (worker: IWorkerTask<Status>, status: Status) => {
			try {
				await worker(status)
			} catch (x: any) {
				this.reportWorkerError(x, worker)
			}
			const ndx = this.workers.indexOf(status)
			if (ndx !== -1) this.workers.splice(ndx, 1)
			this.#ensureWorkers()
		}
		while (this.workers.length < this.#concurrent) {
			let next = this.#iterators[0]?.next()
			while (next?.done) {
				this.#iterators.shift()
				next = this.#iterators[0]?.next()
			}
			if (!next || next.done) break
			const status = this.newStatus()
			const worker = next.value
			if(!status.text) status.text = worker.name
			this.workers.push(status)
			wrapWorker(worker, status)
		}
		if (!this.workers.length) this.endRun()
	}
	get concurrent() {
		return this.#concurrent
	}
	set concurrent(value: number) {
		this.#concurrent = value
		this.#ensureWorkers()
	}
	start(iterable: IWorkerTask<Status> | Iterable<IWorkerTask<Status>>, setConcurrent?: number) {
		if (setConcurrent !== undefined) this.#concurrent = setConcurrent
		this.#iterators.push(
			typeof iterable === 'function'
				? { next: () => ({ value: iterable, done: false }) }
				: iterable[Symbol.iterator]()
		)
		this.startRun()
		this.#ensureWorkers()
	}
}