import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { createLineSplitter } from './pty-host.ts'
import { connectPtyHost } from './terminal.ts'

describe('createLineSplitter', () => {
  it('joins a line torn across chunks and skips empty lines', () => {
    const lines: string[] = []
    const feed = createLineSplitter((line) => lines.push(line))
    feed('{"a":')
    feed('1}\n{"b"')
    feed(':2}\n\n{"c":3}')
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
    feed('\n')
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}'])
  })
})

/** A protocol client that waits for the first message matching `until`. */
function client(socket: Socket) {
  const messages: any[] = []
  const waiters: { until: (message: any) => boolean; resolve: (message: any) => void }[] = []
  socket.setEncoding('utf8')
  socket.on(
    'data',
    createLineSplitter((line) => {
      const message = JSON.parse(line)
      messages.push(message)
      for (const waiter of [...waiters]) {
        if (waiter.until(message)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(message)
        }
      }
    })
  )
  return {
    socket,
    send: (message: object) => socket.write(JSON.stringify(message) + '\n'),
    next: (until: (message: any) => boolean): Promise<any> =>
      new Promise((resolve) => {
        const seen = messages.find(until)
        if (seen) resolve(seen)
        else waiters.push({ until, resolve })
      })
  }
}

describe('pty host', () => {
  // A short path: macOS caps unix socket paths near 104 bytes.
  const home = mkdtempSync(join(tmpdir(), 'wph-'))
  let hostPid = 0
  after(() => {
    if (hostPid) process.kill(hostPid)
    rmSync(home, { recursive: true, force: true })
  })

  it('keeps a session and its output across a client reconnect', async () => {
    const first = client(await connectPtyHost(home))
    first.send({ type: 'hello', version: 1 })
    hostPid = (await first.next((message) => message.type === 'hello')).pid
    first.send({
      type: 'open',
      id: 'm1',
      command: '/bin/sh',
      args: [],
      cwd: home,
      env: { PATH: '/bin:/usr/bin', TERM: 'xterm-256color' },
      cols: 90,
      rows: 20,
      meta: { tag: 'kept' }
    })
    first.send({ type: 'write', id: 'm1', data: 'echo whip$((1+1))lash\r' })
    await first.next((message) => message.type === 'data' && message.data.includes('whip2lash'))

    // The server going away must not take the terminal with it.
    first.socket.destroy()

    const second = client(await connectPtyHost(home))
    second.send({ type: 'list' })
    const { sessions } = await second.next((message) => message.type === 'list')
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].id, 'm1')
    assert.equal(sessions[0].cols, 90)
    assert.deepEqual(sessions[0].meta, { tag: 'kept' })
    assert.match(sessions[0].buffer, /whip2lash/)

    second.send({ type: 'kill', id: 'm1' })
    await second.next((message) => message.type === 'exit' && message.id === 'm1')
    second.send({ type: 'list' })
    assert.deepEqual((await second.next((message) => message.type === 'list' && message.sessions.length === 0)).sessions, [])
  })

  it('a second host on the same socket steps aside', async () => {
    const hostPath = fileURLToPath(new URL('./pty-host.ts', import.meta.url))
    const code = await new Promise((resolve) =>
      spawn(process.execPath, [hostPath], { env: { ...process.env, WHIPLASH_HOME: home }, stdio: 'ignore' }).once('exit', resolve)
    )
    assert.equal(code, 0)
    process.kill(hostPid, 0) // still alive
  })
})
