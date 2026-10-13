import { describe, expect, it, vi } from 'vitest'
import { AGroupRunner, ATaskGroup, AWorkerStatus, type IWorkerTask, TasksRunner } from './runner.js'
import * as generic from './task-sync.js'

class TestStatus extends AWorkerStatus {
	waited: Promise<void>[] = []
	async waitInput(promise: Promise<void>) {
		this.waited.push(promise)
		await promise
	}
}

class TestGroupRunner extends AGroupRunner<TestStatus, TestTask> {
	readonly status = new TestStatus()
}

type TestTask = IWorkerTask<TestStatus>

class TestRunner extends TasksRunner<TestStatus, TestTask, TestGroupRunner> {
	errors: unknown[] = []
	reportWorkerError(error: unknown): void {
		this.errors.push(error)
	}
	protected newStatus(): TestStatus {
		return new TestStatus()
	}
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

describe('AWorkerStatus', () => {
	it('clamps progress to [0,1] and updates max', () => {
		const s = new TestStatus()
		expect(Number.isNaN(s.progress())).toBe(true)
		expect(s.progress(0.5, 2)).toBe(0.25)
		expect(s.progressMax).toBe(2)
		expect(s.progress(10)).toBe(1)
		expect(s.progress(-5)).toBe(0)
		expect(s.progress()).toBe(0)
	})

	it('waitingInput setter drives waitInput promise', async () => {
		const s = new TestStatus()
		expect(s.waitingInput).toBe(false)
		s.waitingInput = true
		expect(s.waitingInput).toBe(true)
		expect(s.waited.length).toBe(1)
		// second true is idempotent
		s.waitingInput = true
		expect(s.waited.length).toBe(1)
		s.waitingInput = false
		expect(s.waitingInput).toBe(false)
		await expect(s.waited[0]).resolves.toBeUndefined()
		// false when already false is a no-op
		s.waitingInput = false
	})

	it('require and acquire delegate to the task space', async () => {
		const s = new TestStatus()
		generic.registerTaskSpace(s)
		const tio = new generic.TaskIO('runner-tio')
		const pending = s.require(tio as any) as Promise<unknown>
		tio.set('ok')
		await expect(pending).resolves.toBe('ok')
		const sem = new generic.Semaphore('runner-sem')
		const rel = await s.acquire(sem as any)
		rel()
	})
})

describe('ATaskGroup', () => {
	it('runs workers, tracks active, resolves finished', async () => {
		const runner = new TestRunner()
		const order: string[] = []
		const w1: TestTask = async () => {
			order.push('w1')
		}
		const w2: TestTask = async () => {
			order.push('w2')
		}
		runner.start([w1, w2])
		expect(runner.running).toBe(true)
		await runner.finished
		expect(order.sort()).toEqual(['w1', 'w2'])
		expect(runner.running).toBe(false)
		expect(runner.active.size).toBe(0)
	})

	it('accepts a single function worker', async () => {
		const runner = new TestRunner()
		let ran = false
		runner.start(async () => {
			ran = true
		})
		await runner.finished
		expect(ran).toBe(true)
	})

	it('applies wrapEach around workers', async () => {
		const runner = new TestRunner()
		const calls: string[] = []
		runner.wrapEach = async (task, _status) => {
			calls.push('before')
			await task()
			calls.push('after')
		}
		runner.start(async () => {
			calls.push('work')
		})
		await runner.finished
		expect(calls).toEqual(['before', 'work', 'after'])
	})

	it('reports worker errors without hanging', async () => {
		const runner = new TestRunner()
		const boom = new Error('boom')
		runner.start(async () => {
			throw boom
		})
		await runner.finished
		expect(runner.errors).toEqual([boom])
	})

	it('startRun is idempotent while running', async () => {
		const runner = new TestRunner()
		let release!: () => void
		const gate = new Promise<void>((r) => (release = r))
		runner.start([async () => gate, async () => gate])
		const f1 = runner.finished
		runner.start(async () => {})
		expect(runner.finished).toBe(f1)
		release()
		await runner.finished
	})
})

describe('AGroupRunner', () => {
	it('registers itself in parent active and applies wrapAll', async () => {
		const runner = new TestRunner()
		const calls: string[] = []
		const parent = runner as unknown as ATaskGroup<TestStatus, TestTask, TestGroupRunner>
		const sub = new TestGroupRunner(parent)
		sub.wrapAll = async (task) => {
			calls.push('wrap-before')
			await task()
			calls.push('wrap-after')
		}
		sub.status.text = 'sub'
		sub.start(async () => {
			calls.push('work')
		})
		await sub.finished
		expect(calls).toEqual(['wrap-before', 'work', 'wrap-after'])
		expect(parent.active.has(sub.status)).toBe(false)
	})

	it('inherits the root runner', () => {
		const runner = new TestRunner()
		const sub = new TestGroupRunner(runner as any)
		expect(sub.runner).toBe(runner)
	})
})

describe('TasksRunner concurrency', () => {
	it('limits parallelism via concurrent setter', async () => {
		const runner = new TestRunner()
		let live = 0
		let maxLive = 0
		const mk = (): TestTask => async () => {
			live++
			maxLive = Math.max(maxLive, live)
			await tick(10)
			live--
		}
		runner.start([mk(), mk(), mk(), mk()], 2)
		expect(runner.concurrent).toBe(2)
		await runner.finished
		expect(maxLive).toBeLessThanOrEqual(2)
		runner.concurrent = 5
		expect(runner.concurrent).toBe(5)
	})

	it('defaults worker text to task name', async () => {
		const runner = new TestRunner()
		let seenText: string | undefined
		async function namedTask({ status }: { status: TestStatus; group: unknown }) {
			seenText = status.text
		}
		runner.start([namedTask as TestTask])
		await runner.finished
		expect(seenText).toBe('namedTask')
		// `workers` cleanup runs in a microtask after `finished` resolves
		await tick()
		expect(runner.workers.size).toBe(0)
	})

	it('drains multiple start() batches in order', async () => {
		const runner = new TestRunner()
		const order: number[] = []
		runner.start([
			async () => {
				order.push(1)
			},
		])
		runner.start([
			async () => {
				order.push(2)
			},
		])
		await runner.finished
		expect(order.sort()).toEqual([1, 2])
	})

	it('infos record is writable', async () => {
		const runner = new TestRunner()
		runner.infos = { build: 'ok' }
		expect(runner.infos).toEqual({ build: 'ok' })
		runner.start([])
		await runner.finished
	})

	it('ATaskGroup base import is usable as a type', () => {
		expect(ATaskGroup).toBeDefined()
		const spy = vi.fn()
		expect(spy).not.toHaveBeenCalled()
	})
})
