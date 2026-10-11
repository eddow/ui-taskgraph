export class TaskSyncError extends Error {}

import { disposable } from './utils.js'

let semaphoreOrder = 0

interface BaseTask {
	waitingInput: boolean
}

export class Semaphore<Task extends BaseTask> {
	readonly order: number
	constructor(readonly name?: string) {
		this.order = ++semaphoreOrder
		Object.freeze(this)
	}
	acquire(task: Task) {
		return acquire(task, this)
	}
}
const allocations = new WeakMap<Semaphore<any>, (() => void)[]>()
function allocate(semaphore: Semaphore<any>) {
	if (!allocations.has(semaphore)) allocations.set(semaphore, [])
	else return new Promise<void>((resolve) => allocations.get(semaphore)!.push(resolve))
}
function free(semaphore: Semaphore<any>) {
	const waiters = allocations.get(semaphore)
	if (waiters?.length) waiters.shift()!()
	else allocations.delete(semaphore)
}

const tioPromises = new WeakMap<TaskIO<any, any>, Promise<unknown>>()

export class TaskIO<Task extends BaseTask, T> {
	declare readonly value?: T
	#resolve!: (value: T) => void
	set(value: T): void {
		if ('value' in this) throw new TaskSyncError('Value is already set')
		Object.defineProperty(this, 'value', { value, writable: false, configurable: true })
		this.#resolve(value)
	}
	constructor(readonly name?: string) {
		tioPromises.set(
			this,
			new Promise((r) => {
				this.#resolve = r
			})
		)
	}
	require(task: Task) {
		return require(task, this)
	}
}
export type RequireParams<Task extends BaseTask> =
	| Record<string, TaskIO<Task, any>>
	| TaskIO<Task, any>[]
	| TaskIO<Task, any>
export type UnTIO<Task extends BaseTask, T> =
	T extends TaskIO<Task, infer U>
		? U
		: T extends TaskIO<Task, infer U>[]
			? U[]
			: {
					[K in keyof T]: T[K] extends TaskIO<Task, infer V> ? V : T[K]
				}
export type TaskSync<Task extends BaseTask> = {
	acquire(...semaphores: Semaphore<Task>[]): Promise<() => void>
	require<T extends RequireParams<Task>>(tio: T): UnTIO<Task, T> | Promise<UnTIO<Task, T>>
}

function sortDeDup(semaphores: Semaphore<any>[]) {
	return semaphores
		.sort((a, b) => a.order - b.order)
		.reduce(
			(acc, s) => ({
				lastOrder: s.order,
				coll: acc.lastOrder === s.order ? acc.coll : [...acc.coll, s],
			}),
			{ coll: [] as Semaphore<any>[], lastOrder: -1 }
		).coll
}
/**
 * Creates a semaphore-space. Function allowing to allocate semaphores and wait for tasks I/O.
 * Semaphore-space can only be created to be given to async functions who are not going to be waited for where the space is created
 * @returns SemaphoreSpace
 */
export function taskSync<Task extends BaseTask>(): TaskSync<Task> {
	let semaphores: Semaphore<Task>[] = []
	return {
		acquire: async (...newS: Semaphore<Task>[]) => {
			const oldS = semaphores

			const lastOldOrder = oldS[oldS.length - 1]?.order ?? -1
			if (newS.every((s) => s.order > lastOldOrder)) {
				newS = sortDeDup(newS)
				semaphores = [...oldS, ...newS]
				for (const s of newS) await allocate(s)
			} else {
				semaphores = sortDeDup([...oldS, ...newS])
				for (const s of oldS) free(s)
				for (const s of semaphores) await allocate(s)
			}
			return disposable(() => {
				for (const s of newS) free(s)
				semaphores = oldS
			})
		},
		require<T extends RequireParams<Task>>(taskIO: T) {
			if (semaphores.length)
				throw new TaskSyncError('Cannot input task I/O when semaphores are already allocated')
			if (taskIO instanceof TaskIO) {
				if ('value' in taskIO) return taskIO.value
				return tioPromises.get(taskIO)!
			}
			const rv = (Array.isArray(taskIO) ? [] : {}) as { [K in keyof T]?: unknown }
			let promise: Promise<void> | undefined
			for (const [key, tio] of Object.entries(taskIO) as [keyof T, any][])
				if (!(tio instanceof TaskIO)) throw new TaskSyncError('Invalid task I/O item')
				else if ('value' in tio) rv[key] = tio.value
				else {
					const nextPromise = tioPromises.get(tio)!.then((v: any) => {
						rv[key] = v
					})
					promise = promise?.then(() => nextPromise) ?? nextPromise
				}
			return promise?.then(() => rv as UnTIO<Task, T>) ?? (rv as UnTIO<Task, T>)
		},
	}
}
const tasks = new WeakMap<any, TaskSync<any>>()
export function registerTaskSpace<Task extends BaseTask>(task: Task): void {
	if (tasks.has(task)) throw new Error('Task space already registered')
	tasks.set(task, taskSync<Task>())
}

export function require<Task extends BaseTask, T extends RequireParams<Task>>(
	task: Task,
	tio: T
): UnTIO<Task, T> | Promise<UnTIO<Task, T>> {
	if (!tasks.has(task)) throw new Error('Task space not registered')
	const { require } = tasks.get(task)!
	const rv = require(tio)
	if (rv instanceof Promise) {
		task.waitingInput = true
		return rv.finally(() => {
			task.waitingInput = false
		})
	}
	return rv
}
export function acquire<Task extends BaseTask>(task: Task, ...semaphores: Semaphore<Task>[]) {
	if (!tasks.has(task)) throw new Error('Task space not registered')
	const { acquire } = tasks.get(task)!
	return acquire(...semaphores)
}
