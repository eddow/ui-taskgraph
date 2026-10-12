import { tasksHandler } from 'ui-taskgraph/sveltekit/server'
import { registry } from '$lib/server/registry.js'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = tasksHandler(registry, { base: '/tasks' })
