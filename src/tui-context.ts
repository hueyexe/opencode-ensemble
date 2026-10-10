import type { Plugin } from "@opencode/plugin/tui"
import type { RpcClient } from "@opencode/client"
import type { EnsembleRpc } from "./rpc"

/** Team state returned by the server's location-scoped RPC. */
export interface TeamContextData {
  team: string | null
  members: Array<{ name: string; status: string }>
  tasks: { pending: number; done: number }
}

type Context = Plugin.Context
type ContextSource = Pick<Context, "location"> & {
  data: {
    session: Pick<Context["data"]["session"], "get">
    location: Pick<Context["data"]["location"], "default">
  }
}

/** Read the displayed session's team from its own location, not the server default. */
export async function fetchTeamContext(
  context: ContextSource,
  rpc: Pick<RpcClient<typeof EnsembleRpc>, "teamContext">,
  sessionID?: string,
): Promise<TeamContextData | null> {
  if (!sessionID) return null
  const location = context.data.session.get(sessionID)?.location
    ?? context.location
    ?? context.data.location.default()
  // The JSON Schema RPC contract validates the response on the server;
  // this SDK version infers unknown for its output type.
  return await rpc.teamContext({ sessionID }, { location }) as TeamContextData
}
