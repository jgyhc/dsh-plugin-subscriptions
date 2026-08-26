/**
 * Native exec: Cursor AgentService exec messages run against the local
 * filesystem/shell and answer with the matching client result messages.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type http2 from 'node:http2'

import {
  AgentClientMessageSchema,
  DeleteArgsSchema,
  ExecServerMessageSchema,
  GrepArgsSchema,
  LsArgsSchema,
  McpArgsSchema,
  ReadArgsSchema,
  ShellArgsSchema,
  WriteArgsSchema,
  type AgentClientMessage,
  type ExecServerMessage,
} from '../src/providers/cursor-proto/cursor-proto.js'
import { create, encodeJsonValue, fromBinary } from '../src/providers/cursor-proto/protobuf.js'
import {
  execDelete,
  execGrep,
  execLs,
  execMcp,
  execRead,
  execShell,
  execShellStream,
  execWrite,
  type ExecuteMcpTool,
  type NativeExecContext,
} from '../src/translate/cursor-native-exec.js'
import { handleExecServerMessage } from '../src/translate/cursor-stream.js'

const signal = (): AbortSignal => new AbortController().signal

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cursor-native-exec-'))
}

/** Fake HTTP/2 stream that records framed Connect messages. */
class FakeH2Request {
  writes: Buffer[] = []
  closed = false
  destroyed = false
  write(frame: Buffer): boolean {
    this.writes.push(Buffer.from(frame))
    return true
  }
}

function decodeClientMessage(frame: Buffer): AgentClientMessage {
  const len = frame.readUInt32BE(1)
  return fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + len))
}

/** The `message` case of the exec client message inside one client frame. */
function execMessageCase(frame: Buffer): string | undefined {
  const exec = decodeClientMessage(frame).message.value as { message?: { case?: string } } | undefined
  return exec?.message?.case
}

/** The exec client message payload of one client frame. */
function execMessageValue(frame: Buffer): unknown {
  const exec = decodeClientMessage(frame).message.value as { message?: { value?: unknown } } | undefined
  return exec?.message?.value
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for exec result')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function shellArgs(partial: Partial<{ command: string; workingDirectory: string; timeout: number; toolCallId: string }> = {}) {
  return create(ShellArgsSchema, {
    command: partial.command ?? 'true',
    workingDirectory: partial.workingDirectory ?? '',
    timeout: partial.timeout ?? 10_000,
    toolCallId: partial.toolCallId ?? 'tc-shell',
  })
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

test('execShell returns a success with stdout and exit code 0', async () => {
  const result = await execShell(shellArgs({ command: 'printf hello' }), signal())
  assert.equal(result.message.case, 'shellResult')
  if (result.message.case !== 'shellResult') return
  assert.equal(result.message.value.result.case, 'success')
  if (result.message.value.result.case !== 'success') return
  assert.equal(result.message.value.result.value.exitCode, 0)
  assert.equal(result.message.value.result.value.stdout, 'hello')
  assert.ok((result.localExecutionTimeMs ?? 0) >= 0)
})

test('execShell returns a failure with a nonzero exit code', async () => {
  const result = await execShell(shellArgs({ command: 'echo oops >&2; exit 3' }), signal())
  assert.equal(result.message.case, 'shellResult')
  if (result.message.case !== 'shellResult') return
  assert.equal(result.message.value.result.case, 'failure')
  if (result.message.value.result.case !== 'failure') return
  assert.equal(result.message.value.result.value.exitCode, 3)
  assert.match(result.message.value.result.value.stderr, /oops/)
})

test('execShell honors the working directory', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'marker.txt'), 'found')
  const result = await execShell(shellArgs({ command: 'cat marker.txt', workingDirectory: dir }), signal())
  assert.equal(result.message.case, 'shellResult')
  if (result.message.case !== 'shellResult') return
  assert.equal(result.message.value.result.case, 'success')
  if (result.message.value.result.case !== 'success') return
  assert.equal(result.message.value.result.value.stdout, 'found')
})

test('execShell reports a timeout as the timeout variant', async () => {
  const result = await execShell(shellArgs({ command: 'sleep 5', timeout: 150 }), signal())
  assert.equal(result.message.case, 'shellResult')
  if (result.message.case !== 'shellResult') return
  assert.equal(result.message.value.result.case, 'timeout')
})

test('execShellStream emits start, stdout, exit, then a structured success result', async () => {
  const events: string[] = []
  const stdout: string[] = []
  let result: { result: { case: string; value: { stdout: string } } } | undefined
  const args = shellArgs({ command: 'printf streamed' })
  await execShellStream(args, signal(), stream => {
    events.push(stream.event.case ?? '')
    if (stream.event.case === 'stdout') stdout.push(stream.event.value.data)
  }, (shellResult, _ms) => {
    result = shellResult as never
  })
  assert.deepEqual(events, ['start', 'stdout', 'exit'])
  assert.equal(stdout.join(''), 'streamed')
  assert.ok(result !== undefined, 'completion result is delivered')
  assert.equal(result.result.case, 'success')
  assert.equal(result.result.value.stdout, 'streamed')
})

// ---------------------------------------------------------------------------
// read / write / delete / ls
// ---------------------------------------------------------------------------

test('execRead returns line-numbered content and total lines', async () => {
  const dir = await tempDir()
  const file = join(dir, 'a.txt')
  await writeFile(file, 'one\ntwo\nthree\n')
  const result = await execRead(create(ReadArgsSchema, { path: file, toolCallId: 'tc-read' }), signal())
  assert.equal(result.message.case, 'readResult')
  if (result.message.case !== 'readResult') return
  assert.equal(result.message.value.result.case, 'success')
  if (result.message.value.result.case !== 'success') return
  const success = result.message.value.result.value
  assert.equal(success.totalLines, 4) // trailing newline produces a final empty line
  assert.equal(success.fileSize, BigInt(14))
  assert.match(success.output.case === 'content' ? success.output.value : '', /^1 \| one\n2 \| two\n3 \| three/)
})

test('execRead applies offset and limit and reports truncation', async () => {
  const dir = await tempDir()
  const file = join(dir, 'a.txt')
  await writeFile(file, 'l1\nl2\nl3\nl4\nl5\n')
  const result = await execRead(create(ReadArgsSchema, {
    path: file,
    toolCallId: 'tc-read',
    offset: 2,
    limit: 2,
  }), signal())
  assert.equal(result.message.case, 'readResult')
  if (result.message.case !== 'readResult') return
  assert.equal(result.message.value.result.case, 'success')
  if (result.message.value.result.case !== 'success') return
  const success = result.message.value.result.value
  assert.match(success.output.case === 'content' ? success.output.value : '', /^2 \| l2\n3 \| l3/)
  assert.equal(success.truncated, true)
  assert.equal(success.rangeApplied, true)
})

test('execRead reports fileNotFound for a missing path', async () => {
  const result = await execRead(create(ReadArgsSchema, { path: '/no/such/file.txt', toolCallId: 'tc-read' }), signal())
  assert.equal(result.message.case, 'readResult')
  if (result.message.case !== 'readResult') return
  assert.equal(result.message.value.result.case, 'fileNotFound')
})

test('execWrite creates the file and reports size', async () => {
  const dir = await tempDir()
  const file = join(dir, 'sub', 'out.txt')
  const result = await execWrite(create(WriteArgsSchema, {
    path: file,
    fileText: 'alpha\nbeta\n',
    toolCallId: 'tc-write',
    returnFileContentAfterWrite: true,
  }), signal())
  assert.equal(result.message.case, 'writeResult')
  if (result.message.case !== 'writeResult') return
  assert.equal(result.message.value.result.case, 'success')
  if (result.message.value.result.case !== 'success') return
  const success = result.message.value.result.value
  assert.equal(success.path, file)
  assert.equal(success.fileSize, 11)
  assert.equal(success.linesCreated, 3)
  assert.equal(success.fileContentAfterWrite, 'alpha\nbeta\n')
  assert.equal(await readFile(file, 'utf8'), 'alpha\nbeta\n')
})

test('execWrite writes fileBytes when provided', async () => {
  const dir = await tempDir()
  const file = join(dir, 'bin.txt')
  const result = await execWrite(create(WriteArgsSchema, {
    path: file,
    fileText: '',
    fileBytes: new Uint8Array(Buffer.from('binary-ish')),
    toolCallId: 'tc-write',
  }), signal())
  assert.equal(result.message.case, 'writeResult')
  if (result.message.case !== 'writeResult') return
  assert.equal(result.message.value.result.case, 'success')
  assert.equal(await readFile(file, 'utf8'), 'binary-ish')
})

test('execDelete removes a file and returns its previous content', async () => {
  const dir = await tempDir()
  const file = join(dir, 'gone.txt')
  await writeFile(file, 'bye')
  const result = await execDelete(create(DeleteArgsSchema, { path: file, toolCallId: 'tc-del' }), signal())
  assert.equal(result.message.case, 'deleteResult')
  if (result.message.case !== 'deleteResult') return
  assert.equal(result.message.value.result.case, 'success')
  if (result.message.value.result.case !== 'success') return
  assert.equal(result.message.value.result.value.deletedFile, 'gone.txt')
  assert.equal(result.message.value.result.value.prevContent, 'bye')
  await assert.rejects(stat(file))
})

test('execDelete reports fileNotFound and notFile variants', async () => {
  const missing = await execDelete(create(DeleteArgsSchema, { path: '/no/such/file', toolCallId: 'tc-del' }), signal())
  assert.equal(missing.message.case, 'deleteResult')
  if (missing.message.case !== 'deleteResult') return
  assert.equal(missing.message.value.result.case, 'fileNotFound')

  const dir = await tempDir()
  const asDir = await execDelete(create(DeleteArgsSchema, { path: dir, toolCallId: 'tc-del' }), signal())
  assert.equal(asDir.message.case, 'deleteResult')
  if (asDir.message.case !== 'deleteResult') return
  assert.equal(asDir.message.value.result.case, 'notFile')
})

test('execLs builds a recursive tree with file counts and extensions', async () => {
  const dir = await tempDir()
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src', 'a.ts'), '')
  await writeFile(join(dir, 'src', 'b.ts'), '')
  await writeFile(join(dir, 'README.md'), '')
  const result = await execLs(create(LsArgsSchema, { path: dir, toolCallId: 'tc-ls' }), signal())
  assert.equal(result.message.case, 'lsResult')
  if (result.message.case !== 'lsResult') return
  assert.equal(result.message.value.result.case, 'success')
  if (result.message.value.result.case !== 'success') return
  const root = result.message.value.result.value.directoryTreeRoot
  assert.ok(root !== undefined)
  assert.equal(root.absPath, dir)
  assert.equal(root.numFiles, 3)
  assert.equal(root.childrenFiles.length, 1)
  assert.equal(root.childrenDirs.length, 1)
  assert.equal(root.childrenDirs[0]?.childrenFiles.length, 2)
  assert.equal(root.fullSubtreeExtensionCounts['ts'], 2)
  assert.equal(root.fullSubtreeExtensionCounts['md'], 1)
})

test('execLs honors the ignore list', async () => {
  const dir = await tempDir()
  await mkdir(join(dir, 'node_modules'))
  await writeFile(join(dir, 'node_modules', 'pkg.js'), '')
  await writeFile(join(dir, 'index.js'), '')
  const result = await execLs(create(LsArgsSchema, { path: dir, ignore: ['node_modules'], toolCallId: 'tc-ls' }), signal())
  assert.equal(result.message.case, 'lsResult')
  if (result.message.case !== 'lsResult') return
  assert.equal(result.message.value.result.case, 'success')
  if (result.message.value.result.case !== 'success') return
  const root = result.message.value.result.value.directoryTreeRoot
  assert.equal(root?.numFiles, 1)
})

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

test('execGrep returns content matches with line numbers', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'one.txt'), 'alpha\ngamma\nalpha two\n')
  await writeFile(join(dir, 'two.txt'), 'nothing here\n')
  const result = await execGrep(create(GrepArgsSchema, {
    pattern: 'alpha',
    path: dir,
    toolCallId: 'tc-grep',
  }), signal())
  assert.equal(result.message.case, 'grepResult')
  if (result.message.case !== 'grepResult') return
  assert.equal(result.message.value.result.case, 'success')
  if (result.message.value.result.case !== 'success') return
  const success = result.message.value.result.value
  const union = success.workspaceResults[dir]
  assert.ok(union !== undefined)
  assert.equal(union.result.case, 'content')
  if (union.result.case !== 'content') return
  assert.equal(union.result.value.totalMatchedLines, 2)
  const first = union.result.value.matches[0]
  assert.equal(first?.matches[0]?.lineNumber, 1)
  assert.equal(first?.matches[1]?.content, 'alpha two')
})

test('execGrep files and count modes shape their own results', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'a.txt'), 'needle\n')
  await writeFile(join(dir, 'b.txt'), 'needle needle\n')
  await writeFile(join(dir, 'c.txt'), 'nothing\n')
  const files = await execGrep(create(GrepArgsSchema, { pattern: 'needle', path: dir, outputMode: 'files', toolCallId: 'tc' }), signal())
  assert.equal(files.message.case, 'grepResult')
  if (files.message.case !== 'grepResult') return
  assert.equal(files.message.value.result.case, 'success')
  if (files.message.value.result.case !== 'success') return
  const filesUnion = files.message.value.result.value.workspaceResults[dir]
  assert.equal(filesUnion?.result.case, 'files')
  if (filesUnion?.result.case !== 'files') return
  assert.equal(filesUnion.result.value.totalFiles, 2)

  const counts = await execGrep(create(GrepArgsSchema, { pattern: 'needle', path: dir, outputMode: 'count', toolCallId: 'tc' }), signal())
  assert.equal(counts.message.case, 'grepResult')
  if (counts.message.case !== 'grepResult') return
  assert.equal(counts.message.value.result.case, 'success')
  if (counts.message.value.result.case !== 'success') return
  const countsUnion = counts.message.value.result.value.workspaceResults[dir]
  assert.equal(countsUnion?.result.case, 'count')
  if (countsUnion?.result.case !== 'count') return
  // Ripgrep-style line counting: one matching line in a.txt, one in b.txt.
  assert.equal(countsUnion.result.value.totalMatches, 2)
})

test('execGrep reports invalid patterns as an error', async () => {
  const result = await execGrep(create(GrepArgsSchema, { pattern: '(', path: process.cwd(), toolCallId: 'tc' }), signal())
  assert.equal(result.message.case, 'grepResult')
  if (result.message.case !== 'grepResult') return
  assert.equal(result.message.value.result.case, 'error')
})

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

function mcpArgs(partial: Partial<{ name: string; toolName: string; toolCallId: string }> = {}) {
  return create(McpArgsSchema, {
    name: partial.name ?? 'x_search',
    toolName: partial.toolName ?? partial.name ?? 'x_search',
    toolCallId: partial.toolCallId ?? 'tc-mcp',
    args: { query: encodeJsonValue('harness') },
    providerIdentifier: 'dsh-plugin-subscriptions',
    smartModeApprovalOnly: false,
    skipApproval: false,
    serverIdentifier: 'dsh',
  })
}

test('execMcp answers toolNotFound without a harness executor', async () => {
  const result = await execMcp(mcpArgs(), { signal: signal() })
  assert.equal(result.message.case, 'mcpResult')
  if (result.message.case !== 'mcpResult') return
  assert.equal(result.message.value.result.case, 'toolNotFound')
  if (result.message.value.result.case !== 'toolNotFound') return
  assert.equal(result.message.value.result.value.name, 'x_search')
})

test('execMcp runs the harness executor and renders its content', async () => {
  const calls: string[] = []
  const executeMcpTool: ExecuteMcpTool = async exec => {
    calls.push(exec.name)
    assert.deepEqual(exec.arguments, { query: 'harness' })
    return { isError: false, content: 'x results' }
  }
  const result = await execMcp(mcpArgs(), { signal: signal(), executeMcpTool })
  assert.equal(result.message.case, 'mcpResult')
  if (result.message.case !== 'mcpResult') return
  assert.equal(result.message.value.result.case, 'success')
  if (result.message.value.result.case !== 'success') return
  assert.equal(result.message.value.result.value.isError, false)
  assert.equal(result.message.value.result.value.content[0]?.content.case, 'text')
  assert.deepEqual(calls, ['x_search'])
})

test('execMcp surfaces tool failures as an isError success', async () => {
  const executeMcpTool: ExecuteMcpTool = async () => ({ isError: true, content: 'boom' })
  const result = await execMcp(mcpArgs(), { signal: signal(), executeMcpTool })
  assert.equal(result.message.case, 'mcpResult')
  if (result.message.case !== 'mcpResult') return
  assert.equal(result.message.value.result.case, 'success')
  if (result.message.value.result.case !== 'success') return
  assert.equal(result.message.value.result.value.isError, true)
})

// ---------------------------------------------------------------------------
// handleExecServerMessage wiring
// ---------------------------------------------------------------------------

async function runExec(execMsg: ExecServerMessage, executeMcpTool?: ExecuteMcpTool, cwd?: string): Promise<{
  fake: FakeH2Request
}> {
  const fake = new FakeH2Request()
  const nativeExec: NativeExecContext = {
    signal: signal(),
    ...(cwd === undefined ? {} : { cwd }),
  }
  await handleExecServerMessage(
    execMsg,
    fake as unknown as http2.ClientHttp2Stream,
    [],
    [],
    executeMcpTool === undefined ? nativeExec : { ...nativeExec, executeMcpTool },
  )
  await waitFor(() => fake.writes.length > 0)
  return { fake }
}

test('handleExecServerMessage answers shellArgs with a real shellResult', async () => {
  const execMsg = create(ExecServerMessageSchema, {
    id: 7,
    execId: 'exec-1',
    message: { case: 'shellArgs', value: shellArgs({ command: 'printf wired' }) },
  })
  const { fake } = await runExec(execMsg)
  assert.equal(execMessageCase(fake.writes[0]!), 'shellResult')
  const shellResult = execMessageValue(fake.writes[0]!) as { result: { case: string; value: { stdout: string } } }
  assert.equal(shellResult.result.case, 'success')
  assert.equal(shellResult.result.value.stdout, 'wired')
})

test('handleExecServerMessage streams shellStreamArgs events and acknowledges completion', async () => {
  const execMsg = create(ExecServerMessageSchema, {
    id: 8,
    execId: 'exec-2',
    message: { case: 'shellStreamArgs', value: shellArgs({ command: 'printf stream-wired' }) },
  })
  const { fake } = await runExec(execMsg)
  await waitFor(() => fake.writes.length >= 5)
  const cases = fake.writes.map(frame => execMessageCase(frame))
  // start / stdout / exit stream deltas, then the completion ack pair
  assert.deepEqual(cases, ['shellStream', 'shellStream', 'shellStream', 'shellResult', 'streamClose'])
  const shellResult = execMessageValue(fake.writes[3]!) as { result: { case: string; value: { stdout: string } } }
  assert.equal(shellResult.result.case, 'success')
  assert.equal(shellResult.result.value.stdout, 'stream-wired')
})

test('handleExecServerMessage defaults empty shell workingDirectory to the session cwd', async () => {
  const dir = await tempDir()
  const execMsg = create(ExecServerMessageSchema, {
    id: 10,
    execId: 'exec-cwd-shell',
    message: { case: 'shellArgs', value: shellArgs({ command: 'pwd', workingDirectory: '' }) },
  })
  const { fake } = await runExec(execMsg, undefined, dir)
  assert.equal(execMessageCase(fake.writes[0]!), 'shellResult')
  const shellResult = execMessageValue(fake.writes[0]!) as {
    result: { case: string; value: { stdout: string; workingDirectory: string } }
  }
  assert.equal(shellResult.result.case, 'success')
  // `pwd` prints the symlink-resolved path on macOS (`/var` -> `/private/var`).
  assert.equal(shellResult.result.value.stdout.trim(), await realpath(dir))
  assert.equal(shellResult.result.value.workingDirectory, dir)
})

test('handleExecServerMessage keeps an explicit shell workingDirectory over the session cwd', async () => {
  const dir = await tempDir()
  const other = await tempDir()
  const execMsg = create(ExecServerMessageSchema, {
    id: 11,
    execId: 'exec-explicit-shell',
    message: { case: 'shellArgs', value: shellArgs({ command: 'pwd', workingDirectory: other }) },
  })
  const { fake } = await runExec(execMsg, undefined, dir)
  assert.equal(execMessageCase(fake.writes[0]!), 'shellResult')
  const shellResult = execMessageValue(fake.writes[0]!) as { result: { case: string; value: { stdout: string } } }
  assert.equal(shellResult.result.case, 'success')
  assert.equal(shellResult.result.value.stdout.trim(), await realpath(other))
})

test('handleExecServerMessage defaults empty ls path to the session cwd', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'cwd-ls.txt'), 'x\n')
  const execMsg = create(ExecServerMessageSchema, {
    id: 12,
    execId: 'exec-cwd-ls',
    message: { case: 'lsArgs', value: create(LsArgsSchema, { path: '', toolCallId: 'tc' }) },
  })
  const { fake } = await runExec(execMsg, undefined, dir)
  assert.equal(execMessageCase(fake.writes[0]!), 'lsResult')
  const lsResult = execMessageValue(fake.writes[0]!) as {
    result: { case: string; value: { directoryTreeRoot: { absPath: string; childrenFiles: Array<{ name: string }> } } }
  }
  assert.equal(lsResult.result.case, 'success')
  assert.equal(lsResult.result.value.directoryTreeRoot.absPath, dir)
  assert.equal(lsResult.result.value.directoryTreeRoot.childrenFiles[0]?.name, 'cwd-ls.txt')
})

test('handleExecServerMessage answers readArgs and writeArgs', async () => {
  const dir = await tempDir()
  const file = join(dir, 'r.txt')
  await writeFile(file, 'wire-read\n')
  const readMsg = create(ExecServerMessageSchema, {
    id: 1,
    execId: 'exec-read',
    message: { case: 'readArgs', value: create(ReadArgsSchema, { path: file, toolCallId: 'tc' }) },
  })
  const read = await runExec(readMsg)
  assert.equal(execMessageCase(read.fake.writes[0]!), 'readResult')

  const writeTarget = join(dir, 'w.txt')
  const writeMsg = create(ExecServerMessageSchema, {
    id: 2,
    execId: 'exec-write',
    message: {
      case: 'writeArgs',
      value: create(WriteArgsSchema, { path: writeTarget, fileText: 'wire-write\n', toolCallId: 'tc' }),
    },
  })
  const write = await runExec(writeMsg)
  assert.equal(execMessageCase(write.fake.writes[0]!), 'writeResult')
  assert.equal(await readFile(writeTarget, 'utf8'), 'wire-write\n')
})

test('handleExecServerMessage answers grepArgs, lsArgs, and deleteArgs', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'g.txt'), 'wire-grep\n')
  const grepMsg = create(ExecServerMessageSchema, {
    id: 3,
    execId: 'exec-grep',
    message: { case: 'grepArgs', value: create(GrepArgsSchema, { pattern: 'wire-grep', path: dir, toolCallId: 'tc' }) },
  })
  const grep = await runExec(grepMsg)
  assert.equal(execMessageCase(grep.fake.writes[0]!), 'grepResult')

  const lsMsg = create(ExecServerMessageSchema, {
    id: 4,
    execId: 'exec-ls',
    message: { case: 'lsArgs', value: create(LsArgsSchema, { path: dir, toolCallId: 'tc' }) },
  })
  const ls = await runExec(lsMsg)
  assert.equal(execMessageCase(ls.fake.writes[0]!), 'lsResult')

  const target = join(dir, 'd.txt')
  await writeFile(target, 'wire-del')
  const deleteMsg = create(ExecServerMessageSchema, {
    id: 5,
    execId: 'exec-del',
    message: { case: 'deleteArgs', value: create(DeleteArgsSchema, { path: target, toolCallId: 'tc' }) },
  })
  const del = await runExec(deleteMsg)
  assert.equal(execMessageCase(del.fake.writes[0]!), 'deleteResult')
  await assert.rejects(stat(target))
})

test('handleExecServerMessage runs mcpArgs through the harness executor', async () => {
  const execMsg = create(ExecServerMessageSchema, {
    id: 9,
    execId: 'exec-mcp',
    message: { case: 'mcpArgs', value: mcpArgs({ name: 'bash', toolName: 'bash' }) },
  })
  const executeMcpTool: ExecuteMcpTool = async () => ({ isError: false, content: 'mcp-wired' })
  const { fake } = await runExec(execMsg, executeMcpTool)
  assert.equal(execMessageCase(fake.writes[0]!), 'mcpResult')
  const mcpResult = execMessageValue(fake.writes[0]!) as {
    result: { case: string; value: { content: Array<{ content: { case: string; value: { text: string } } }> } }
  }
  assert.equal(mcpResult.result.case, 'success')
  assert.equal(mcpResult.result.value.content[0]?.content.value.text, 'mcp-wired')
})

test('handleExecServerMessage throws for unsupported exec cases', async () => {
  const execMsg = create(ExecServerMessageSchema, {
    id: 10,
    execId: 'exec-unknown',
    message: { case: 'fetchArgs', value: {} } as never,
  })
  const { fake } = await runExec(execMsg)
  const decoded = decodeClientMessage(fake.writes[0]!)
  assert.equal(decoded.message.case, 'execClientControlMessage')
  const control = decoded.message.value as { message?: { case?: string } }
  assert.equal(control.message?.case, 'throw')
})
