/** Plugin logger using the v2 SDK's structured logging API (flat params, no body wrapper). */
let _client: { app: { log: (params: { service: string; level: string; message: string }) => Promise<unknown> } } | null = null

/** Set the SDK client for logging. Called once during plugin init with the raw v2 client. */
export function initLog(client: unknown): void {
  _client = client as typeof _client
}

/** Log a message via the SDK's app.log API so it appears in OpenCode's structured logs. */
export function log(msg: string): void {
  if (!_client) return
  _client.app.log({ service: "ensemble", level: "info", message: msg }).catch(() => {})
}
