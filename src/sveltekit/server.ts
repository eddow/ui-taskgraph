// Thin SvelteKit server adapter for web taskgraph execution.
//
// Plain TypeScript, no Svelte runes: this module is compiled by the package
// `tsc` build like `src/web`. It only adapts SvelteKit route handlers to the
// framework-agnostic `handleRemoteRequest` — all protocol logic lives there.

import { handleRemoteRequest, type RemoteRunnerRegistry } from '../web/index.js'

export interface TasksHandlerOptions {
	/** Route prefix the handler is mounted on, e.g. `/tasks`. */
	base: string
	/** Heartbeat comment interval (ms) for SSE streams. `0` disables. */
	heartbeatMs?: number
}

/**
 * Creates a SvelteKit request handler delegating to the agnostic protocol.
 * Mount the returned handler on every tasks route (`+server.ts` files):
 *
 * ```ts
 * // src/routes/tasks/+server.ts
 * import { tasksHandler } from 'ui-taskgraph/sveltekit/server'
 * import { registry } from '$lib/server/registry.js'
 * const handle = tasksHandler(registry, { base: '/tasks' })
 * export const GET = handle
 * export const POST = handle
 * export const DELETE = handle
 * ```
 */
export function tasksHandler(registry: RemoteRunnerRegistry, opts: TasksHandlerOptions) {
	return async ({ request }: { request: Request }): Promise<Response> => {
		const response = await handleRemoteRequest(request, registry, opts)
		return response ?? new Response('Not found', { status: 404 })
	}
}
