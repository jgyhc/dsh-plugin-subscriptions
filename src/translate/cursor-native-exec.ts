/**
 * Native execution of Cursor AgentService exec messages.
 *
 * The Cursor cloud agent asks the client (this plugin) to run its tools
 * locally via `execServerMessage`. Each executor below runs the requested
 * operation against the local filesystem / shell and shapes the outcome into
 * the matching Cursor `*Result` / `ShellStream` client message.
 *
 * MCP tool calls (`mcpArgs`) cannot be executed generically: the tool may be a
 * harness-registered tool (`bash`, `x_search`, `image_generate`, ...), so they
 * are delegated through an optional `executeMcpTool` hook wired to the harness
 * tool registry when the `tools` service is mounted. Without the hook the
 * plugin answers `toolNotFound` so the cloud agent can recover.
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  DeleteErrorSchema,
  DeleteFileNotFoundSchema,
  DeleteNotFileSchema,
  DeleteResultSchema,
  DeleteSuccessSchema,
  GrepContentMatchSchema,
  GrepContentResultSchema,
  GrepCountResultSchema,
  GrepErrorSchema,
  GrepFileCountSchema,
  GrepFileMatchSchema,
  GrepFilesResultSchema,
  GrepResultSchema,
  GrepSuccessSchema,
  GrepUnionResultSchema,
  LsDirectoryTreeNodeSchema,
  LsDirectoryTreeNode_FileSchema,
  LsErrorSchema,
  LsResultSchema,
  LsSuccessSchema,
  McpErrorSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolNotFoundSchema,
  McpToolResultContentItemSchema,
  ReadErrorSchema,
  ReadFileNotFoundSchema,
  ReadResultSchema,
  ReadSuccessSchema,
  ShellFailureSchema,
  ShellResultSchema,
  ShellSpawnErrorSchema,
  ShellStreamExitSchema,
  ShellStreamSchema,
  ShellStreamStartSchema,
  ShellStreamStderrSchema,
  ShellStreamStdoutSchema,
  ShellSuccessSchema,
  ShellTimeoutSchema,
  WriteErrorSchema,
  WriteResultSchema,
  WriteSuccessSchema,
  type DeleteArgs,
  type DeleteResult,
  type GrepArgs,
  type GrepResult,
  type GrepUnionResult,
  type LsArgs,
  type LsDirectoryTreeNode,
  type LsDirectoryTreeNode_File,
  type LsResult,
  type McpArgs,
  type McpResult,
  type ReadArgs,
  type ReadResult,
  type ShellArgs,
  type ShellResult,
  type ShellStream,
  type WriteArgs,
  type WriteResult,
} from '../providers/cursor-proto/cursor-proto.js'
import { create, decodeJsonValue } from '../providers/cursor-proto/protobuf.js'

/** One exec request the plugin executed, shaped into a Cursor client message. */
export type ExecResultMessage =
  | { case: 'shellResult'; value: ShellResult }
  | { case: 'writeResult'; value: WriteResult }
  | { case: 'deleteResult'; value: DeleteResult }
  | { case: 'grepResult'; value: GrepResult }
  | { case: 'readResult'; value: ReadResult }
  | { case: 'lsResult'; value: LsResult }
  | { case: 'mcpResult'; value: McpResult }

/** Uniform executor outcome: the client message plus optional local timing. */
export interface NativeExecResult {
  message: ExecResultMessage
  /** Local wall-clock execution time, surfaced to the Cursor agent for telemetry. */
  localExecutionTimeMs?: number
}

/** One harness-registered MCP tool invocation (the `tools` service hook). */
export interface NativeToolInput {
  callId: string
  name: string
  arguments: Record<string, unknown>
  signal: AbortSignal
}

/** The flattened harness tool outcome the plugin can render into an MCP result. */
export interface NativeToolOutcome {
  isError: boolean
  /** Model-facing text (text content blocks flattened). */
  content: string
}

/** Harness-registry-backed executor for MCP tool calls. */
export type ExecuteMcpTool = (input: NativeToolInput) => Promise<NativeToolOutcome>

/** Display-only reporter for one native exec (harness tool cards). */
export interface NativeExecProgress {
  start(presentation: {
    callId: string
    name: string
    arguments: Record<string, unknown>
  }): Promise<number | undefined>
  finish(
    callId: string,
    started: Promise<number | undefined>,
    text: string,
    isError: boolean,
  ): void
}

/** Per-exec context: cancellation plus the optional harness MCP executor. */
export interface NativeExecContext {
  signal: AbortSignal
  /**
   * Default working directory for execs whose args omit one (the session's
   * validated cwd). Falls back to the plugin process cwd when unset.
   */
  cwd?: string
  executeMcpTool?: ExecuteMcpTool
  /** Optional harness session reporter so the GUI can show live tool cards. */
  progress?: NativeExecProgress
  /**
   * Turn-local log of successful write/delete paths, used to append a
   * "Modified files" list at the end of the Cursor stream.
   */
  fileChanges?: {
    record(change: { path: string; kind: 'write' | 'delete' }): void
  }
}

/** Decode `google.protobuf.Value`-encoded MCP args into plain JSON. */
export function decodeMcpArgs(args: McpArgs): Record<string, unknown> {
  const decoded: Record<string, unknown> = {}
  if (args.args === undefined) return decoded
  for (const [key, bytes] of Object.entries(args.args)) {
    try {
      decoded[key] = decodeJsonValue(bytes)
    } catch {
      decoded[key] = null
    }
  }
  return decoded
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errnoCode(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

interface CommandOutcome {
  stdout: string
  stderr: string
  exitCode: number
  signal: string
  timedOut: boolean
}

function runBashCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<CommandOutcome> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', ['-c', command], {
      ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams
    let stdout = ''
    let stderr = ''
    let settled = false
    let killedByTimeout = false
    const timer = timeoutMs !== undefined && timeoutMs > 0
      ? setTimeout(() => {
        killedByTimeout = true
        child.kill('SIGKILL')
      }, timeoutMs)
      : undefined
    const onAbort = (): void => { child.kill('SIGKILL') }
    signal.addEventListener('abort', onAbort, { once: true })
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', error => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    child.on('close', (code, signalName) => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise({
        stdout,
        stderr,
        exitCode: code ?? 1,
        signal: signalName ?? '',
        timedOut: killedByTimeout,
      })
    })
  })
}

/** Run one Cursor shell exec; nonzero exits become a `failure`, timeouts a `timeout`. */
export async function execShell(args: ShellArgs, signal: AbortSignal): Promise<NativeExecResult> {
  const startedAt = Date.now()
  const command = args.command
  const workingDirectory = args.workingDirectory
  const timeoutMs = args.timeout > 0 ? args.timeout : undefined
  try {
    const outcome = await runBashCommand(command, workingDirectory, timeoutMs, signal)
    const localExecutionTimeMs = Date.now() - startedAt
    const common = {
      command,
      workingDirectory,
      executionTime: localExecutionTimeMs,
      localExecutionTimeMs,
    }
    if (outcome.timedOut) {
      return {
        message: {
          case: 'shellResult',
          value: create(ShellResultSchema, {
            result: {
              case: 'timeout',
              value: create(ShellTimeoutSchema, {
                command,
                workingDirectory,
                timeoutMs: timeoutMs ?? 0,
              }),
            },
          }),
        },
        localExecutionTimeMs,
      }
    }
    if (outcome.exitCode === 0) {
      return {
        message: {
          case: 'shellResult',
          value: create(ShellResultSchema, {
            result: {
              case: 'success',
              value: create(ShellSuccessSchema, {
                ...common,
                exitCode: 0,
                signal: outcome.signal,
                stdout: outcome.stdout,
                stderr: outcome.stderr,
              }),
            },
          }),
        },
        localExecutionTimeMs,
      }
    }
    return {
      message: {
        case: 'shellResult',
        value: create(ShellResultSchema, {
          result: {
            case: 'failure',
            value: create(ShellFailureSchema, {
              ...common,
              exitCode: outcome.exitCode,
              signal: outcome.signal,
              stdout: outcome.stdout,
              stderr: outcome.stderr,
              aborted: signal.aborted,
            }),
          },
        }),
      },
      localExecutionTimeMs,
    }
  } catch (error) {
    return {
      message: {
        case: 'shellResult',
        value: create(ShellResultSchema, {
          result: {
            case: 'spawnError',
            value: create(ShellSpawnErrorSchema, {
              command,
              workingDirectory,
              error: errorMessage(error),
            }),
          },
        }),
      },
      localExecutionTimeMs: Date.now() - startedAt,
    }
  }
}

/**
 * Run one Cursor shell-stream exec, pushing `start`/`stdout`/`stderr`/`exit`
 * events, then completing with the structured `ShellResult` via `onResult`.
 * The final result is the protocol's completion acknowledgement: the server
 * keeps the turn pending when it only ever sees stream deltas.
 */
export function execShellStream(
  args: ShellArgs,
  signal: AbortSignal,
  send: (stream: ShellStream) => void,
  onResult: (result: ShellResult, localExecutionTimeMs: number) => void,
): Promise<void> {
  return new Promise(resolve => {
    const command = args.command
    const workingDirectory = args.workingDirectory
    const timeoutMs = args.timeout > 0 ? args.timeout : undefined
    const startedAt = Date.now()
    const cwd = workingDirectory !== undefined && workingDirectory.length > 0 ? workingDirectory : undefined
    let stdout = ''
    let stderr = ''
    let killedByTimeout = false
    send(create(ShellStreamSchema, {
      event: { case: 'start', value: create(ShellStreamStartSchema, {}) },
    }))
    const child = spawn('bash', ['-c', command], {
      ...(cwd !== undefined ? { cwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams
    let settled = false
    const timer = timeoutMs !== undefined
      ? setTimeout(() => {
        killedByTimeout = true
        child.kill('SIGKILL')
      }, timeoutMs)
      : undefined
    const onAbort = (): void => { child.kill('SIGKILL') }
    signal.addEventListener('abort', onAbort, { once: true })
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const complete = (exitCode: number, signalName: string): void => {
      const localExecutionTimeMs = Date.now() - startedAt
      send(create(ShellStreamSchema, {
        event: {
          case: 'exit',
          value: create(ShellStreamExitSchema, {
            code: exitCode,
            cwd: cwd ?? '',
            aborted: signal.aborted,
            localExecutionTimeMs,
          }),
        },
      }))
      const common = { command, workingDirectory, executionTime: localExecutionTimeMs, localExecutionTimeMs }
      let result: ShellResult
      if (killedByTimeout) {
        result = create(ShellResultSchema, {
          result: {
            case: 'timeout',
            value: create(ShellTimeoutSchema, {
              command,
              workingDirectory,
              timeoutMs: timeoutMs ?? 0,
            }),
          },
        })
      } else if (exitCode === 0) {
        result = create(ShellResultSchema, {
          result: {
            case: 'success',
            value: create(ShellSuccessSchema, {
              ...common,
              exitCode: 0,
              signal: signalName,
              stdout,
              stderr,
            }),
          },
        })
      } else {
        result = create(ShellResultSchema, {
          result: {
            case: 'failure',
            value: create(ShellFailureSchema, {
              ...common,
              exitCode,
              signal: signalName,
              stdout,
              stderr,
              aborted: signal.aborted,
            }),
          },
        })
      }
      onResult(result, localExecutionTimeMs)
      resolve()
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      send(create(ShellStreamSchema, {
        event: { case: 'stdout', value: create(ShellStreamStdoutSchema, { data: chunk }) },
      }))
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      send(create(ShellStreamSchema, {
        event: { case: 'stderr', value: create(ShellStreamStderrSchema, { data: chunk }) },
      }))
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      cleanup()
      const localExecutionTimeMs = Date.now() - startedAt
      send(create(ShellStreamSchema, {
        event: {
          case: 'exit',
          value: create(ShellStreamExitSchema, {
            code: 1,
            cwd: cwd ?? '',
            aborted: signal.aborted,
            localExecutionTimeMs,
          }),
        },
      }))
      onResult(create(ShellResultSchema, {
        result: {
          case: 'spawnError',
          value: create(ShellSpawnErrorSchema, {
            command,
            workingDirectory,
            error: errorMessage(error),
          }),
        },
      }), localExecutionTimeMs)
      resolve()
    })
    child.on('close', (code, signalName) => {
      if (settled) return
      settled = true
      cleanup()
      complete(code ?? 1, signalName ?? '')
    })
  })
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

/** Read a text file with Cursor-style line numbers and optional offset/limit. */
export async function execRead(args: ReadArgs, signal: AbortSignal): Promise<NativeExecResult> {
  const startedAt = Date.now()
  const path = args.path
  try {
    const stat = await fs.stat(path)
    if (stat.isDirectory()) {
      return {
        message: {
          case: 'readResult',
          value: create(ReadResultSchema, {
            result: { case: 'error', value: create(ReadErrorSchema, { path, error: 'cannot read a directory' }) },
          }),
        },
        localExecutionTimeMs: Date.now() - startedAt,
      }
    }
    const text = await fs.readFile(path, { encoding: 'utf8', signal })
    const lines = text.split('\n')
    const totalLines = lines.length
    const offset = args.offset !== undefined && args.offset > 0 ? args.offset : 1
    const limit = args.limit !== undefined && args.limit > 0 ? args.limit : undefined
    const startIndex = offset - 1
    const endIndex = limit !== undefined ? Math.min(lines.length, startIndex + limit) : lines.length
    const windowLines = lines.slice(startIndex, endIndex)
    const content = windowLines.map((line, i) => `${startIndex + i + 1} | ${line}`).join('\n')
    return {
      message: {
        case: 'readResult',
        value: create(ReadResultSchema, {
          result: {
            case: 'success',
            value: create(ReadSuccessSchema, {
              path,
              totalLines,
              fileSize: BigInt(stat.size),
              truncated: endIndex < lines.length,
              output: { case: 'content', value: content },
              rangeApplied: args.offset !== undefined || args.limit !== undefined,
            }),
          },
        }),
      },
      localExecutionTimeMs: Date.now() - startedAt,
    }
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return {
        message: {
          case: 'readResult',
          value: create(ReadResultSchema, {
            result: { case: 'fileNotFound', value: create(ReadFileNotFoundSchema, { path }) },
          }),
        },
        localExecutionTimeMs: Date.now() - startedAt,
      }
    }
    return {
      message: {
        case: 'readResult',
        value: create(ReadResultSchema, {
          result: { case: 'error', value: create(ReadErrorSchema, { path, error: errorMessage(error) }) },
        }),
      },
      localExecutionTimeMs: Date.now() - startedAt,
    }
  }
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

/** Write a file (creating parent directories), reporting lines/size. */
export async function execWrite(args: WriteArgs, signal: AbortSignal): Promise<NativeExecResult> {
  const startedAt = Date.now()
  const path = args.path
  const content = args.fileBytes !== undefined && args.fileBytes.length > 0
    ? Buffer.from(args.fileBytes).toString('utf8')
    : args.fileText
  try {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, content, { encoding: 'utf8', signal })
    return {
      message: {
        case: 'writeResult',
        value: create(WriteResultSchema, {
          result: {
            case: 'success',
            value: create(WriteSuccessSchema, {
              path,
              linesCreated: content.split('\n').length,
              fileSize: Buffer.byteLength(content),
              ...(args.returnFileContentAfterWrite === true ? { fileContentAfterWrite: content } : {}),
            }),
          },
        }),
      },
      localExecutionTimeMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      message: {
        case: 'writeResult',
        value: create(WriteResultSchema, {
          result: { case: 'error', value: create(WriteErrorSchema, { path, error: errorMessage(error) }) },
        }),
      },
      localExecutionTimeMs: Date.now() - startedAt,
    }
  }
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const GREP_SKIP_DIRS = new Set(['.git', 'node_modules'])

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`)
}

function matchesGlob(glob: string | undefined, filePath: string): boolean {
  if (glob === undefined || glob.length === 0) return true
  const regex = globToRegExp(glob)
  return regex.test(basename(filePath)) || regex.test(filePath)
}

/** Simple recursive grep over the target path, honoring the Cursor output modes. */
export async function execGrep(args: GrepArgs, signal: AbortSignal): Promise<NativeExecResult> {
  const startedAt = Date.now()
  const pattern = args.pattern
  const outputMode = args.outputMode !== undefined && args.outputMode.length > 0 ? args.outputMode : 'content'
  const rootPath = args.path !== undefined && args.path.length > 0 ? args.path : process.cwd()
  const headLimit = args.headLimit !== undefined && args.headLimit > 0 ? args.headLimit : 200
  const fail = (error: string): NativeExecResult => ({
    message: {
      case: 'grepResult',
      value: create(GrepResultSchema, { result: { case: 'error', value: create(GrepErrorSchema, { error }) } }),
    },
    localExecutionTimeMs: Date.now() - startedAt,
  })
  let regex: RegExp
  try {
    regex = new RegExp(pattern, args.caseInsensitive === true ? 'i' : '')
  } catch (error) {
    return fail(`invalid grep pattern: ${errorMessage(error)}`)
  }
  try {
    const stat = await fs.stat(rootPath)
    const matchesByFile = new Map<string, Array<{ lineNumber: number; content: string }>>()
    const fileOrder: string[] = []
    const counts = new Map<string, number>()
    let totalMatchedLines = 0
    let linesScanned = 0
    let clientTruncated = false

    const recordFileMatch = (file: string, lineNumber: number, content: string): void => {
      if (clientTruncated) return
      if (!matchesByFile.has(file)) {
        matchesByFile.set(file, [])
        fileOrder.push(file)
      }
      matchesByFile.get(file)!.push({ lineNumber, content })
      totalMatchedLines++
      counts.set(file, (counts.get(file) ?? 0) + 1)
      if (totalMatchedLines >= headLimit) clientTruncated = true
    }

    const scanFile = async (filePath: string): Promise<void> => {
      if (!matchesGlob(args.glob, filePath)) return
      if (clientTruncated && outputMode !== 'files') return
      if (outputMode === 'files' && fileOrder.length >= headLimit) {
        clientTruncated = true
        return
      }
      let content: string
      try {
        content = await fs.readFile(filePath, { encoding: 'utf8', signal })
      } catch {
        return // binary or unreadable files are skipped like ripgrep
      }
      if (outputMode === 'count') {
        let count = 0
        for (const line of content.split('\n')) {
          linesScanned++
          if (regex.test(line)) count++
        }
        if (count > 0) {
          counts.set(filePath, count)
          fileOrder.push(filePath)
        }
        return
      }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        linesScanned++
        const line = lines[i] ?? ''
        if (regex.test(line)) {
          if (outputMode === 'files') {
            if (!fileOrder.includes(filePath)) fileOrder.push(filePath)
            if (fileOrder.length >= headLimit) {
              clientTruncated = true
              return
            }
          } else {
            recordFileMatch(filePath, i + 1, line)
          }
        }
      }
    }

    const walk = async (dirPath: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dirPath, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (GREP_SKIP_DIRS.has(entry.name)) continue
        const full = join(dirPath, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          await scanFile(full)
          if (clientTruncated && outputMode !== 'files') return
        }
      }
    }

    if (stat.isDirectory()) {
      await walk(rootPath)
    } else {
      await scanFile(rootPath)
    }

    const success = (union: GrepUnionResult): NativeExecResult => ({
      message: {
        case: 'grepResult',
        value: create(GrepResultSchema, {
          result: {
            case: 'success',
            value: create(GrepSuccessSchema, {
              pattern,
              path: rootPath,
              outputMode,
              workspaceResults: { [rootPath]: union },
            }),
          },
        }),
      },
      localExecutionTimeMs: Date.now() - startedAt,
    })

    if (outputMode === 'files') {
      return success(create(GrepUnionResultSchema, {
        result: {
          case: 'files',
          value: create(GrepFilesResultSchema, {
            files: fileOrder,
            totalFiles: fileOrder.length,
            clientTruncated,
            ripgrepTruncated: false,
          }),
        },
      }))
    }
    if (outputMode === 'count') {
      const countsArray = fileOrder.map(file => create(GrepFileCountSchema, { file, count: counts.get(file) ?? 0 }))
      const totalMatches = countsArray.reduce((sum, entry) => sum + entry.count, 0)
      return success(create(GrepUnionResultSchema, {
        result: {
          case: 'count',
          value: create(GrepCountResultSchema, {
            counts: countsArray,
            totalFiles: countsArray.length,
            totalMatches,
            clientTruncated,
            ripgrepTruncated: false,
          }),
        },
      }))
    }
    const matches = fileOrder.map(file => create(GrepFileMatchSchema, {
      file,
      matches: (matchesByFile.get(file) ?? []).map(match => create(GrepContentMatchSchema, {
        lineNumber: match.lineNumber,
        content: match.content,
        contentTruncated: false,
        isContextLine: false,
      })),
    }))
    return success(create(GrepUnionResultSchema, {
      result: {
        case: 'content',
        value: create(GrepContentResultSchema, {
          matches,
          totalLines: linesScanned,
          totalMatchedLines,
          clientTruncated,
          ripgrepTruncated: false,
          ...(args.headLimit !== undefined ? { headLimitApplied: headLimit } : {}),
        }),
      },
    }))
  } catch (error) {
    return fail(errorMessage(error))
  }
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

function extensionOf(name: string): string | undefined {
  const index = name.lastIndexOf('.')
  return index > 0 && index < name.length - 1 ? name.slice(index + 1) : undefined
}

async function buildLsNode(
  absPath: string,
  ignore: readonly string[],
  signal: AbortSignal,
): Promise<LsDirectoryTreeNode> {
  const entries = await fs.readdir(absPath, { withFileTypes: true })
  const ignored = new Set(ignore)
  const childrenDirs: LsDirectoryTreeNode[] = []
  const childrenFiles: LsDirectoryTreeNode_File[] = []
  const extensionCounts = new Map<string, number>()
  let numFiles = 0
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue
    const full = join(absPath, entry.name)
    if (entry.isDirectory()) {
      const child = await buildLsNode(full, ignore, signal)
      childrenDirs.push(child)
      numFiles += child.numFiles
      for (const [ext, count] of Object.entries(child.fullSubtreeExtensionCounts)) {
        extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + count)
      }
    } else if (entry.isFile()) {
      childrenFiles.push(create(LsDirectoryTreeNode_FileSchema, { name: entry.name }))
      numFiles++
      const ext = extensionOf(entry.name)
      if (ext !== undefined) extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1)
    }
  }
  const fullSubtreeExtensionCounts: Record<string, number> = {}
  for (const [ext, count] of extensionCounts) fullSubtreeExtensionCounts[ext] = count
  return create(LsDirectoryTreeNodeSchema, {
    absPath,
    childrenDirs,
    childrenFiles,
    childrenWereProcessed: true,
    fullSubtreeExtensionCounts,
    numFiles,
  })
}

/** List a directory as a recursive tree with per-extension counts. */
export async function execLs(args: LsArgs, signal: AbortSignal): Promise<NativeExecResult> {
  const startedAt = Date.now()
  const path = args.path
  try {
    const root = await buildLsNode(path, args.ignore, signal)
    return {
      message: {
        case: 'lsResult',
        value: create(LsResultSchema, {
          result: { case: 'success', value: create(LsSuccessSchema, { directoryTreeRoot: root }) },
        }),
      },
      localExecutionTimeMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      message: {
        case: 'lsResult',
        value: create(LsResultSchema, {
          result: { case: 'error', value: create(LsErrorSchema, { path, error: errorMessage(error) }) },
        }),
      },
      localExecutionTimeMs: Date.now() - startedAt,
    }
  }
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

/** Delete one file, reporting the previous content like the Cursor client. */
export async function execDelete(args: DeleteArgs, signal: AbortSignal): Promise<NativeExecResult> {
  const startedAt = Date.now()
  const path = args.path
  try {
    const stat = await fs.stat(path)
    if (stat.isDirectory()) {
      return {
        message: {
          case: 'deleteResult',
          value: create(DeleteResultSchema, {
            result: { case: 'notFile', value: create(DeleteNotFileSchema, { path, actualType: 'directory' }) },
          }),
        },
        localExecutionTimeMs: Date.now() - startedAt,
      }
    }
    let prevContent = ''
    try {
      prevContent = await fs.readFile(path, 'utf8')
    } catch {
      // best-effort: binary or unreadable files still delete
    }
    await fs.unlink(path)
    return {
      message: {
        case: 'deleteResult',
        value: create(DeleteResultSchema, {
          result: {
            case: 'success',
            value: create(DeleteSuccessSchema, {
              path,
              deletedFile: basename(path),
              fileSize: BigInt(stat.size),
              prevContent,
            }),
          },
        }),
      },
      localExecutionTimeMs: Date.now() - startedAt,
    }
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return {
        message: {
          case: 'deleteResult',
          value: create(DeleteResultSchema, {
            result: { case: 'fileNotFound', value: create(DeleteFileNotFoundSchema, { path }) },
          }),
        },
        localExecutionTimeMs: Date.now() - startedAt,
      }
    }
    return {
      message: {
        case: 'deleteResult',
        value: create(DeleteResultSchema, {
          result: { case: 'error', value: create(DeleteErrorSchema, { path, error: errorMessage(error) }) },
        }),
      },
      localExecutionTimeMs: Date.now() - startedAt,
    }
  }
}

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

/** Execute an MCP tool call through the harness hook, or answer `toolNotFound`. */
export async function execMcp(args: McpArgs, ctx: NativeExecContext): Promise<NativeExecResult> {
  const startedAt = Date.now()
  const toolName = args.toolName.length > 0 ? args.toolName : args.name
  const toolCallId = args.toolCallId.length > 0 ? args.toolCallId : randomUUID()
  if (ctx.executeMcpTool === undefined) {
    return {
      message: {
        case: 'mcpResult',
        value: create(McpResultSchema, {
          result: {
            case: 'toolNotFound',
            value: create(McpToolNotFoundSchema, { name: toolName, availableTools: [] }),
          },
        }),
      },
      localExecutionTimeMs: Date.now() - startedAt,
    }
  }
  try {
    const outcome = await ctx.executeMcpTool({
      callId: toolCallId,
      name: toolName,
      arguments: decodeMcpArgs(args),
      signal: ctx.signal,
    })
    return {
      message: {
        case: 'mcpResult',
        value: create(McpResultSchema, {
          result: {
            case: 'success',
            value: create(McpSuccessSchema, {
              content: [
                create(McpToolResultContentItemSchema, {
                  content: { case: 'text', value: create(McpTextContentSchema, { text: outcome.content }) },
                }),
              ],
              isError: outcome.isError,
            }),
          },
        }),
      },
      localExecutionTimeMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      message: {
        case: 'mcpResult',
        value: create(McpResultSchema, {
          result: { case: 'error', value: create(McpErrorSchema, { error: errorMessage(error) }) },
        }),
      },
      localExecutionTimeMs: Date.now() - startedAt,
    }
  }
}


