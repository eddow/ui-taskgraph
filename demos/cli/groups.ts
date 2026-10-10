import { cliRunner, GroupRunner, TaskGroup} from 'ui-taskgraph/cli'

function temp(s: number) {
	return new Promise((resolve) => setTimeout(resolve, s*1000))
}

type FileNode = {
	name: string
	size: number
} | {
	name: string
	children: FileNode[]
}

const files: FileNode[] = [
	{
		name: 'src',
		children: [
			{ name: 'engine.ts', size: 45 },
			{ name: 'runner.ts', size: 32 },
			{ name: 'utils.ts', size: 14 }
		]
	},
	{
		name: 'assets',
		children: [
			{ name: 'banner.png', size: 80 },
			{ name: 'avatar.jpg', size: 70 },
			{ name: 'styles.css', size: 24 }
		]
	},
	{
		name: 'docs',
		children: [
			{ name: 'README.md', size: 6 },
			{ name: 'architecture.md', size: 18 }
		]
	},
	{ name: 'package.json', size: 3 }
]

function group(parent: TaskGroup, files: FileNode[]) {
	for(const node of files) {
		if('children' in node)
			group(new GroupRunner(parent, node.name), node.children)
		else
			parent.start(async ({ status }) => {
				status.text = `Downloading ${node.name}`
				const grain = 100
				for(let i = 0; i <= grain; i += 1) {
					status.progress(i / grain)
					await temp(node.size/5/grain)
				}
				cliRunner.log(`✅ ${node.name} downloaded`)
			})
	}
}
group(cliRunner, files)
// Execute pipeline with error handling
cliRunner.finished.catch((error) => {
    cliRunner.log('❌ Pipeline encountered a fatal error:', error);
    process.exit(1);
});