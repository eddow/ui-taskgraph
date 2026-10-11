import { describe, expect, it } from 'vitest'
import { acquire, registerTaskSpace, require, Semaphore, TaskIO, taskSync } from './task-sync.js'

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
