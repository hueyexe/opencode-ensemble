import type { ToolDeps, PermissionRule } from "../types"
import { validateMemberName } from "../util"
import { requireLead } from "./shared"
import { sendMessage } from "../messaging"
import { log } from "../log"

/** Timeout for worktree.create and session.create to prevent hanging on git lock contention. */
function getSpawnTimeout(): number {
  return Number(process.env.SPAWN_TIMEOUT_MS) || 120_000
}

/** Returns true if the directory is already inside an OpenCode worktree. */
function isWorktreeDirectory(dir: string): boolean {
  return dir.includes("/opencode/worktree/")
}

/** Race a promise against a timeout. Throws if the timeout fires first. Cleans up timer on resolution. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

/**
 * Execute the team_spawn tool. Creates a child session and starts a teammate.
 * By default, each teammate gets their own git worktree for file isolation.
 * Pass worktree: false for read-only agents that don't need isolation.
 * Pass plan_approval: true to require the teammate to send a plan before writing.
 */
export async function executeTeamSpawn(
  deps: ToolDeps,
  args: { name: string; agent: string; prompt: string; model?: string; claim_task?: string; worktree?: boolean; plan_approval?: boolean },
  sessionId: string,
): Promise<string> {
  const nameError = validateMemberName(args.name)
  if (nameError) throw new Error(nameError)

  const teamInfo = requireLead(deps, sessionId)

  // Check duplicate name
  const existing = deps.db.query("SELECT name FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.name)
  if (existing) throw new Error(`Teammate "${args.name}" already exists in team "${teamInfo.teamName}"`)

  const useWorktree = args.worktree !== false && !isWorktreeDirectory(deps.directory)
  const usePlanApproval = args.plan_approval === true

  log(`spawn:start name=${args.name} agent=${args.agent} worktree=${useWorktree}`)

  // Create worktree if enabled
  let worktreeDir: string | null = null
  let worktreeBranch: string | null = null

  if (useWorktree) {
    const worktreeName = `ensemble-${teamInfo.teamName}-${args.name}`
    try {
      log(`spawn:worktree:start name=${args.name}`)
      const result = await withTimeout(
        deps.client.worktree.create({ worktreeCreateInput: { name: worktreeName } }),
        getSpawnTimeout(), `worktree.create for "${args.name}"`
      )
      if (result.data) {
        worktreeDir = result.data.directory
        worktreeBranch = result.data.branch
      }
      log(`spawn:worktree:done name=${args.name} dir=${worktreeDir}`)
    } catch (err) {
      log(`spawn:worktree:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`)
      try {
        await deps.client.tui.showToast({
          title: "Team",
          message: `Worktree creation failed for ${args.name}, using shared directory`,
          variant: "warning",
          duration: 4000,
        })
      } catch { /* TUI may not be available */ }
    }
  }

  // Create workspace from worktree branch — links session to worktree directory.
  // OQ-workspace: assumes workspace.create({ branch }) auto-links to the worktree at that branch.
  let workspaceId: string | null = null
  if (worktreeDir && worktreeBranch) {
    try {
      log(`spawn:workspace:start name=${args.name}`)
      const wsResult = await withTimeout(
        deps.client.workspace.create({ branch: worktreeBranch }),
        getSpawnTimeout(), `workspace.create for "${args.name}"`
      )
      if (wsResult.data) {
        workspaceId = wsResult.data.id
      }
      log(`spawn:workspace:done name=${args.name} id=${workspaceId}`)
    } catch (err) {
      log(`spawn:workspace:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`)
      // Non-fatal — prompt-based CWD instruction is the fallback
    }
  }

  // Permission rules on session.create are the hard gate (server-enforced).
  // For read-only agents, deny write tools and explicitly allow team tools.
  // For all agents with worktrees, allowlist the worktree path for edit/bash.
  const isReadOnly = args.agent === "plan" || args.agent === "explore"
  const TEAM_TOOLS = ["team_message", "team_broadcast", "team_tasks_list", "team_tasks_add", "team_tasks_complete", "team_claim"] as const
  const permission: PermissionRule[] = []

  if (worktreeDir) {
    permission.push(
      { permission: "edit", pattern: `${worktreeDir}/**`, action: "allow" },
    )
    if (!isReadOnly) {
      permission.push({ permission: "bash", pattern: "*", action: "allow" })
    }
  }

  if (isReadOnly) {
    permission.push(
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
    )
  }

  permission.push(
    ...TEAM_TOOLS.map(t => ({ permission: t, pattern: "*", action: "allow" as const })),
  )

  // Create child session — bind to workspace if available (server-enforced CWD isolation).
  // Falls back to no workspace binding if workspace.create failed.
  let childSessionId: string | undefined
  try {
    log(`spawn:session:start name=${args.name}`)
    const createResult = await withTimeout(
      deps.client.session.create({
        parentID: sessionId,
        title: `${args.name} (@${args.agent} teammate)`,
        permission,
        ...(workspaceId ? { workspaceID: workspaceId } : {}),
      }),
      getSpawnTimeout(), `session.create for "${args.name}"`
    )
    childSessionId = createResult.data?.id
    log(`spawn:session:done name=${args.name} sessionId=${childSessionId}`)
  } catch (err) {
    log(`spawn:session:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`)
    // Rollback workspace and worktree if session creation failed
    if (workspaceId) {
      try { await deps.client.workspace.remove({ id: workspaceId }) } catch { /* best effort */ }
    }
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    throw new Error(`Failed to create session for teammate "${args.name}": ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!childSessionId) {
    if (workspaceId) {
      try { await deps.client.workspace.remove({ id: workspaceId }) } catch { /* best effort */ }
    }
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    throw new Error("Failed to create teammate session")
  }

  // Register in DB
  const planApproval = usePlanApproval ? "pending" : "none"
  const now = Date.now()
  deps.db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, worktree_dir, worktree_branch, workspace_id, plan_approval, time_created, time_updated)
     VALUES (?, ?, ?, ?, 'busy', 'starting', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamInfo.teamId, args.name, childSessionId, args.agent, args.model ?? null, args.prompt, worktreeDir, worktreeBranch, workspaceId, planApproval, now, now]
  )

  // Register in memory
  deps.registry.register(teamInfo.teamId, args.name, childSessionId)

  // Build teammate context message
  const context = [
    `You are "${args.name}", a teammate in team "${teamInfo.teamName}".`,
    `Your agent type is "${args.agent}".`,
  ]

  if (worktreeBranch && worktreeDir && !workspaceId) {
    // Workspace binding failed — fallback to prompt-based CWD instruction
    context.push(
      `You are working on branch "${worktreeBranch}" in your own worktree at: ${worktreeDir}`,
      `Your changes are isolated from other teammates.`,
      `IMPORTANT: All file operations and shell commands MUST target your worktree directory.`,
      `Before running shell commands, cd to: ${worktreeDir}`,
    )
  } else if (worktreeBranch && worktreeDir) {
    // Workspace binding active — server handles CWD
    context.push(
      `You are working on branch "${worktreeBranch}" in your own isolated worktree.`,
      `Your changes are isolated from other teammates.`,
    )
  } else if (worktreeBranch) {
    context.push(`You are working on branch "${worktreeBranch}". Your changes are isolated from other teammates.`)
  }

  // Plan approval mode — teammate must send plan before writing
  if (usePlanApproval) {
    context.push(
      "",
      "IMPORTANT: You are in PLAN MODE.",
      "Read and explore the codebase, then send your implementation plan to the lead via team_message.",
      "Do NOT write or modify any files until the lead approves your plan.",
      "Wait for the lead's approval message before proceeding with implementation.",
    )
  }

  if (isReadOnly) {
    context.push(
      "", "Tools available to you:",
      "- team_message: send a message to the lead or another teammate",
      "- team_broadcast: send a message to all team members",
      "- team_tasks_list: view the shared team task board",
    )
  } else {
    context.push(
      "", "Tools available to you:",
      "- team_message: send a message to the lead or another teammate",
      "- team_broadcast: send a message to all team members",
      "- team_tasks_list: view the shared team task board",
      "- team_tasks_add: add tasks to the shared board",
      "- team_tasks_complete: mark a task complete on the shared board",
      "- team_claim: claim a pending task from the shared board",
    )
  }

  context.push("", "When you finish your task:")
  if (!isReadOnly && worktreeBranch) {
    context.push(`1. Commit your changes: git add -A && git commit -m "your summary"`)
    context.push("2. If you claimed a task, mark it complete using team_tasks_complete.")
    context.push(
      "3. Send ONE message to the lead using team_message with this format:",
    )
  } else if (!isReadOnly) {
    context.push("1. If you claimed a task, mark it complete using team_tasks_complete.")
    context.push(
      "2. Send ONE message to the lead using team_message with this format:",
    )
  } else {
    context.push(
      "1. Send ONE message to the lead using team_message with this format:",
    )
  }
  context.push(
    "<task-result>",
    "<status>completed or failed</status>",
    "<summary>One-line summary of what you did</summary>",
    "<details>Full findings or changes made</details>",
  )
  if (worktreeBranch) {
    context.push(`<branch>${worktreeBranch}</branch>`)
  }
  context.push("</task-result>")
  const lastStep = !isReadOnly && worktreeBranch ? "4" : !isReadOnly ? "3" : "2"
  context.push(
    `${lastStep}. STOP. Do not send follow-up confirmations, status updates, or 'standing by' messages.`,
    "",
    "If you are blocked, send ONE message to the lead describing the specific blocker.",
    "",
    "Your plain text output is NOT visible to the team. You MUST use team_message to communicate.",
  )

  context.push(
    "",
    "Your task:",
    args.prompt,
  )

  if (args.claim_task) {
    context.push("", `You have been assigned task ${args.claim_task}. Mark it complete when done.`)
  }

  const contextStr = context.join("\n")

  // Fire-and-forget: send prompt to teammate session.
  log(`spawn:promptAsync:fire name=${args.name} sessionId=${childSessionId}`)
  deps.client.session.promptAsync({
    sessionID: childSessionId,
    parts: [{ type: "text", text: contextStr }],
    agent: args.agent,
  }).catch(() => {
    log(`spawn:promptAsync:failed name=${args.name} — rolling back`)
    try {
      // Async rollback: clean up DB (by session_id to avoid deleting a re-spawned member with the same name), registry, session, and worktree
      deps.db.run("DELETE FROM team_member WHERE team_id = ? AND session_id = ?", [teamInfo.teamId, childSessionId])
      deps.registry.unregister(childSessionId)
      deps.client.session.abort({ sessionID: childSessionId }).catch(() => { /* best effort */ })
      if (workspaceId) {
        deps.client.workspace.remove({ id: workspaceId }).catch(() => { /* best effort */ })
      }
      if (worktreeDir) {
        deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }).catch(() => { /* best effort */ })
      }
      // Notify user that spawn failed so the lead doesn't think the teammate is active
      deps.client.tui.showToast({
        title: "Team",
        message: `Teammate "${args.name}" failed to start and was removed`,
        variant: "error",
        duration: 5000,
      }).catch(() => { /* TUI may not be available */ })
      // Notify the lead model so it can react (retry, adjust plan, etc.)
      // Message delivered via system prompt transform on the lead's next turn.
      sendMessage(deps.db, {
        teamId: teamInfo.teamId,
        from: "system",
        to: "lead",
        content: `Teammate "${args.name}" failed to start and was removed. You may retry the spawn.`,
      })
    } catch { /* rollback failed — watchdog will clean up stale member */ }
  })

  const branchInfo = worktreeBranch ? ` (branch: ${worktreeBranch})` : ""
  const planInfo = usePlanApproval ? " [plan mode — will send plan for approval]" : ""
  log(`spawn:done name=${args.name} sessionId=${childSessionId}`)
  return `Teammate "${args.name}" spawned (agent: ${args.agent})${branchInfo}${planInfo}. They are working on: ${args.prompt.slice(0, 120)}${args.prompt.length > 120 ? "..." : ""}`
}
