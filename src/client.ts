import type { PluginClient } from "./types"

/** Extract error message from a HeyAPI error response. */
function extractError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: string }).message)
  return String(err)
}

/** Generic async SDK method type. Actual type safety enforced by PluginClient interface. */
type SdkMethod = (...args: unknown[]) => Promise<unknown>

/** Wrap a single async SDK method to throw on { error } responses. */
function throwing(fn: SdkMethod): SdkMethod {
  return async (...args: unknown[]) => {
    const result = await fn(...args)
    if (result && typeof result === "object" && "error" in result && result.error !== undefined) {
      throw new Error(extractError(result.error))
    }
    return result
  }
}

/** Shape of the raw v2 SDK client — just the methods we wrap. */
interface RawClient {
  session: { create: SdkMethod; promptAsync: SdkMethod; abort: SdkMethod; status: SdkMethod }
  tui: { showToast: SdkMethod; selectSession: SdkMethod }
  worktree: { create: SdkMethod; remove: SdkMethod; list: SdkMethod; reset: SdkMethod }
  experimental: { workspace: { create: SdkMethod; remove: SdkMethod; list: SdkMethod } }
}

/**
 * Wraps a raw v2 SDK client so that methods throw on error responses
 * instead of returning { error }. This makes existing try/catch blocks work.
 */
export function wrapThrowingClient(raw: unknown): PluginClient {
  const r = raw as RawClient
  return {
    session: {
      create: throwing(r.session.create.bind(r.session)),
      promptAsync: throwing(r.session.promptAsync.bind(r.session)),
      abort: throwing(r.session.abort.bind(r.session)),
      status: throwing(r.session.status.bind(r.session)),
    },
    tui: {
      showToast: throwing(r.tui.showToast.bind(r.tui)),
      selectSession: throwing(r.tui.selectSession.bind(r.tui)),
    },
    worktree: {
      create: throwing(r.worktree.create.bind(r.worktree)),
      remove: throwing(r.worktree.remove.bind(r.worktree)),
      list: throwing(r.worktree.list.bind(r.worktree)),
      reset: throwing(r.worktree.reset.bind(r.worktree)),
    },
    workspace: {
      create: throwing(r.experimental.workspace.create.bind(r.experimental.workspace)),
      remove: throwing(r.experimental.workspace.remove.bind(r.experimental.workspace)),
      list: throwing(r.experimental.workspace.list.bind(r.experimental.workspace)),
    },
  } as PluginClient
}
