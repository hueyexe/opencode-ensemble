import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-ensemble-desktop-"))
  tempDirs.push(dir)
  return dir
}

async function buildForNode(entrypoint: string, outdir: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "node",
  })

  if (!result.success) {
    const logs = result.logs.map((log) => log.message).join("\n")
    throw new Error(`Node build failed:\n${logs}`)
  }

  return path.join(outdir, `${path.basename(entrypoint, path.extname(entrypoint))}.js`)
}

async function runNode(modulePath: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["node", "--no-warnings", modulePath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { exitCode, stdout, stderr }
}

async function runBun(modulePath: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, modulePath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { exitCode, stdout, stderr }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("Desktop runtime compatibility", () => {
  test("package build targets the Node-compatible runtime", async () => {
    const pkg = await Bun.file("package.json").json() as { scripts?: Record<string, string> }

    expect(pkg.scripts?.build).toContain("--target node")
    expect(pkg.scripts?.build).not.toContain("--target bun")
  })

  test("full plugin bundle imports under Node's ESM loader", async () => {
    const outdir = await createTempDir()
    const bundlePath = await buildForNode(path.join(process.cwd(), "src/index.ts"), outdir)
    const importScript = path.join(outdir, "import-plugin.mjs")

    await Bun.write(
      importScript,
      `await import(${JSON.stringify(pathToFileURL(bundlePath).href)})\nconsole.log("plugin-loaded")\n`,
    )

    const result = await runNode(importScript)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("plugin-loaded")
  })

  test("Node-targeted plugin bundle has no Bun-only runtime references", async () => {
    const outdir = await createTempDir()
    const bundlePath = await buildForNode(path.join(process.cwd(), "src/index.ts"), outdir)
    const bundle = await Bun.file(bundlePath).text()

    expect(bundle).not.toContain("bun:sqlite")
    expect(bundle).not.toContain("Bun.")
  })

  test("Node-targeted plugin bundle still imports under Bun", async () => {
    const outdir = await createTempDir()
    const bundlePath = await buildForNode(path.join(process.cwd(), "src/index.ts"), outdir)
    const importScript = path.join(outdir, "import-plugin.mjs")

    await Bun.write(
      importScript,
      `await import(${JSON.stringify(pathToFileURL(bundlePath).href)})\nconsole.log("plugin-loaded")\n`,
    )

    const result = await runBun(importScript)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("plugin-loaded")
  })

  test("SQLite adapter opens and migrates a database under Node", async () => {
    const outdir = await createTempDir()
    const entrypoint = path.join(outdir, "sqlite-entry.ts")
    const dbPath = path.join(process.cwd(), "src/db.ts")
    const dbImport = path.relative(outdir, dbPath).replaceAll(path.sep, "/")

    await Bun.write(
      entrypoint,
      `import { createDb } from ${JSON.stringify(dbImport)}\nconst db = createDb(":memory:")\nconst version = db.query("PRAGMA user_version").get()\nif (!version || typeof version !== "object" || !("user_version" in version) || version.user_version < 1) {\n  throw new Error("migrations did not run")\n}\ndb.close()\nconsole.log("sqlite-ok")\n`,
    )

    const bundlePath = await buildForNode(entrypoint, outdir)
    const result = await runNode(bundlePath)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("sqlite-ok")
  })
})
