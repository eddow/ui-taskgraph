import { describe, expect, it } from 'vitest'
import {
	acquire,
	globalUnit,
	localExecutionUnit,
	registerTaskSpace,
	require,
	Semaphore,
	TaskIO,
	TaskSyncError,
	taskSync,
} from './task-sync.js'

describe('Gemini', () => {
	it('should register a task space and allow basic acquire', async () => {
		const task = { waitingInput: false }
		registerTaskSpace(task)

		const sem = new Semaphore('lock-1')
		const release = await acquire(task, sem)
		expect(typeof release).toBe('function')
		release()
	})

	// THIS TEST WILL FAIL DUE TO THE ALLOCATION/QUEUE BUG IN FREE()
	it('should correctly queue and wake up multiple tasks waiting on the same semaphore', async () => {
		const task1 = { waitingInput: false }
		const task2 = { waitingInput: false }
		registerTaskSpace(task1)
		registerTaskSpace(task2)

		const sem = new Semaphore('shared-lock')

		// Task 1 acquires the semaphore
		const release1 = await acquire(task1, sem)

		let task2Acquired = false
		const p2 = acquire(task2, sem).then((rel) => {
			task2Acquired = true
			return rel
		})

		// Task 2 should be waiting because Task 1 holds it
		expect(task2Acquired).toBe(false)

		// Task 1 releases
		release1()

		// Task 2 should now acquire it successfully
		const release2 = await p2
		expect(task2Acquired).toBe(true)
		release2()
	})

	it('should handle TaskIO set and require correctly', async () => {
		const task = { waitingInput: false }
		registerTaskSpace(task)

		const tio = new TaskIO<typeof task, string>('my-io')

		setTimeout(() => {
			tio.set('hello world')
		}, 50)

		const result = await require(task, tio)
		expect(result).toBe('hello world')
	})
})

describe('Muse spark', () => {
	it('keeps waitingInput true until promise settles', async () => {
		const task = { waitingInput: false, waitInput(_p: Promise<void>) {} }
		registerTaskSpace(task)
		const tio = new TaskIO<typeof task, number>('x')
		const pending = require(task, tio) as Promise<number>
		expect(task.waitingInput).toBe(true) // fails now: false
		tio.set(1)
		expect(await pending).toBe(1)
		expect(task.waitingInput).toBe(false)
	})
	it('rejects invalid require entry with TaskSyncError', () => {
		const space = taskSync<any>()
		expect(() => (space as any).require({ x: 42 as any })).toThrow()
		// fails now: TypeError from undefined.then instead of TaskSyncError
	})
})

describe('counting semaphores', () => {
	it('allows up to max concurrent acquires, blocks beyond', async () => {
		const unit = localExecutionUnit({ freeInstances: { pool: 3 } })
		const Sem = (await import('./task-sync.js')).GenericSemaphore(unit)
		const tasks = Array.from({ length: 4 }, () => ({ waitingInput: false }))
		for (const t of tasks) registerTaskSpace(t)
		const sems = tasks.map(() => new Sem('pool'))

		const releases = await Promise.all([acquire(tasks[0], sems[0]), acquire(tasks[1], sems[1]), acquire(tasks[2], sems[2])])
		let fourthAcquired = false
		const p4 = acquire(tasks[3], sems[3]).then((rel) => {
			fourthAcquired = true
			return rel
		})
		await Promise.resolve()
		expect(fourthAcquired).toBe(false)
		releases[0]()
		const release4 = await p4
		expect(fourthAcquired).toBe(true)
		releases[1]()
		releases[2]()
		release4()
	})

	it('wakes waiters FIFO on release', async () => {
		const unit = localExecutionUnit({ freeInstances: { q: 1 } })
		const { GenericSemaphore } = await import('./task-sync.js')
		const Sem = GenericSemaphore(unit)
		const order: number[] = []
		const tasks = Array.from({ length: 3 }, () => ({ waitingInput: false }))
		for (const t of tasks) registerTaskSpace(t)
		const r0 = await acquire(tasks[0], new Sem('q'))
		const p1 = acquire(tasks[1], new Sem('q')).then((r) => {
			order.push(1)
			return r
		})
		const p2 = acquire(tasks[2], new Sem('q')).then((r) => {
			order.push(2)
			return r
		})
		r0()
		const r1 = await p1
		expect(order).toEqual([1])
		r1()
		const r2 = await p2
		expect(order).toEqual([1, 2])
		r2()
	})

	it('defaults unknown ids to binary', async () => {
		const unit = localExecutionUnit()
		const { GenericSemaphore } = await import('./task-sync.js')
		const Sem = GenericSemaphore(unit)
		const t1 = { waitingInput: false }
		const t2 = { waitingInput: false }
		registerTaskSpace(t1)
		registerTaskSpace(t2)
		const r1 = await acquire(t1, new Sem('bin'))
		let acquired = false
		const p2 = acquire(t2, new Sem('bin')).then((r) => {
			acquired = true
			return r
		})
		await Promise.resolve()
		expect(acquired).toBe(false)
		r1()
		const r2 = await p2
		expect(acquired).toBe(true)
		r2()
	})

	it('throws on invalid max', () => {
		expect(() => localExecutionUnit({ freeInstances: { bad: 0 } })).toThrow(TaskSyncError)
		const unit = localExecutionUnit()
		expect(() => {
			unit.freeInstances['bad'] = 0
		}).toThrow(TaskSyncError)
	})

	it('mutable freeInstances wakes waiters on increase', async () => {
		const unit = localExecutionUnit()
		const { GenericSemaphore } = await import('./task-sync.js')
		const Sem = GenericSemaphore(unit)
		const t1 = { waitingInput: false }
		const t2 = { waitingInput: false }
		registerTaskSpace(t1)
		registerTaskSpace(t2)
		const r1 = await acquire(t1, new Sem('dyn'))
		let acquired = false
		const p2 = acquire(t2, new Sem('dyn')).then((r) => {
			acquired = true
			return r
		})
		await Promise.resolve()
		expect(acquired).toBe(false)
		unit.freeInstances['dyn'] = 2
		const r2 = await p2
		expect(acquired).toBe(true)
		r1()
		r2()
	})

	it('over-release throws', async () => {
		const unit = localExecutionUnit()
		const { GenericSemaphore } = await import('./task-sync.js')
		const Sem = GenericSemaphore(unit)
		const t = { waitingInput: false }
		registerTaskSpace(t)
		const r = await acquire(t, new Sem('strict'))
		r()
		expect(() => unit.release(`${unit.uid}-strict`)).toThrow(TaskSyncError)
	})

	it('globalUnit exposes mutable freeInstances', () => {
		expect(typeof globalUnit.freeInstances).toBe('object')
	})
})
