import { stripVTControlCharacters } from 'node:util'
import type { ChalkInstance } from 'chalk'
import chalk from 'chalk'
import {
	AGroupRunner,
	type ATaskGroup,
	type IWorkerStatus,
	type IWorkerTask,
	TasksRunner,
} from '../runner.js'

export class WorkerStatus implements IWorkerStatus {
	readonly #startTS: number
	get advance() {
		return Date.now() - this.#startTS
	}
	prefix?: string
	text?: string
	spinColor: ChalkInstance = chalk.greenBright
	textColor: ChalkInstance = chalk.reset
	pause: string | false = false
	constructor() {
		this.#startTS = Date.now()
	}
}
export type TaskGroup = ATaskGroup<WorkerStatus, GroupRunner, WorkerTask>
export class GroupRunner extends AGroupRunner<WorkerStatus, WorkerTask> {
	readonly status = new WorkerStatus()
	constructor(
		parent: ATaskGroup<WorkerStatus, GroupRunner, WorkerTask>,
		text?: string,
		workers?: WorkerTask | Iterable<WorkerTask>
	) {
		super(parent, workers)
		if (text) this.status.text = text
	}
}
type Interval = ReturnType<typeof setInterval>
export type WorkerTask = IWorkerTask<WorkerStatus>

const cursor = {
	show() {
		process.stdout.write('\x1b[?25h')
	},
	hide() {
		process.stdout.write('\x1b[?25l')
	},
}
function clearTerm() {
	process.stdout.write('\x1b[0J') // clear terminal on/below current line
	// line: process.stdout.write('\x1b[2K')
	if (hookDisplay) {
		for (const params of hookDisplay.logging) console.log(...params)
		hookDisplay.logging = []
	}
	cursor.show()
}
let interacting: (() => void)[] | undefined
let hookDisplay:
	| {
			interval: Interval
			logging: any[][]
	  }
	| undefined

class CliRunner extends TasksRunner<WorkerStatus> {
	frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
	indentation: string = ' '
	frame(advance: number) {
		return this.frames[Math.floor(advance / 80) % this.frames.length]
	}
	console: boolean = true
	#drawConsole() {
		clearTerm()
		if (!cliRunner.console || interacting) return
		let lines = 0
		const currentWidth = process.stdout.columns
		function printLine(line: string) {
			const multi = line.split('\n')
			for (let l of multi) {
				l = `${l}\n`
				process.stdout.write(l)
				lines += Math.ceil(stripVTControlCharacters(l).length / currentWidth)
			}
		}
		if (cliRunner.header) printLine(cliRunner.header)
		if (Object.keys(cliRunner.infos).length > 0) {
			// TODO: generalize infos string and console.log it as the end
			const statuses = Object.entries(cliRunner.infos).map(([k, v]) => `${k}: ${v}`)
			while (statuses.length > 0) {
				let statusLine = statuses.shift()!
				while (
					statuses[0] &&
					statusLine.length + 3 + stripVTControlCharacters(statuses[0]).length < currentWidth
				)
					statusLine = `${statusLine} | ${statuses.shift()}`
				printLine(statusLine)
			}
		}
		const indentedList = (active: Map<WorkerStatus, GroupRunner | undefined>, indent = '') => {
			for (const [worker, group] of active.entries()) {
				printLine(
					`${indent}${worker.prefix ? `${worker.prefix} ` : ''}${worker.pause || worker.spinColor(this.frame(worker.advance))} ${worker.textColor(worker.text || '')}`
				)
				if (group) indentedList(group.active, indent + this.indentation)
			}
		}
		indentedList(this.active)
		if (cliRunner.footer) printLine(cliRunner.footer)
		cursor.hide()
		process.stdout.write(`\x1b[${lines}A`)
	}
	static get singleton() {
		return cliRunner || new CliRunner()
	}
	private constructor() {
		super()
	}
	header?: string
	footer?: string
	//#region Parent provision
	reportWorkerError(error: any, _worker: WorkerTask): void {
		cliRunner.log(chalk.red('Error occurred while processing worker'))
		cliRunner.log(chalk.redBright(error.message || JSON.stringify(error, null, '\t')))
	}
	protected newStatus(): WorkerStatus {
		return new WorkerStatus()
	}

	protected startRun() {
		if (!hookDisplay) {
			hookDisplay = {
				interval: setInterval(() => this.#drawConsole(), 80),
				logging: [],
			}
		}
		super.startRun()
	}
	protected endRun() {
		super.endRun()
		clearInterval(hookDisplay?.interval)
		clearTerm()
		hookDisplay = undefined
	}

	//#endregion

	log(...params: any[]) {
		if (hookDisplay) hookDisplay.logging.push(params)
		else {
			clearTerm()
			console.log(...params)
		}
	}
	async interact<T>(interaction: () => Promise<T>): Promise<T> {
		if (!hookDisplay) return interaction()
		const nextInteraction = () => {
			const next = interacting!.shift()
			if (next) {
				clearTerm()
				next()
			} else {
				interacting = undefined
				this.#drawConsole()
				hookDisplay = {
					interval: setInterval(() => this.#drawConsole(), 80),
					logging: [],
				}
			}
		}
		if (interacting) {
			let resolve: (x: T | PromiseLike<T>) => void
			interacting.push(async () => {
				resolve(await interaction())
				nextInteraction()
			})
			return new Promise<T>((res) => {
				resolve = res
			})
		}
		interacting = []
		clearInterval(hookDisplay?.interval)
		clearTerm()
		const rv = await interaction()
		nextInteraction()
		return rv
	}
}
export let cliRunner: CliRunner
cliRunner = CliRunner.singleton
export default cliRunner
