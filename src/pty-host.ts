// The PTY host: a small detached process that owns every agent terminal, so restarting the server
// does not kill them. Pitfalls taken from Orca's src/main/daemon/AGENTS.md: only one host per socket,
// never treat a timeout as a dead host, and never kill a host over a version mismatch.
//
// Protocol: one JSON object per line over ${WHIPLASH_HOME}/pty.sock.
//   requests: hello{version} list open{id,command,args,cwd,env,cols,rows,meta} write{id,data}
//             resize{id,cols,rows} kill{id} colors{foreground,background}
//   replies/events: hello{version,pid} list{sessions} data{id,data} exit{id,code}
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createColorQueryResponder, setTerminalColors } from './terminal-color-queries.ts'

export const PTY_HOST_VERSION = 1
export const BUFFER_LIMIT = 256 * 1024

/** Calls onLine for every complete line; a line torn across chunks waits for the rest. */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let pending = ''
  return (chunk) => {
    const lines = (pending + chunk).split('\n')
    pending = lines.pop()!
    for (const line of lines) if (line) onLine(line)
  }
}

export const socketPath = (home: string): string => join(home, 'pty.sock')

type Pty = {
  pid: number
  cols: number
  rows: number
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (event: { exitCode: number }) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: string) => void
}

/** node-pty 1.1.0 ships its macOS spawn helper without the execute bit, which fails every spawn.
 *  Same repair as Orca's local-pty-executable-spawn.ts: macOS only, keep the other mode bits, never throw. */
function loadPty(): { spawn: (file: string, args: string[], options: object) => Pty } {
  const require = createRequire(import.meta.url)
  const helper = join(dirname(require.resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  try {
    if (process.platform === 'darwin' && existsSync(helper)) {
      const mode = statSync(helper).mode
      if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755)
    }
  } catch (error) {
    console.warn('[pty-host] could not make node-pty spawn-helper executable', error)
  }
  return require('node-pty')
}

type HostSession = { pty: Pty; buffer: string; meta: unknown }

function runHost(home: string): void {
  const nodePty = loadPty()
  const sessions = new Map<string, HostSession>()
  const clients = new Set<Socket>()
  const send = (message: object): void => {
    const line = JSON.stringify(message) + '\n'
    clients.forEach((client) => client.write(line))
  }

  function open(request: { id: string; command: string; args: string[]; cwd: string; env: object; cols: number; rows: number; meta?: unknown }): void {
    if (sessions.has(request.id)) return sessions.get(request.id)!.pty.resize(request.cols, request.rows)
    let pty: Pty
    try {
      pty = nodePty.spawn(request.command, request.args, {
        name: 'xterm-256color',
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
        env: request.env
      })
    } catch (error) {
      console.error('[pty-host] spawn failed', request.command, error)
      return send({ type: 'exit', id: request.id, code: -1 })
    }
    const session: HostSession = { pty, buffer: '', meta: request.meta }
    sessions.set(request.id, session)
    // Answered here, not in the server: a CLI asks right after it starts and needs the reply on its own PTY.
    const answerColorQueries = createColorQueryResponder((reply) => pty.write(reply))
    pty.onData((raw) => {
      const data = answerColorQueries(raw)
      if (!data) return
      session.buffer = (session.buffer + data).slice(-BUFFER_LIMIT)
      send({ type: 'data', id: request.id, data })
    })
    pty.onExit(({ exitCode }) => {
      if (sessions.get(request.id) === session) sessions.delete(request.id)
      send({ type: 'exit', id: request.id, code: exitCode })
    })
  }

  function handle(client: Socket, message: any): void {
    const session = typeof message.id === 'string' ? sessions.get(message.id) : undefined
    switch (message.type) {
      case 'hello':
        if (message.version !== PTY_HOST_VERSION) {
          console.warn(`[pty-host] client speaks protocol ${message.version}, host speaks ${PTY_HOST_VERSION}`)
        }
        client.write(JSON.stringify({ type: 'hello', version: PTY_HOST_VERSION, pid: process.pid }) + '\n')
        return
      case 'list':
        client.write(
          JSON.stringify({
            type: 'list',
            sessions: [...sessions].map(([id, { pty, buffer, meta }]) => ({ id, cols: pty.cols, rows: pty.rows, buffer, meta }))
          }) + '\n'
        )
        return
      case 'open':
        return open(message)
      case 'write':
        return session?.pty.write(message.data)
      case 'resize':
        return session?.pty.resize(message.cols, message.rows)
      case 'kill':
        return session?.pty.kill('SIGHUP')
      case 'colors':
        return setTerminalColors(message)
    }
  }

  const server = createServer((client) => {
    clients.add(client)
    client.setEncoding('utf8')
    client.on(
      'data',
      createLineSplitter((line) => {
        try {
          handle(client, JSON.parse(line))
        } catch (error) {
          console.error('[pty-host] bad request', error)
        }
      })
    )
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
  })

  const path = socketPath(home)
  const listen = (): void => {
    server.listen(path, () => console.log(`[pty-host] pid ${process.pid} listening on ${path}`))
  }
  let retried = false
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') throw error
    // Someone holds the path. Only a refused connection proves it is a stale file; anything else, keep out of the way.
    const probe = connect(path)
    probe.once('connect', () => {
      console.log('[pty-host] another host is alive; exiting')
      probe.destroy()
      process.exit(0)
    })
    probe.once('error', (probeError: NodeJS.ErrnoException) => {
      if (probeError.code !== 'ECONNREFUSED' || retried) {
        console.error('[pty-host] socket is busy and its owner is unknown; exiting', probeError.code)
        process.exit(1)
      }
      retried = true
      unlinkSync(path)
      listen()
    })
  })
  mkdirSync(home, { recursive: true })
  listen()
  // The server going away is the whole point of this process; only an explicit kill ends a session.
  process.on('SIGHUP', () => {})
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runHost(process.env.WHIPLASH_HOME ?? join((await import('node:os')).homedir(), '.whiplash'))
}
