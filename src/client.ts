import type { PluginClient } from "./types"

/** Extract error message from a HeyAPI error response. */
function extractError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: string }).message)
  return String(err)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => Promise<any>

/** Wrap a single async SDK method to throw on { error } responses. */
function throwing(fn: AnyFn): AnyFn {
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
  session: { create: AnyFn; promptAsync: AnyFn; abort: AnyFn; status: AnyFn }
  tui: { showToast: AnyFn; selectSession: AnyFn }
  worktree: { create: AnyFn; remove: AnyFn; list: AnyFn; reset: AnyFn }
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
  } as PluginClient
}
