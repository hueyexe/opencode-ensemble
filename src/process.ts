import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface CommandOptions {
  cwd?: string
}

function collect(stream: Readable | null, chunks: Buffer[]): void {
  stream?.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })
}

/** Run a subprocess with Node-compatible APIs and capture stdout/stderr. */
export function runCommand(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const [command, ...commandArgs] = args
  if (!command) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "No command provided" })

  return new Promise((resolve) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const finish = (result: CommandResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })

    collect(child.stdout, stdout)
    collect(child.stderr, stderr)

    child.on("error", (error) => {
      finish({ exitCode: 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: error.message })
    })
    child.on("close", (code) => {
      finish({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    })
  })
}
