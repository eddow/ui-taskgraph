// Demo task registry for the SvelteKit demo.
//
// One module-level `RemoteRunnerRegistry` per server process (in-memory,
// non-persistent). It holds *many* concurrent runs — the runner is not a
// singleton. Demo tasks are registered here; routes in `src/routes/tasks/`
// delegate to it via the agnostic `handleRemoteRequest`.

import { RemoteRunnerRegistry } from 'ui-taskgraph/web'

export const registry = new RemoteRunnerRegistry({ pollMs: 150 })

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

registry.registerTask('download', () => [
	async ({ status }: any) => {
		status.text = 'Connecting…'
		await wait(400)
		status.text = 'Downloading'
		for (let i = 0; i <= 20; i++) {
			status.progress(i / 20)
			await wait(120)
		}
		status.text = 'Done'
	},
	async ({ status }: any) => {
		status.text = 'Verifying checksum'
		for (let i = 0; i <= 10; i++) {
			status.progress(i / 10)
			await wait(150)
		}
		status.text = 'Verified'
	},
])

registry.registerTask('deploy', (ctx) => {
	const { GroupRunner, runner } = ctx
	const group = new GroupRunner(runner as any, 'deploy')
	group.start([
		async ({ status }: any) => {
			status.text = 'Building'
			for (let i = 0; i <= 10; i++) {
				status.progress(i / 10)
				await wait(150)
			}
		},
		async ({ status }: any) => {
			status.text = 'Pushing image'
			for (let i = 0; i <= 10; i++) {
				status.progress(i / 10)
				await wait(200)
			}
		},
	])
	return [
		async ({ status }: any) => {
			status.text = 'Preparing deploy'
			await wait(500)
			status.text = 'Deploy ready'
		},
	]
})

registry.registerTask('onboard', (ctx) => [
	async ({ status }: any) => {
		const name = new ctx.ClientIO('name')
		status.text = 'Waiting for your name…'
		status.text = `Hello, ${await status.require(name)}!`
		await wait(400)
	},
])
