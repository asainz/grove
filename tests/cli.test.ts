import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

type CallLog = {
  bin: 'codex' | 'wkb'
  args: string[]
  cwd: string
}

const root = resolve(import.meta.dir, '..')
const entrypoint = join(root, 'index.ts')

let tmp: string
let binDir: string
let worktreePath: string
let logPath: string
let wkbPath: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'grove-test-'))
  binDir = join(tmp, 'bin')
  worktreePath = join(tmp, 'worktree')
  logPath = join(tmp, 'calls.jsonl')
  wkbPath = join(binDir, 'wkb')

  await mkdir(binDir)
  await mkdir(worktreePath)
  worktreePath = await realpath(worktreePath)
  await writeExecutable(wkbPath, fakeWorkboxScript())
  await writeExecutable(join(binDir, 'codex'), fakeCodexScript())
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

test('prints help without checking external dependencies', async () => {
  const result = await runGrove(['--help'], {
    PATH: '',
    GROVE_WKB_COMMAND: join(tmp, 'missing-wkb'),
  })

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('Usage:')
  expect(result.stdout).toContain('grove new <name>')
  expect(await readCalls()).toEqual([])
})

test('creates a session and routes workbox and codex args around the separator', async () => {
  const result = await runGrove([
    'feature',
    '--from',
    'main',
    '--keep',
    '--',
    'fix the login redirect',
  ])

  expect(result.exitCode).toBe(0)

  const calls = await readCalls()
  expect(calls).toEqual([
    { bin: 'codex', args: ['--help'], cwd: root },
    { bin: 'wkb', args: ['--help'], cwd: root },
    {
      bin: 'wkb',
      args: ['new', 'feature', '--from', 'main'],
      cwd: root,
    },
    {
      bin: 'wkb',
      args: ['status', 'feature', '--json'],
      cwd: root,
    },
    {
      bin: 'codex',
      args: ['fix the login redirect'],
      cwd: worktreePath,
    },
  ])
})

test('resumes a session with codex resume arguments after an optional separator', async () => {
  const result = await runGrove(['resume', 'feature', '--', '--last'])

  expect(result.exitCode).toBe(0)

  const codexCall = (await readCalls())
    .filter((call) => call.bin === 'codex')
    .at(-1)
  expect(codexCall).toEqual({
    bin: 'codex',
    args: ['resume', '--last'],
    cwd: worktreePath,
  })
})

test('removes sessions with branch deletion by default', async () => {
  const result = await runGrove(['rm', 'feature'])

  expect(result.exitCode).toBe(0)

  const removeCall = (await readCalls()).find(
    (call) => call.bin === 'wkb' && call.args[0] === 'rm',
  )
  expect(removeCall?.args).toEqual(['rm', 'feature', '--delete-branch'])
})

test('keeps the branch when requested during removal', async () => {
  const result = await runGrove(['rm', 'feature', '--keep-branch'])

  expect(result.exitCode).toBe(0)

  const removeCall = (await readCalls()).find(
    (call) => call.bin === 'wkb' && call.args[0] === 'rm',
  )
  expect(removeCall?.args).toEqual(['rm', 'feature'])
})

async function runGrove(
  args: string[],
  env: Record<string, string | undefined> = {},
) {
  const proc = Bun.spawn({
    cmd: [process.execPath, entrypoint, ...args],
    cwd: root,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      GROVE_WKB_COMMAND: wkbPath,
      GROVE_LOG: logPath,
      WORKTREE_PATH: worktreePath,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout, stderr, exitCode }
}

async function readCalls() {
  try {
    const text = await readFile(logPath, 'utf8')
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CallLog)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function writeExecutable(path: string, content: string) {
  await writeFile(path, content)
  await chmod(path, 0o755)
}

function fakeWorkboxScript() {
  return `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'

const args = Bun.argv.slice(2)
appendFileSync(process.env.GROVE_LOG!, JSON.stringify({ bin: 'wkb', args, cwd: process.cwd() }) + '\\n')

if (args[0] === '--help') process.exit(0)

if (args[0] === 'status' && args.includes('--json')) {
  const name = args[1]
  console.log(JSON.stringify({
    ok: true,
    data: [{
      name,
      path: process.env.WORKTREE_PATH,
      managed: true,
      managedBranch: 'grove/' + name
    }]
  }))
}

process.exit(0)
`
}

function fakeCodexScript() {
  return `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'

appendFileSync(
  process.env.GROVE_LOG!,
  JSON.stringify({ bin: 'codex', args: Bun.argv.slice(2), cwd: process.cwd() }) + '\\n',
)

process.exit(Number(process.env.CODEX_EXIT ?? '0'))
`
}
