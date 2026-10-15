<script lang="ts">
	import { createRun } from 'ui-taskgraph/sveltekit/client'

	const run = createRun('/tasks')
	let task = $state('download')
	let tasks = $state<string[]>(['download', 'deploy', 'onboard'])
	let inputValue = $state('')
	let starting = $state(false)
	let error = $state('')
	$effect(() => {
		fetch('/tasks', { headers: { Accept: 'application/json' } })
			.then((r) => r.json())
			.then((d) => {
				if (Array.isArray(d.tasks) && d.tasks.length) tasks = d.tasks
			})
			.catch(() => {})
	})

	async function start() {
		starting = true
		error = ''
		try {
			await run.start({ task })
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			starting = false
		}
	}

	async function send(ioId: string) {
		await run.sendInput(ioId, inputValue)
		inputValue = ''
	}

	function bar(p: number | null) {
		if (p === null || Number.isNaN(p)) return '░'.repeat(10)
		const n = Math.round(p * 10)
		return '█'.repeat(n) + '░'.repeat(10 - n)
	}
</script>

<main style="font-family: system-ui; max-width: 640px; margin: 2rem auto; padding: 0 1rem;">
	<h1>ui-taskgraph remote demo</h1>
	<p>
		<label>
			task
			<select bind:value={task}>
				{#each tasks as t}
					<option value={t}>{t}</option>
				{/each}
			</select>
		</label>
		<button onclick={start} disabled={starting}>{starting ? 'starting…' : 'start run'}</button>
		{#if run.runId}
			<button
				onclick={async () => {
					await run.dispose()
				}}>dispose</button
			>
		{/if}
	</p>
	{#if error}<p style="color: crimson;">{error}</p>{/if}
	{#if run.runId}
		<p><code>{run.runId}</code> {run.done ? '· done' : '· running'}</p>
		<ul>
			{#each run.workers as w (w.key)}
				<li style="margin-left: {w.depth * 1.5}rem;">
					<code>{bar(w.progress)}</code>
					{`${'  '.repeat(w.depth)}${w.icon ?? ''} ${w.text ?? ''}`}
					{#if w.state !== 'active'}<strong>[{w.state}]</strong>{/if}
					{#if w.waitingInput}<strong>⌛ waiting input</strong>{/if}
				</li>
			{/each}
		</ul>
		{#each run.pendingInputs as ioId (ioId)}
			<p>
				input <code>{ioId}</code>:
				<input bind:value={inputValue} placeholder="value" />
				<button onclick={() => send(ioId)}>send</button>
			</p>
		{/each}
		{#if run.errors.length}
			<ul>
				{#each run.errors as e}
					<li style="color: crimson;">{e}</li>
				{/each}
			</ul>
		{/if}
	{:else}
		<p>No run yet — pick a task and start. Open two tabs to see isolated runs.</p>
	{/if}
</main>
