import { Rpc } from "@opencode/plugin/rpc"

/**
 * RPC contract between the server plugin and terminal companions.
 * Published as `./rpc` so companions import the shape without the
 * implementation. Companion behavior (toasts, navigation) is enhancement
 * only — every client works fully without it.
 */
export const EnsembleRpc = Rpc.define({
  id: "ensemble",
  methods: {
    summary: {
      input: {
        type: "object",
        properties: { team: { type: "string" } },
        required: ["team"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    teamContext: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          team: { type: ["string", "null"] },
          members: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, status: { type: "string" } },
              required: ["name", "status"],
              additionalProperties: false,
            },
          },
          tasks: {
            type: "object",
            properties: {
              pending: { type: "number" },
              done: { type: "number" },
            },
            required: ["pending", "done"],
            additionalProperties: false,
          },
          openTasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "blocked"] },
                assignee: { type: ["string", "null"] },
              },
              required: ["id", "content", "status", "assignee"],
              additionalProperties: false,
            },
          },
        },
        required: ["team", "members", "tasks"],
        additionalProperties: false,
      },
    },
  },
  events: {
    member: {
      schema: {
        type: "object",
        properties: {
          memberName: { type: "string" },
          teamId: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["memberName", "teamId", "from", "to"],
        additionalProperties: false,
      },
    },
    notice: {
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          message: { type: "string" },
          variant: { type: "string" },
        },
        required: ["message"],
        additionalProperties: false,
      },
    },
    view: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          memberName: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
})
