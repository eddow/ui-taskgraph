import { describe, expect, it, vi } from 'vitest'
import { disposable, once, usable } from './utils.js'

describe('once', () => {
	it('calls fn exactly once', () => {
		const fn = vi.fn()
		const wrapped = once(fn)
		wrapped()
		wrapped()
		wrapped()
		expect(fn).toHaveBeenCalledTimes(1)
	})
})

describe('disposable', () => {
	it('disposes a bare function via call and Symbol.dispose', () => {
		const fn = vi.fn()
		const d = disposable(fn)
		expect(typeof d).toBe('function')
		d()
		d()
		expect(fn).toHaveBeenCalledTimes(1)
		const fn2 = vi.fn()
		const d2 = disposable(fn2)
		d2[Symbol.dispose]()
		d2[Symbol.dispose]()
		expect(fn2).toHaveBeenCalledTimes(1)
	})

	it('attaches Symbol.dispose to an object without double-disposing', () => {
		const fn = vi.fn()
		const org = { name: 'x' }
		const d = disposable(fn, org)
		expect(d).toBe(org)
		expect(typeof (d as any)[Symbol.dispose]).toBe('function')
		d[Symbol.dispose]()
		d[Symbol.dispose]()
		expect(fn).toHaveBeenCalledTimes(1)
	})
})

describe('usable', () => {
	it('begins specs and ends on dispose', () => {
		const begin = vi.fn()
		const end = vi.fn()
		const make = usable((() => ({ begin, end })) as () => {
			begin(...a: string[]): void
			end(): void
		})
		const d = make('a', 'b')
		expect(begin).toHaveBeenCalledWith('a', 'b')
		expect(end).not.toHaveBeenCalled()
		d[Symbol.dispose]()
		expect(end).toHaveBeenCalledTimes(1)
		d[Symbol.dispose]()
		expect(end).toHaveBeenCalledTimes(1)
	})
})
