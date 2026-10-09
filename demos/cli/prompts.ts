import chalk from 'chalk'
import { cliRunner, type WorkerStatus, type WorkerTask } from 'ui-taskgraph/cli'
import { select } from '@inquirer/prompts'

// Assuming your TaskMgr classes are above or imported from your module:
// import { TaskMgr, WorkerStatus, WorkerTask } from './taskMgr'

async function runDemo() {
	console.log(chalk.bold.cyan('🚀 Starting Task Runner Demo (Concurrency: 4)\n'))

	// Generate 12 sample tasks with varying behaviors
	const tasks: WorkerTask[] = Array.from({ length: 12 }, (_, i) => {
		const id = i + 1

		const workerFn: WorkerTask = async (status: WorkerStatus) => {
			// 1. Initial state
			status.text = `Task #${id}: Connecting to service...`
			status.spinColor = chalk.cyanBright
			cliRunner.infos['Active Phase'] = `Task ${id} booting`
			await new Promise((r) => setTimeout(r, 400 + Math.random() * 600))

			// 2. Processing state with custom prefix and color shift
			status.text = `Task #${id}: Fetching & parsing payloads`
			status.spinColor = chalk.yellowBright
			status.prefix = chalk.gray(`[W-${id}]`)
			await new Promise((r) => setTimeout(r, 800 + Math.random() * 1000))

			// 3. Conditional: Simulate a temporary pause/waiting state on every 3rd task
			if (id % 3 === 0) {
				status.pause = chalk.magenta('⏸')
				status.text = `Task #${id}: Rate-limited, waiting...`
				cliRunner.log(
					chalk.yellow(`⚠ Worker on Task #${id} hit a rate limit, pausing momentarily.`)
				)
				await new Promise((r) => setTimeout(r, 1200))
				status.pause = false // Resume spinning
			}
			if (id % 5 === 0) {
				const tier = await cliRunner.interact(
					() => select({
						message: 'Select deployment target tier:',
						choices: [
							{ name: 'Standard (US-East)', value: 'us-east' },
							{ name: 'Performance (EU-West)', value: 'eu-west' },
						],
					})
				)
				cliRunner.log(chalk.gray(`[W-${id}] Selected tier: ${tier}`))
			}

			// 4. Finalizing state
			status.text = `Task #${id}: Writing results to disk`
			status.spinColor = chalk.blueBright
			await new Promise((r) => setTimeout(r, 500 + Math.random() * 500))

			// 5. Clean completion log using mgr.log
			cliRunner.log(chalk.green(`✔ Completed Task #${id} successfully.`))
		}

		// Give the function a name so worker.text initializes cleanly
		Object.defineProperty(workerFn, 'name', { value: `Task #${id}` })
		return workerFn
	})

	// Initialize Task Manager with concurrency of 4
	cliRunner.start(tasks, 4)

	// Populate global status metrics to test the top status bar
	cliRunner.infos['Total Tasks'] = '12'
	cliRunner.infos['Cluster'] = 'Local-Node-01'
	cliRunner.infos['Environment'] = 'Development'

	// Wait until all workers drain the iterator
	await cliRunner.finished

	// Clean up or print final summary
	console.log(chalk.bold.green('\n✨ All tasks processed successfully! Shutting down runner.'))
}

runDemo().catch((err) => {
	console.error(chalk.red('Fatal Error in Demo:'), err)
	process.exit(1)
})
