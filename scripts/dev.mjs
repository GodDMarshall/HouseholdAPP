// Development: run the hub (restarts on change) and the app dev server together.
//   npm run dev      -> hub on :8080, app with hot reload on :5173
import { spawn } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const procs = []

function run(name, args, colour) {
  const child = spawn(npm, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  const tag = `\x1b[${colour}m[${name}]\x1b[0m `
  const pipe = (stream, out) => {
    let buf = ''
    stream.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) out.write(tag + line + '\n')
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  child.on('exit', (code) => {
    process.stdout.write(`${tag}stopped (${code})\n`)
    stopAll()
  })
  procs.push(child)
}

let stopping = false
function stopAll() {
  if (stopping) return
  stopping = true
  for (const p of procs) if (!p.killed) p.kill()
  setTimeout(() => process.exit(0), 300)
}
process.on('SIGINT', stopAll)
process.on('SIGTERM', stopAll)

run('hub', ['run', 'dev', '-w', 'hub'], 36)
run('app', ['run', 'dev', '-w', 'app'], 35)
console.log('Hub: http://localhost:8080   App (hot reload): http://localhost:5173')
