import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'

export async function serveBuild(directory) {
  const root = resolve(directory)
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' }
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/country_quiz\/?/, '')
      const file = resolve(root, pathname || 'index.html')
      if (!file.startsWith(root + sep)) throw new Error('Invalid path')
      res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream')
      res.end(await readFile(file))
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}/country_quiz/`, close: () => server.close() }
}
