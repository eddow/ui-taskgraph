// Reactive Svelte adapter for web taskgraph execution.
//
// This module uses Svelte 5 runes and is compiled by `svelte-package`
// (not the package `tsc` build — see `tsconfig.json` `exclude`).
// It wraps the framework-agnostic `RemoteRunnerClient` so every piece of
// run state is directly usable in markup: no manual `$state` mirroring.

// Loads Svelte's ambient rune globals (`$state`, ...). Type-only: erased at
// emit, but required because nothing else here imports from 'svelte'.
import type {} from 'svelte'
import {
	type EventStream,
	eventSourceStream,
	fetchRequester,
	RemoteRunnerClient,
	type RunId,
	type WorkerSnapshot,
} from '../web/index.js'

export type { WorkerSnapshot }
export { RemoteRunnerClient }

/** Client-side copy of the runner state registry (tone → CSS class). */
export type ClientStateDef = {
	tone: string
	icon?: string
}
export const clientStates: Record<string, ClientStateDef> = {
	active: { tone: 'active' },
	paused: { tone: 'paused', icon: '⏸' },
	'waiting-input': { tone: 'waiting', icon: '📥' },
	error: { tone: 'error', icon: '❌' },
	done: { tone: 'done', icon: '✅' },
}
export function resolveClientState(id: string): ClientStateDef {
	return clientStates[id] ?? clientStates.active!
}

/** `EventSource` only exists in the browser — SSR gets a stub stream. */
function browserEventStream(): EventStream {
	return typeof EventSource === 'undefined'
		? { subscribe: () => () => {} }
		: eventSourceStream(EventSource)
}

/**
 * A single worker status with fully reactive fields. Wraps an immutable
 * {@link WorkerSnapshot} so the demo (or host app) can bind it directly:
 *
 * ```svelte
 * {#each run.workers as w (w.key)}
 *   <li>{w.text} {w.progress}</li>
 * {/each}
 * ```
 */
export class WorkerStatus {
	readonly key: string
	readonly groupKey: string | undefined
	readonly depth: number
	state = $state<string>('active')
	icon = $state<string | undefined>(undefined)
	text = $state<string | undefined>(undefined)
	progress = $state<number | null>(null)
	progressMax = $state(1)
	waitingInput = $state(false)

	constructor(snapshot: WorkerSnapshot) {
		this.key = snapshot.key
		this.groupKey = snapshot.groupKey
		this.depth = snapshot.depth
		this.sync(snapshot)
	}

	/** Applies a fresh snapshot in place (preserves object identity). */
	sync(snapshot: WorkerSnapshot): void {
		this.state = snapshot.state ?? 'active'
		this.icon = snapshot.icon
		this.text = snapshot.text
		this.progress = snapshot.progress
		this.progressMax = snapshot.progressMax
		this.waitingInput = snapshot.waitingInput
	}
}

/**
 * A reactive task run. All fields are `$state`, so the demo binds them
 * directly with no `onChange` mirror:
 *
 * ```svelte
 * <script>
 *   const run = createRun('/tasks')
 * </script>
 * {#if run.runId}
 *   {#each run.workers as w (w.key)}{w.text}{/each}
 * {/if}
 * <button onclick={() => run.start({ task })}>start run</button>
 * ```
 */
export class Run {
	readonly client: RemoteRunnerClient
	runId = $state<RunId | undefined>(undefined)
	running = $state(false)
	infos = $state<Record<string, string>>({})
	errors = $state<string[]>([])
	workers = $state<WorkerStatus[]>([])
	pendingInputs = $state<string[]>([])
	done = $state(false)

	constructor(base = '/tasks') {
		this.client = new RemoteRunnerClient({
			base,
			requester: fetchRequester(fetch),
			stream: browserEventStream(),
		})
		this.client.onChange(() => this.pull())
	}

	/** `POST {base}` — starts a run and opens the SSE stream. */
	async start(req: { task: string; params?: unknown; concurrent?: number }): Promise<RunId> {
		const runId = await this.client.start(req)
		this.pull()
		return runId
	}

	/** `POST {base}/{runId}/input` — resolves a pending `TaskIO` query. */
	sendInput(ioId: string, value: unknown): Promise<void> {
		return this.client.sendInput(ioId, value)
	}

	/** `DELETE {base}/{runId}` — disposes server state and clears local state. */
	async dispose(): Promise<void> {
		await this.client.dispose()
		this.pull()
	}

	private pull(): void {
		const client = this.client
		this.runId = client.runId
		this.running = client.snapshot?.running ?? !!client.runId
		this.infos = { ...(client.snapshot?.infos ?? {}) }
		this.errors = [...client.errors]
		this.done = client.done
		this.pendingInputs = [...client.pendingInputs]
		const seen = new Map(this.workers.map((w) => [w.key, w]))
		const next: WorkerStatus[] = []
		for (const snapshot of client.workers.values()) {
			const existing = seen.get(snapshot.key)
			if (existing) {
				existing.sync(snapshot)
				next.push(existing)
			} else next.push(new WorkerStatus(snapshot))
		}
		this.workers = next
	}
}

/** Creates a reactive {@link Run} bound to `base` (default `/tasks`). */
export function createRun(base = '/tasks'): Run {
	return new Run(base)
}
