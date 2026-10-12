import { tasksHandler } from 'ui-taskgraph/sveltekit/server'
import { registry } from '$lib/server/registry.js'
import type { RequestHandler } from './$types'

const handle: RequestHandler = tasksHandler(registry, { base: '/tasks' })

export const GET: RequestHandler = handle
export const DELETE: RequestHandler = handle
