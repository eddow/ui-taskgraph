import { stripVTControlCharacters } from 'node:util'
import type { ChalkInstance } from 'chalk'
import chalk from 'chalk'
import {
	AGroupRunner,
	type ATaskGroup,
	AWorkerStatus,
	type IWorkerTask,
	TasksRunner,
} from '../runner.js'

const blocks = ' ▏▎▍▌▋▊▉'
const block = '█'
export class WorkerStatus extends AWorkerStatus {
	readonly #startTS: number
	get advance() {
		return Date.now() - this.#startTS
	}
	spinColor: ChalkInstance = chalk.greenBright
	textColor: ChalkInstance = chalk.reset
	constructor() {
		super()
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
const infoSeparator = '·'
export function infoLine(infos: Record<string, string>, indent: string = '') {
	const entries = Object.entries(infos).map(([k, v]) => k.includes('$$') ? k.replace('$$', v) : `${k} ${v}`)
	const rv: string[] = []
	while (entries.length > 0) {
		let statusLine = indent + entries.shift()!
		while (
			entries[0] &&
			statusLine.length + 3 + stripVTControlCharacters(entries[0]).length < process.stdout.columns
		)
			statusLine = `${statusLine}${infoSeparator}${entries.shift()}`
		rv.push(statusLine)
	}
	return rv.join('\n');
}
class CliRunner extends TasksRunner<WorkerStatus> {
	// TODO: Standardize where the spin (characters, colors, ...) are set - now half here, half in the worker
	frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
	pause = '⏸'
	indentation: string = ' '
	progressLength: number = 8
	progressColor = chalk.cyanBright.bgBlackBright
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
		function printInfos(group: GroupRunner | CliRunner) {
			if (Object.keys(group.infos).length > 0)
				printLine(infoLine(group.infos))
		}
		const indentedList = (active: Map<WorkerStatus, GroupRunner | undefined>, indent = '') => {
			for (const [worker, group] of active.entries()) {
				const prefix = worker.prefix ? `${worker.prefix} ` : ''
				const spin =
					(worker.pause === true ? this.pause : worker.pause) ||
					worker.spinColor(this.frame(worker.advance))
				let progress = ''
				const workerProgress = worker.progress()
				if (!isNaN(workerProgress)) {
					const p = Math.floor(workerProgress * this.progressLength)
					const i = Math.floor(workerProgress * this.progressLength * blocks.length) % blocks.length
					progress =
						p === this.progressLength
							? `${block.repeat(p)}`
							: `${block.repeat(p)}${blocks[i]}${' '.repeat(this.progressLength - p - 1)}`
				}
				printLine(
					`${indent}${prefix}${spin}${this.progressColor(progress)} ${worker.textColor(worker.text || '')}`
				)
				if (group) {
					printInfos(group)
					indentedList(group.active, indent + this.indentation)
				}
			}
		}
		printInfos(cliRunner)
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
		console.log(infoLine(cliRunner.infos))
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
