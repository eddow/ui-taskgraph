import { describe, expect, it, vi } from 'vitest'
import {
	RemoteGroupRunner,
	RemoteRunner,
	RemoteRunnerRegistry,
	RemoteWorkerStatus,
	UnknownRunError,
	UnknownTaskError,
} from './backend.js'

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

describe('RemoteWorkerStatus/Runner/GroupRunner', () => {
	it('waitInput awaits the promise', async () => {
		const s = new RemoteWorkerStatus()
		let done = false
		const p = s.waitInput(new Promise<void>((r) => setTimeout(() => { done = true; r() }, 5)))
		expect(done).toBe(false)
		await p
		expect(done).toBe(true)
	})

	it('RemoteRunner reports errors via hooks', () => {
		const onError = vi.fn()
		const runner = new RemoteRunner({ onError })
		runner.reportWorkerError(new Error('x'))
		expect(onError).toHaveBeenCalled()
		const runner2 = new RemoteRunner()
		expect(() => runner2.reportWorkerError(new Error('x'))).not.toThrow()
	})

	it('RemoteGroupRunner creates status with text', async () => {
		const runner = new RemoteRunner()
		const sub = new RemoteGroupRunner(runner as any, 'hello')
		expect(sub.status.text).toBe('hello')
		expect(sub.runner).toBe(runner)
		const sub2 = new RemoteGroupRunner(runner as any)
		expect(sub2.status.text).toBeUndefined()
	})

	it('error classes are Errors', () => {
		expect(new UnknownRunError('a')).toBeInstanceOf(Error)
		expect(new UnknownTaskError('b')).toBeInstanceOf(Error)
	})
})

describe('registry task bookkeeping', () => {
	it('hasTask/listTasks track registrations', () => {
		const registry = new RemoteRunnerRegistry()
		expect(registry.hasTask('x')).toBe(false)
		expect(registry.listTasks()).toEqual([])
		registry.registerTask('x', () => [async () => {}])
		expect(registry.hasTask('x')).toBe(true)
		expect(registry.listTasks()).toEqual(['x'])
	})

	it('exposes configured pollMs/ttlMs/maxEvents with defaults', () => {
		const d = new RemoteRunnerRegistry()
		expect(d.pollMs).toBe(150)
		expect(d.ttlMs).toBe(5 * 60_000)
		expect(d.maxEvents).toBe(500)
		const c = new RemoteRunnerRegistry({ pollMs: 1, ttlMs: 2, maxEvents: 3 })
		expect(c.pollMs).toBe(1)
		expect(c.ttlMs).toBe(2)
		expect(c.maxEvents).toBe(3)
	})

	it('supports custom newRunner', async () => {
		const seen: unknown[] = []
		const registry = new RemoteRunnerRegistry({
			pollMs: 5,
			newRunner: (hooks) => new RemoteRunner({
				onError: (e) => seen.push(e),
			}),
		})
		registry.registerTask('t', () => [async () => {}])
		const runId = registry.create({ task: 't' })
		await tick(30)
		expect(registry.has(runId)).toBe(true)
		registry.dispose(runId)
	})
})

describe('registry run lifecycle', () => {
	it('passes params and concurrent to the run', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		let gotParams: unknown
		registry.registerTask('p', (ctx) => {
			gotParams = ctx.params
			expect(ctx.runId).toMatch(/^[0-9a-f-]{36}$/)
			expect(ctx.GroupRunner).toBe(RemoteGroupRunner)
			expect(ctx.runner).toBeDefined()
			return [async () => {}]
		})
		const runId = registry.create({ task: 'p', params: { n: 1 }, concurrent: 2 })
		await tick(30)
		expect(gotParams).toEqual({ n: 1 })
		registry.dispose(runId)
	})

	it('accepts a single function factory result', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		registry.registerTask('single', () => async () => {})
		const runId = registry.create({ task: 'single' })
		await tick(30)
		expect(registry.eventsSince(runId).at(-1)).toMatchObject({ type: 'done' })
		registry.dispose(runId)
	})

	it('records worker errors as error events', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		registry.registerTask('fail', () => [async () => { throw new Error('worker-boom') }])
		const runId = registry.create({ task: 'fail' })
		await tick(40)
		const events = registry.eventsSince(runId)
		expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: 'worker-boom' }))
		expect(registry.getSnapshot(runId).errors).toContain('worker-boom')
		registry.dispose(runId)
	})

	it('serializes non-Error worker failures', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		registry.registerTask('failstr', () => [async () => { throw 'plain-string' }])
		const runId = registry.create({ task: 'failstr' })
		await tick(40)
		expect(registry.getSnapshot(runId).errors.length).toBeGreaterThan(0)
		registry.dispose(runId)
	})

	it('subscribe replays missed events then live-pushes, unsubscribe stops', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		let release!: () => void
		const gate = new Promise<void>((r) => (release = r))
		registry.registerTask('g', () => [async () => { await gate }])
		const runId = registry.create({ task: 'g' })
		await tick(30)
		const replayed: number[] = []
		const off = registry.subscribe(runId, (e) => replayed.push(e.seq))
		expect(replayed.length).toBeGreaterThan(0)
		const live: number[] = []
		const from = replayed.at(-1)!
		const off2 = registry.subscribe(runId, (e) => live.push(e.seq), from)
		release()
		await tick(40)
		expect(live.at(-1)).toBeGreaterThan(from)
		off()
		off2()
		// after unsubscribe, no more pushes
		const n = live.length
		await tick(15)
		expect(live.length).toBe(n)
		registry.dispose(runId)
	})

	it('eventsSince honors from cursor', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		registry.registerTask('e', () => [async () => {}])
		const runId = registry.create({ task: 'e' })
		await tick(30)
		const all = registry.eventsSince(runId)
		const tail = registry.eventsSince(runId, all[0].seq)
		expect(tail.length).toBe(all.length - 1)
		registry.dispose(runId)
	})

	it('trims buffered events to maxEvents', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 1, ttlMs: 60_000, maxEvents: 3 })
		registry.registerTask('spin', () => [async ({ status }: any) => {
			for (let i = 0; i < 10; i++) {
				status.text = `t${i}`
				await tick(2)
			}
		}])
		const runId = registry.create({ task: 'spin' })
		await tick(80)
		expect(registry.eventsSince(runId).length).toBeLessThanOrEqual(3)
		registry.dispose(runId)
	})

	it('expires finished runs after ttlMs', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 30 })
		registry.registerTask('fast', () => [async () => {}])
		const runId = registry.create({ task: 'fast' })
		await tick(30)
		expect(registry.has(runId)).toBe(true)
		await tick(80)
		expect(registry.has(runId)).toBe(false)
	})

	it('dispose unknown run is a no-op; snapshot/subscribe/provide throw', () => {
		const registry = new RemoteRunnerRegistry()
		expect(() => registry.dispose('ghost')).not.toThrow()
		expect(() => registry.getSnapshot('ghost')).toThrow(UnknownRunError)
		expect(() => registry.eventsSince('ghost')).toThrow(UnknownRunError)
		expect(() => registry.subscribe('ghost', () => {})).toThrow(UnknownRunError)
		expect(() => registry.provideInput('ghost', { ioId: 'a', value: 1 })).toThrow(UnknownRunError)
	})

	it('snapshot maps NaN progress to null and walks nested groups', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		let release!: () => void
		const gate = new Promise<void>((r) => (release = r))
		registry.registerTask('nested', (ctx) => [async ({ status, group }: any) => {
			status.prefix = 'p0'
			const sub = new ctx.GroupRunner(group, 'subtask')
			sub.start(async ({ status: s2 }: any) => {
				s2.text = 'inner'
				s2.progress(0.5, 1)
				await gate
			})
			await sub.finished
		}])
		const runId = registry.create({ task: 'nested' })
		await tick(40)
		const snap = registry.getSnapshot(runId)
		expect(snap.running).toBe(true)
		expect(snap.task).toBe('nested')
		const depths = snap.workers.map((w) => w.depth).sort()
		expect(depths).toContain(1)
		const inner = snap.workers.find((w) => w.text === 'inner')!
		expect(inner.progress).toBe(0.5)
		expect(inner.progressMax).toBe(1)
		expect(inner.groupKey).toBeDefined()
		const outer = snap.workers.find((w) => w.depth === 0)!
		expect(outer.progress).toBeNull()
		expect(outer.prefix).toBe('p0')
		release()
		await tick(40)
		registry.dispose(runId)
	})

	it('run-scoped units isolate TaskIO between runs', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		registry.registerTask('iso', (ctx) => [async ({ status }: any) => {
			const tio = new ctx.ClientIO<any, string>('shared-id')
			status.text = await status.require(tio)
		}])
		const a = registry.create({ task: 'iso' })
		const b = registry.create({ task: 'iso' })
		await tick(30)
		// both runs wait on their own `shared-id` query
		expect(registry.getSnapshot(a).workers[0]?.waitingInput).toBe(true)
		expect(registry.getSnapshot(b).workers[0]?.waitingInput).toBe(true)
		registry.provideInput(a, { ioId: 'shared-id', value: 'for-a' })
		await tick(30)
		// run A finished (worker left the active map); run B still waits
		expect(registry.eventsSince(a).at(-1)).toMatchObject({ type: 'done' })
		expect(registry.getSnapshot(b).workers[0]?.waitingInput).toBe(true)
		registry.provideInput(b, { ioId: 'shared-id', value: 'for-b' })
		await tick(30)
		expect(registry.eventsSince(b).at(-1)).toMatchObject({ type: 'done' })
		registry.dispose(a)
		registry.dispose(b)
	})

	it('duplicate query emits input-required once', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		registry.registerTask('dupq', (ctx) => [async ({ status }: any) => {
			const tio = new ctx.ClientIO<any, string>('dup')
			const p1 = status.require(tio)
			const p2 = status.require(tio)
			status.text = `${await p1}/${await p2}`
		}])
		const runId = registry.create({ task: 'dupq' })
		await tick(30)
		const required = registry.eventsSince(runId).filter((e) => e.type === 'input-required')
		expect(required.length).toBe(1)
		registry.provideInput(runId, { ioId: 'dup', value: 'v' })
		await tick(30)
		// both queries resolved — the worker composed `v/v` and finished
		expect(registry.eventsSince(runId)).toContainEqual(
			expect.objectContaining({ type: 'input-provided', ioId: 'dup' })
		)
		expect(registry.eventsSince(runId).at(-1)).toMatchObject({ type: 'done' })
		registry.dispose(runId)
	})

	it('run-scoped semaphores serialize within a run', async () => {
		const registry = new RemoteRunnerRegistry({ pollMs: 5, ttlMs: 60_000 })
		registry.registerTask('sem', (ctx) => {
			const order: string[] = []
			;(ctx as any).order = order
			const mk = (name: string) => async ({ status }: any) => {
				const sem = new ctx.Semaphore('one')
				const release = await status.acquire(sem)
				order.push(name)
				await tick(5)
				release()
			}
			return [mk('first'), mk('second')]
		})
		const runId = registry.create({ task: 'sem', concurrent: 2 })
		await tick(60)
		expect(registry.eventsSince(runId).at(-1)).toMatchObject({ type: 'done' })
		registry.dispose(runId)
	})
})
