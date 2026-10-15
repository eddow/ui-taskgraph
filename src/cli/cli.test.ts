import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cliRunner, commonFrames, GroupRunner, infoLine, WorkerStatus } from './index.js'

describe('commonFrames', () => {
	it('exposes spinner frame sets', () => {
		expect(typeof commonFrames.standard).toBe('string')
		expect(Array.isArray(commonFrames.double)).toBe(true)
		expect(commonFrames.pause).toBeDefined()
		expect(typeof commonFrames.wave).toBe('string')
		expect(Array.isArray(commonFrames.clock)).toBe(true)
		expect(Array.isArray(commonFrames.moon)).toBe(true)
	})
})

describe('infoLine', () => {
	it('joins entries with separator', () => {
		const line = infoLine({ a: '1', b: '2' })
		expect(line).toContain('a 1')
		expect(line).toContain('b 2')
	})

	it('replaces $$ placeholder with value', () => {
		expect(infoLine({ 'build $$': 'ok' })).toContain('build ok')
	})

	it('wraps when exceeding terminal width', () => {
		const orig = process.stdout.columns
		Object.defineProperty(process.stdout, 'columns', { value: 20, configurable: true })
		try {
			const line = infoLine({ aaaaa: '11111', bbbbb: '22222', ccccc: '33333' })
			expect(line.split('\n').length).toBeGreaterThan(1)
		} finally {
			Object.defineProperty(process.stdout, 'columns', { value: orig, configurable: true })
		}
	})

	it('handles empty infos', () => {
		expect(infoLine({})).toBe('')
	})
})

describe('WorkerStatus', () => {
	it('tracks elapsed time', () => {
		const s = new WorkerStatus()
		expect(s.advance).toBeGreaterThanOrEqual(0)
		expect(s.state).toBe('active')
	})

	it('pause() sets paused state and restores on dispose', () => {
		const s = new WorkerStatus()
		const d = s.pause()
		expect(s.state).toBe('paused')
		d[Symbol.dispose]()
		expect(s.state).toBe('active')
	})

	it('pause() stacks LIFO', () => {
		const s = new WorkerStatus()
		const d1 = s.pause()
		s.state = 'waiting-input'
		const d2 = s.pause()
		expect(s.state).toBe('paused')
		d2[Symbol.dispose]()
		expect(s.state).toBe('waiting-input')
		d1[Symbol.dispose]()
		// d1's restore is dropped: state moved on while paused
		expect(s.state).toBe('waiting-input')
	})

	it('prefix aliases icon', () => {
		const s = new WorkerStatus()
		s.prefix = '📡'
		expect(s.icon).toBe('📡')
		s.icon = '🧠'
		expect(s.prefix).toBe('🧠')
	})

	it('waitInput awaits the promise', async () => {
		const s = new WorkerStatus()
		let done = false
		const p = s.waitInput(
			new Promise<void>((r) =>
				setTimeout(() => {
					done = true
					r()
				}, 5)
			)
		)
		expect(done).toBe(false)
		await p
		expect(done).toBe(true)
	})
})

describe('GroupRunner', () => {
	it('creates status with text and inherits runner', async () => {
		const order: string[] = []
		cliRunner.start([
			async () => {
				order.push('w')
			},
		])
		await cliRunner.finished
		expect(order).toEqual(['w'])
		const parent = cliRunner as any
		const sub = new GroupRunner(parent, 'subtext')
		expect(sub.status.text).toBe('subtext')
		expect(sub.runner).toBe(cliRunner)
		const sub2 = new GroupRunner(parent)
		expect(sub2.status.text).toBeUndefined()
	})
})

describe('cliRunner', () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true as any)
		vi.spyOn(console, 'log').mockImplementation(() => {})
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('is a singleton', async () => {
		const { default: again } = await import('./index.js')
		expect(again).toBe(cliRunner)
	})

	it('log writes via console.log when idle', () => {
		cliRunner.log('hello', 123)
		expect(console.log).toHaveBeenCalledWith('hello', 123)
	})

	it('reportWorkerError logs error messages', () => {
		;(cliRunner as any).reportWorkerError(new Error('worker-fail'), async () => {})
		expect(console.log).toHaveBeenCalled()
		;(cliRunner as any).reportWorkerError({ odd: 1 }, async () => {})
		expect(console.log).toHaveBeenCalled()
	})

	it('runs workers and clears the display timer', async () => {
		let ran = false
		cliRunner.header = 'HDR'
		cliRunner.footer = 'FTR'
		cliRunner.infos = { k: 'v' }
		cliRunner.start(async ({ status }) => {
			status.text = 'doing'
			status.icon = '>'
			status.progress(0.5, 1)
			ran = true
		})
		await cliRunner.finished
		expect(ran).toBe(true)
		cliRunner.header = undefined
		cliRunner.footer = undefined
		cliRunner.infos = {}
	})

	it('reports progress bars including complete state', async () => {
		cliRunner.start(async ({ status }) => {
			status.text = 'full'
			status.progress(1, 1)
		})
		await cliRunner.finished
		expect(process.stdout.write).toHaveBeenCalled()
	})

	it('interact passes through when idle', async () => {
		const rv = await cliRunner.interact(async () => 42)
		expect(rv).toBe(42)
	})

	it('interact queues concurrent interactions while running', async () => {
		let release!: () => void
		const gate = new Promise<void>((r) => (release = r))
		cliRunner.start([
			async () => {
				await gate
			},
			async () => {
				await gate
			},
		])
		await new Promise((r) => setTimeout(r, 30))
		const p1 = cliRunner.interact(async () => 'first')
		const p2 = cliRunner.interact(async () => 'second')
		release()
		await cliRunner.finished
		await expect(p1).resolves.toBe('first')
		await expect(p2).resolves.toBe('second')
	})

	it('draws nested groups and NaN progress without crashing', async () => {
		cliRunner.start(async ({ status, group }) => {
			status.text = 'parent'
			const sub = new GroupRunner(group as any, 'child')
			sub.infos = { sub: 'info' }
			sub.start(async ({ status: s2 }) => {
				s2.text = 'leaf'
			})
			await sub.finished
		})
		await cliRunner.finished
		expect(process.stdout.write).toHaveBeenCalled()
	})

	it('holds the default state registry and resolves unknown ids to active', () => {
		for (const id of ['active', 'paused', 'waiting-input', 'error', 'done'])
			expect(cliRunner.states[id]).toBeDefined()
		expect(cliRunner.resolveState('nope')).toBe(cliRunner.states.active)
	})

	it('registerState adds custom states', () => {
		cliRunner.registerState('custom', { spinner: null, intervalMs: 0, tone: 'cyan', icon: '★' })
		expect(cliRunner.resolveState('custom').icon).toBe('★')
		delete cliRunner.states['custom']
	})

	it('sets done state on worker success and error state on failure', async () => {
		let okStatus: WorkerStatus | undefined
		let errStatus: WorkerStatus | undefined
		cliRunner.start([
			async ({ status }) => {
				okStatus = status
			},
			async ({ status }) => {
				errStatus = status
				throw new Error('boom')
			},
		])
		await cliRunner.finished
		expect(okStatus?.state).toBe('done')
		expect(errStatus?.state).toBe('error')
	})
})
