export class TaskSyncError extends Error {}

import { disposable } from './utils.js'

//#region Units

export type SemaphoreUnit = {
	readonly uid: string
	acquire(semaphoreId: string): Promise<void> | void
	release(semaphoreId: string): void
}

export type TaskIOUnit = {
	readonly uid: string
	provide(ioId: string, value: any): Promise<void> | void
	query(ioId: string): Promise<any> | any
}

export function localExecutionUnit(): SemaphoreUnit & TaskIOUnit {
	const acquirements = new Map<string, (() => void)[]>()
	type taskIoPair = {
		promise: Promise<unknown>
		resolve(value: unknown): void
	}
	const taskIOs = new Map<string, taskIoPair>()
	function getPair(tioId: string) {
		if (!taskIOs.has(tioId)) {
			const pair: Partial<taskIoPair> = {}
			pair.promise = new Promise((r) => {
				pair.resolve = r
			})
			taskIOs.set(tioId, pair as taskIoPair)
		}
		return taskIOs.get(tioId)!
	}
	return {
		uid: crypto.randomUUID(),
		acquire(semaphoreId: string) {
			if (!acquirements.has(semaphoreId)) {
				acquirements.set(semaphoreId, [])
			} else return new Promise<void>((resolve) => acquirements.get(semaphoreId)!.push(resolve))
		},
		release(semaphoreId: string) {
			const waiters = acquirements.get(semaphoreId)
			if (waiters?.length) waiters.shift()!()
			else acquirements.delete(semaphoreId)
		},
		provide(tioId: string, value: any) {
			getPair(tioId).resolve(value)
		},
		query(tioId: string) {
			return getPair(tioId).promise
		},
	}
}
const globalUnit = localExecutionUnit()

//#endregion
//#region Semaphore

export abstract class ASemaphore<Task extends BaseTask = any> {
	abstract readonly unit: SemaphoreUnit
	abstract readonly uid: string

	constructor(readonly id: string) {}
	acquire(task: Task) {
		return acquire(task, this)
	}
}
export const GenericSemaphore = (unit: SemaphoreUnit) =>
	class Semaphore<Task extends BaseTask> extends ASemaphore<Task> {
		constructor(id?: string) {
			super(id || crypto.randomUUID())
		}
		get unit() {
			return unit
		}
		get uid() {
			return `${unit.uid}-${this.id}`
		}
	}
// Create a global localUnit to use Semaphores ou of the box
export const Semaphore = GenericSemaphore(globalUnit)
export type Semaphore<Task extends BaseTask> = ASemaphore<Task>

//#endregion
//#region TaskIO

export interface BaseTask {
	waitingInput: boolean
}
export abstract class ATaskIO<Task extends BaseTask, T> {
	abstract readonly uid: string
	abstract readonly unit: TaskIOUnit
	declare readonly value?: T
	get promise() {
		return this.unit.query(this.id)
	}
	set(value: T) {
		if('value' in this)
		Object.defineProperty(this, 'value', { value, writable: false, configurable: true })
		return this.unit.provide(this.id, value)
	}
	constructor(readonly id: string) {}
	require(task: Task) {
		return require(task, this)
	}
}
export const GenericTaskIO = (unit: TaskIOUnit) =>
	class TaskIO<Task extends BaseTask, T> extends ATaskIO<Task, T> {
		constructor(id?: string) {
			super(id || crypto.randomUUID())
		}
		get unit() {
			return unit
		}
		get uid() {
			return `${unit.uid}-${this.id}`
		}
	}

export type TaskIO<Task extends BaseTask, T> = ATaskIO<Task, T>
export const TaskIO = GenericTaskIO(globalUnit)
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

//#endregion
//#region TaskSync

export type TaskSync<Task extends BaseTask> = {
	acquire(
		...semaphores: ASemaphore<Task>[]
	): Promise<(() => void) & { [Symbol.dispose]: () => void }>
	require<T extends RequireParams<Task>>(tio: T): UnTIO<Task, T> | Promise<UnTIO<Task, T>>
}

function sortDeDup(semaphores: ASemaphore<any>[]) {
	return semaphores
		.sort((a, b) => a.uid.localeCompare(b.uid))
		.reduce(
			(acc, s) => ({
				lastOrder: s.uid,
				coll: acc.lastOrder === s.uid ? acc.coll : [...acc.coll, s],
			}),
			{ coll: [] as ASemaphore<any>[], lastOrder: '' }
		).coll
}

export function taskSync<Task extends BaseTask>(): TaskSync<Task> {
	let semaphores: ASemaphore<Task>[] = []
	return {
		acquire: async (...newS: ASemaphore<Task>[]) => {
			const oldS = semaphores

			const lastOldOrder = oldS[oldS.length - 1]?.uid ?? ''
			if (newS.every((s) => s.uid > lastOldOrder)) {
				newS = sortDeDup(newS)
				semaphores = [...oldS, ...newS]
				for (const s of newS) await s.unit.acquire(s.uid)
			} else {
				semaphores = sortDeDup([...oldS, ...newS])
				for (const s of oldS) s.unit.release(s.uid)
				for (const s of semaphores) await s.unit.acquire(s.uid)
			}
			return disposable(() => {
				for (const s of newS) s.unit.release(s.uid)
				semaphores = oldS
			})
		},
		require<T extends RequireParams<Task>>(taskIO: T) {
			if (semaphores.length)
				throw new TaskSyncError('Cannot input task I/O when semaphores are already allocated')
			if (taskIO instanceof ATaskIO) {
				if ('value' in taskIO) return taskIO.value
				return taskIO.promise
			}
			const rv = (Array.isArray(taskIO) ? [] : {}) as { [K in keyof T]?: unknown }
			let promise: Promise<void> | undefined
			for (const [key, tio] of Object.entries(taskIO) as [keyof T, any][])
				if (!(tio instanceof ATaskIO)) throw new TaskSyncError('Invalid task I/O item')
				else if ('value' in tio) rv[key] = tio.value
				else {
					const nextPromise = tio.promise.then((v: any) => {
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
export function acquire<Task extends BaseTask>(task: Task, ...semaphores: ASemaphore<Task>[]) {
	if (!tasks.has(task)) throw new Error('Task space not registered')
	const { acquire } = tasks.get(task)!
	return acquire(...semaphores)
}

//#endregion