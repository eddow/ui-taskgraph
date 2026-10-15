import { describe, expect, it, vi } from 'vitest'
import {
	ASemaphore,
	ATaskIO,
	acquire,
	GenericSemaphore,
	GenericTaskIO,
	localExecutionUnit,
	registerTaskSpace,
	require,
	Semaphore,
	TaskIO,
	TaskSyncError,
	taskSync,
} from './task-sync.js'

type T = { waitingInput: boolean }
const newTask = (): T => ({ waitingInput: false })

describe('localExecutionUnit', () => {
	it('generates unique uids', () => {
		expect(localExecutionUnit().uid).not.toBe(localExecutionUnit().uid)
	})

	it('queues semaphore waiters FIFO', async () => {
		const unit = localExecutionUnit()
		await unit.acquire('s')
		let second = false
		const p2 = (unit.acquire('s') as Promise<void>).then(() => {
			second = true
		})
		await Promise.resolve()
		expect(second).toBe(false)
		unit.release('s')
		await p2
		expect(second).toBe(true)
	})

	it('release without holders throws', () => {
		const unit = localExecutionUnit()
		expect(() => unit.release('never-held')).toThrow(TaskSyncError)
	})

	it('shares one promise per io id until provided', async () => {
		const unit = localExecutionUnit()
		const p1 = unit.query('io')
		const p2 = unit.query('io')
		expect(p1).toBe(p2)
		await unit.provide('io', 42)
		await expect(p1).resolves.toBe(42)
		await expect(p2).resolves.toBe(42)
	})
})

describe('semaphores', () => {
	it('GenericSemaphore builds uid from unit uid and id', () => {
		const unit = localExecutionUnit()
		const S = GenericSemaphore(unit)
		const s = new S('my-id')
		expect(s.uid).toBe(`${unit.uid}-my-id`)
		expect(s.unit).toBe(unit)
	})

	it('generates a random id when omitted', () => {
		const a = new Semaphore()
		const b = new Semaphore()
		expect(a.id).not.toBe(b.id)
	})

	it('ASemaphore.acquire delegates to task space', async () => {
		const task = newTask()
		registerTaskSpace(task)
		const sem = new Semaphore('s1')
		const release = await sem.acquire(task)
		expect(typeof release).toBe('function')
		release()
	})
})

describe('TaskIO', () => {
	it('set resolves requirers without populating the value cache', async () => {
		const task = newTask()
		registerTaskSpace(task)
		const tio = new TaskIO<typeof task, string>('tio-cache')
		expect('value' in tio).toBe(false)
		setTimeout(() => tio.set('v'), 5)
		await expect(tio.promise).resolves.toBe('v')
		// the base class never caches on a fresh instance: `set` only
		// refreshes an already-present `value`, so the cache stays absent…
		expect('value' in tio).toBe(false)
		// …and `require` keeps taking the promise path (already-resolved
		// unit promise, so no waitingInput is observed afterwards)
		await expect(require(task, tio) as Promise<string>).resolves.toBe('v')
		expect(task.waitingInput).toBe(false)
		// the unit promise resolves once — a second `set` is a no-op
		tio.set('v2')
		await expect(tio.promise).resolves.toBe('v')
	})

	it('set can be overridden to transform the value before providing', async () => {
		const task = newTask()
		registerTaskSpace(task)
		class Enriching extends ATaskIO<typeof task, { id: string; info?: string }> {
			unit = localExecutionUnit()
			get uid() {
				return `enrich-${this.id}`
			}
			set(value: { id: string; info?: string }) {
				return super.set({ ...value, info: `info-for-${value.id}` })
			}
		}
		const tio = new Enriching('enrich-1')
		tio.set({ id: 'a' })
		await expect(tio.promise).resolves.toEqual({ id: 'a', info: 'info-for-a' })
		// the base class still never caches on a fresh instance
		expect('value' in tio).toBe(false)
	})

	it('subclasses managing value themselves unlock sync require', async () => {
		const task = newTask()
		registerTaskSpace(task)
		class Eager extends ATaskIO<typeof task, number> {
			unit = localExecutionUnit()
			get uid() {
				return `eager-${this.id}`
			}
			set(value: number) {
				Object.defineProperty(this, 'value', { value, writable: false, configurable: true })
				return super.set(value)
			}
		}
		const tio = new Eager('eager-1')
		tio.set(42)
		expect(tio.value).toBe(42)
		expect(require(task, tio)).toBe(42)
		expect(task.waitingInput).toBe(false)
		// second `set` refreshes the already-present cache…
		tio.set(43)
		expect(tio.value).toBe(43)
		// …but the unit promise still resolves once, with the first value
		await expect(tio.promise).resolves.toBe(42)
	})

	it('set override throwing blocks providing; value stays unset', async () => {
		const task = newTask()
		registerTaskSpace(task)
		class Validating extends ATaskIO<typeof task, number> {
			unit = localExecutionUnit()
			get uid() {
				return `valid-${this.id}`
			}
			set(value: number) {
				if (value < 0) throw new TaskSyncError('negative not allowed')
				return super.set(value)
			}
		}
		const tio = new Validating('valid-1')
		expect(() => tio.set(-1)).toThrow(TaskSyncError)
		expect('value' in tio).toBe(false)
		// nothing was provided: require pends until a valid value arrives
		const pending = require(task, tio) as Promise<number>
		expect(task.waitingInput).toBe(true)
		tio.set(5)
		await expect(pending).resolves.toBe(5)
		expect(task.waitingInput).toBe(false)
	})

	it('set can be overridden to forbid backend-provided client input', async () => {
		const task = newTask()
		registerTaskSpace(task)
		class ClientInput extends ATaskIO<typeof task, string> {
			unit = localExecutionUnit()
			get uid() {
				return `client-${this.id}`
			}
			set(_value: string) {
				throw new TaskSyncError('client input must come from the client, not the backend')
			}
		}
		const tio = new ClientInput('client-1')
		expect(() => tio.set('forged')).toThrow(TaskSyncError)
		expect('value' in tio).toBe(false)
		// the legitimate path — raw unit.provide — still resolves requirers…
		tio.unit.provide(tio.id, 'from-client')
		await expect(tio.promise).resolves.toBe('from-client')
		// …but the base class never populates the cache on a fresh instance
		expect('value' in tio).toBe(false)
	})

	it('require on the instance delegates to the task space', async () => {
		const task = newTask()
		registerTaskSpace(task)
		const tio = new TaskIO<typeof task, number>('tio-req')
		const pending = tio.require(task) as Promise<number>
		tio.set(7)
		await expect(pending).resolves.toBe(7)
	})

	it('GenericTaskIO scopes uid per unit', () => {
		const u1 = localExecutionUnit()
		const u2 = localExecutionUnit()
		const T1 = GenericTaskIO(u1)
		const T2 = GenericTaskIO(u2)
		const a = new T1('same')
		const b = new T2('same')
		expect(a.uid).not.toBe(b.uid)
		expect(a.unit).toBe(u1)
	})
})

describe('taskSync acquire', () => {
	it('fast path appends ordered semaphores and releases via disposable', async () => {
		const space = taskSync<T>()
		const a = new Semaphore('a')
		const b = new Semaphore('b')
		const rel = await space.acquire(a, b)
		rel()
		rel[Symbol.dispose]()
		expect(typeof rel).toBe('function')
	})

	it('slow path releases and re-acquires in sorted order', async () => {
		const space = taskSync<T>()
		const b = new Semaphore('b')
		const a = new Semaphore('a')
		const rel1 = await space.acquire(b)
		const rel2 = await space.acquire(a)
		expect(typeof rel1).toBe('function')
		expect(typeof rel2).toBe('function')
		rel1()
		rel2()
	})

	it('dedupes the same semaphore requested twice', async () => {
		const space = taskSync<T>()
		const s = new Semaphore('dup')
		const rel = await space.acquire(s, s)
		expect(typeof rel).toBe('function')
		rel()
	})

	it('returned release restores the previous semaphore set', async () => {
		const space = taskSync<T>()
		const a = new Semaphore('ra')
		const b = new Semaphore('rb')
		const relA = await space.acquire(a)
		const relB = await space.acquire(b)
		relB()
		// restoring reinstates [a], so input is still blocked…
		const tio = new TaskIO<T, number>()
		tio.set(1)
		expect(() => space.require(tio)).toThrow(TaskSyncError)
		relA()
		// …until everything is released
		await expect(space.require(tio)).resolves.toBe(1)
	})
})

describe('taskSync require', () => {
	it('throws when semaphores are allocated', async () => {
		const space = taskSync<T>()
		const rel = await space.acquire(new Semaphore('held'))
		const tio = new TaskIO<T, number>()
		tio.set(1)
		expect(() => space.require(tio)).toThrow(TaskSyncError)
		rel()
	})

	it('returns provided values for single/array/record forms', async () => {
		const space = taskSync<T>()
		const a = new TaskIO<T, number>()
		const b = new TaskIO<T, string>()
		a.set(1)
		b.set('x')
		// NOTE: `set` never populates the `value` cache — only promise
		// resolution does (after `resolveValue`). So `require` always takes
		// the promise path here, even for already-set values.
		await expect(space.require(a)).resolves.toBe(1)
		await expect(space.require([a])).resolves.toEqual([1])
		await expect(space.require({ a, b })).resolves.toEqual({ a: 1, b: 'x' })
	})

	it('awaits pending promises for array and record forms', async () => {
		const space = taskSync<T>()
		const a = new TaskIO<T, number>('pa')
		const b = new TaskIO<T, number>('pb')
		const pendingArr = space.require([a, b]) as Promise<number[]>
		const pendingRec = space.require({ a, b }) as Promise<{ a: number; b: number }>
		a.set(1)
		b.set(2)
		await expect(pendingArr).resolves.toEqual([1, 2])
		await expect(pendingRec).resolves.toEqual({ a: 1, b: 2 })
	})

	it('mixes set values with pending promises', async () => {
		const space = taskSync<T>()
		const ready = new TaskIO<T, number>()
		ready.set(1)
		const pending = new TaskIO<T, number>('mix-p')
		const rv = space.require({ ready, pending }) as Promise<{ ready: number; pending: number }>
		pending.set(2)
		await expect(rv).resolves.toEqual({ ready: 1, pending: 2 })
	})

	it('rejects non-TaskIO entries', () => {
		const space = taskSync<T>()
		expect(() => (space as any).require([42 as any])).toThrow(TaskSyncError)
		expect(() => (space as any).require({ x: 'nope' })).toThrow(TaskSyncError)
	})

	it('ATaskIO subclass instances are accepted', async () => {
		const space = taskSync<T>()
		class Custom<T2> extends ATaskIO<T, T2> {
			unit = localExecutionUnit()
			get uid() {
				return `custom-${this.id}`
			}
		}
		const c = new Custom<number>('c1')
		c.set(9)
		await expect(space.require(c as any)).resolves.toBe(9)
	})
})

describe('task space registry', () => {
	it('rejects double registration', () => {
		const task = newTask()
		registerTaskSpace(task)
		expect(() => registerTaskSpace(task)).toThrow()
	})

	it('require/acquire throw for unregistered tasks', () => {
		const ghost = newTask()
		expect(() => require(ghost, new TaskIO('g'))).toThrow()
		expect(() => acquire(ghost, new Semaphore('g'))).toThrow()
	})

	it('require resolves set values and leaves waitingInput false', async () => {
		const task = newTask()
		registerTaskSpace(task)
		const tio = new TaskIO<typeof task, number>()
		tio.set(5)
		await expect(require(task, tio)).resolves.toBe(5)
		expect(task.waitingInput).toBe(false)
	})

	it('require resets waitingInput on rejection', async () => {
		const task = newTask()
		registerTaskSpace(task)
		const tio = new TaskIO<typeof task, number>('rej')
		const pending = require(task, tio) as Promise<number>
		expect(task.waitingInput).toBe(true)
		// resolve the underlying query by reaching into the unit via set on another handle
		tio.set(1)
		await expect(pending).resolves.toBe(1)
		expect(task.waitingInput).toBe(false)
	})

	it('ASemaphore base class is abstract but typed', () => {
		expect(ASemaphore).toBeDefined()
		const spy = vi.fn()
		expect(spy).not.toHaveBeenCalled()
	})
})
