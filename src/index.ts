function disposable<T extends {}>(
	disposer: () => void,
	org?: T
): T & { [Symbol.dispose]: () => void } {
	return Object.assign(org ?? ({} as T), { [Symbol.dispose]: disposer })
}

export class TaskSyncError extends Error {}

export class Semaphore {
	constructor(
		readonly order: number,
		readonly name?: string
	) {
		Object.freeze(this)
	}
}
let semaphoreOrder = 0
export function semaphore(name?: string) {
	return new Semaphore(++semaphoreOrder, name)
}

const allocations = new WeakMap<Semaphore, (() => void)[]>()
function allocate(semaphore: Semaphore) {
	if (!allocations.has(semaphore)) allocations.set(semaphore, [])
	else return new Promise<void>((resolve) => allocations.get(semaphore)!.push(resolve))
}
function free(semaphore: Semaphore) {
	const waiters = allocations.get(semaphore)
	if (waiters?.length) waiters.shift()!()
	else allocations.delete(semaphore)
}

export type TaskIO<T> = {
	name?: string
	readonly value?: T
	set(value: T): void
}

const tioPromises = new WeakMap<TaskIO<unknown>, Promise<unknown>>()
export function taskIO<T>(name?: string): TaskIO<T> {
	let resolve: (value: T) => void
	const rv = {
		set(value: T) {
			if ('value' in this) throw new TaskSyncError('Value is already set')
			Object.defineProperty(this, 'value', { value, writable: false, configurable: true })
			resolve!(value)
		},
	}
	if (name) Object.defineProperty(rv, 'name', { value: name, writable: false, configurable: true })
	tioPromises.set(
		rv,
		new Promise((r) => {
			resolve = r
		})
	)
	return rv
}
export type UnTIO<T> = {
	[K in keyof T]: T[K] extends TaskIO<infer V> ? V : T[K]
}
export type TaskSync = {
	semaphores(...semaphores: Semaphore[]): Promise<{}>
	input<T extends Record<string, TaskIO<unknown>> | TaskIO<unknown>[]>(
		tio: T
	): UnTIO<T> | Promise<UnTIO<T>>
}
/**
 * Creates a semaphore-space. Function allowing to allocate semaphores and wait for tasks I/O.
 * Semaphore-space can only be created to be given to async functions who are not going to be waited for where the space is created
 * @returns SemaphoreSpace
 */
export function taskSync(): TaskSync {
	let semaphores: Semaphore[] = []
	return {
		semaphores: async (
			_first: Semaphore | Record<string, TaskIO<unknown>>,
			...newS: Semaphore[]
		) => {
			const oldS = semaphores
			semaphores = [...oldS, ...newS]
				.sort((a, b) => a.order - b.order)
				.reduce(
					(acc, s) => ({
						lastOrder: s.order,
						coll: acc.lastOrder === s.order ? acc.coll : [...acc.coll, s],
					}),
					{ coll: [] as Semaphore[], lastOrder: -1 }
				).coll

			for (const s of oldS) free(s)
			for (const s of semaphores) await allocate(s)
			return disposable(() => {
				for (const s of newS) free(s)
				semaphores = oldS
			})
		},
		input<T extends Record<string, TaskIO<unknown>> | TaskIO<unknown>[]>(taskIO: T) {
			if (semaphores.length)
				throw new TaskSyncError('Cannot input task I/O when semaphores are already allocated')
			const rv = (Array.isArray(taskIO) ? [] : {}) as Partial<UnTIO<T>>
			let promise: Promise<void> | undefined
			for (const [key, tio] of Object.entries(taskIO) as [keyof T, any][])
				if (tio && typeof tio === 'object' && 'value' in tio) rv[key] = tio.value
				else {
					const nextPromise = tioPromises.get(tio)!.then((v: any) => {
						rv[key] = v
					})
					promise = promise?.then(() => nextPromise) ?? nextPromise
				}
			return promise?.then(() => rv as UnTIO<T>) ?? (rv as UnTIO<T>)
		},
	}
}
