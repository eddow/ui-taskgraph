export function once(fn: () => void) {
	let hasCalled = false
	return () => {
		if (!hasCalled) {
			hasCalled = true
			fn()
		}
	}
}
export function disposable<T extends {}>(
	disposer: () => void,
	org: T
): T & { [Symbol.dispose]: () => void }
export function disposable(disposer: () => void): (() => void) & { [Symbol.dispose]: () => void }
export function disposable(disposer: () => void, org?: any) {
	disposer = once(disposer)
	return Object.assign(org ?? disposer, { [Symbol.dispose]: disposer })
}

export type Usable<Params extends any[]> = {
	begin(...args: Params): void
	end(): void
}
export function usable<Params extends any[]>(specs: () => Usable<Params>) {
	return (...args: Params) => {
		const u = specs()
		u.begin(...args)
		return disposable(() => u.end())
	}
}
