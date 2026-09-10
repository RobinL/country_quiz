import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

// A separate production build projects every full-detail edge, with the same
// final viewport clip. It disables only the new hidden-chain optimization.
const directory = resolve('output/playwright/full-detail-reference-project')
await mkdir(directory, { recursive: true })
for (const file of ['src', 'public', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html']) {
  await cp(file, `${directory}/${file}`, { recursive: true, force: true })
}
try {
  await symlink(resolve('node_modules'), `${directory}/node_modules`, 'dir')
} catch (error) {
  if (error.code !== 'EEXIST') throw error
}
const filename = `${directory}/src/globe.ts`
const source = await readFile(filename, 'utf8')
if (source.split('clipPaths: true').length !== 2) throw new Error('Expected one hidden-chain optimization switch')
await writeFile(filename, source.replace('clipPaths: true', 'clipPaths: false'))
const { stdout } = await promisify(execFile)('npm', ['run', 'build'], { cwd: directory })
console.log(stdout.trim())
console.log(`Full-detail reference: ${directory}/dist`)
