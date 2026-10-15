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

export { TaskSyncError } from '../task-sync.js'

import * as generic from '../task-sync.js'
export type Semaphore = generic.Semaphore<WorkerStatus>
export const Semaphore = generic.Semaphore
export type TaskIO<T> = generic.TaskIO<WorkerStatus, T>
export const TaskIO = generic.TaskIO

export const commonFrames = {
	standard: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏',
	pause: '⏸',
	double: ['⡇⠀', '⠏⠀', '⠋⠁', '⠉⠉', '⠈⠙', '⠀⠹', '⠀⢸', '⠀⣰', '⢀⣠', '⣀⣀', '⣄⡀', '⣆⠀'],
	doublePause: '⠰⠆',
	wave: ' ▂▃▄▅▆▇█▇▆▅▄▃▂',
	clock: [...'🕐🕑🕒🕓🕔🕕🕖🕗🕘🕙🕚🕛'],
	moon: [...'🌑🌒🌓🌔🌕🌖🌗🌘'],
}

/** Maps registry `tone` ids to CLI colors. Custom tones fall back to white. */
export const toneColors: Record<string, ChalkInstance> = {
	green: chalk.greenBright,
	magenta: chalk.magenta,
	cyan: chalk.cyanBright,
	red: chalk.redBright,
	'green-dim': chalk.green.dim,
}

const blocks = ' ▏▎▍▌▋▊▉'
const block = '█'
export type FrameSpecs = { chars: string | string[]; duration: number; color: ChalkInstance }
export type VisualConfig = {
	textColor: ChalkInstance
	frames: FrameSpecs
	liner: (params: {
		indent: string
		prefix: string
		spin: string
		progress: string
		text: string
	}) => string
}
const defaultVisualConfig: VisualConfig = {
	textColor: chalk.reset,
	frames: {
		chars: commonFrames.double,
		duration: 80,
		color: chalk.greenBright,
	},
	liner: ({ indent, prefix, spin, progress, text }) =>
		`${indent}${prefix}${spin}${progress} ${text}`,
}
export class WorkerStatus extends AWorkerStatus {
	readonly #startTS: number
	get advance() {
		return Date.now() - this.#startTS
	}
	constructor() {
		super()
		this.#startTS = Date.now()
	}
	async waitInput(promise: Promise<void>) {
		await promise
	}
}
export type TaskGroup = ATaskGroup<WorkerStatus, WorkerTask, GroupRunner> & { runner: CliRunner }
export class GroupRunner extends AGroupRunner<WorkerStatus, WorkerTask> {
	declare runner: CliRunner
	declare active: Map<WorkerStatus, GroupRunner | undefined>
	readonly status: WorkerStatus
	constructor(parent: TaskGroup, text?: string, workers?: WorkerTask | Iterable<WorkerTask>) {
		super(parent, workers)
		this.status = new WorkerStatus()
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
	const entries = Object.entries(infos).map(([k, v]) =>
		k.includes('$$') ? k.replace('$$', v) : `${k} ${v}`
	)
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
	return rv.join('\n')
}

class CliRunner extends TasksRunner<WorkerStatus, WorkerTask, GroupRunner> {
	visual: VisualConfig = Object.create(defaultVisualConfig)
	indentation: string = ' '
	progressLength: number = 8
	progressColor = chalk.cyanBright.bgBlackBright
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
			if (Object.keys(group.infos).length > 0) printLine(infoLine(group.infos))
		}
		const indentedList = (active: Map<WorkerStatus, GroupRunner | undefined>, indent = '') => {
			for (const [worker, group] of active.entries()) {
				const def = this.resolveState(worker.state)
				const spin = (() => {
					const glyph = def.icon ?? ''
					if (!def.spinner) return (toneColors[def.tone] ?? chalk.white)(glyph)
					const color = toneColors[def.tone] ?? chalk.white
					if (!(def.intervalMs && Number.isFinite(def.intervalMs))) return color(def.spinner)
					const frames = def.spinner
					return color(frames[Math.floor(worker.advance / def.intervalMs) % frames.length])
				})()
				let progress = ''
				const workerProgress = worker.progress()
				if (!Number.isNaN(workerProgress)) {
					const p = Math.floor(workerProgress * this.progressLength)
					const i = Math.floor(workerProgress * this.progressLength * blocks.length) % blocks.length
					progress =
						p === this.progressLength
							? `${block.repeat(p)}`
							: `${block.repeat(p)}${blocks[i]}${' '.repeat(this.progressLength - p - 1)}`
				}
				printLine(
					this.visual.liner({
						indent,
						prefix: worker.icon || '',
						spin,
						progress: this.progressColor(progress),
						text: this.visual.textColor(worker.text || ''),
					})
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
		if (!hookDisplay) return
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
