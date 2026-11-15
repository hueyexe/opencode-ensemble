import { describe, test, expect, beforeEach } from "bun:test"
import { setupDb, insertTeam, insertMember, mockClient } from "./helpers"
import type { Database } from "../src/db"
import { parseModelId, getMemberModel, formatModelId, getSessionSelection } from "../src/member-model"

describe("parseModelId", () => {
  test("parses a valid provider/model string", () => {
    expect(parseModelId("anthropic/claude-3-5-sonnet")).toEqual({
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet",
    })
  })

  test("parses a trailing variant", () => {
    expect(parseModelId("openai/gpt-6.1-terra#max")).toEqual({
      providerID: "openai",
      modelID: "gpt-6.1-terra",
      variant: "max",
    })
  })

  test("keeps additional slashes in the model portion", () => {
    expect(parseModelId("openrouter/anthropic/claude")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude",
    })
  })

  test("returns undefined for malformed input", () => {
    expect(parseModelId("")).toBeUndefined()
    expect(parseModelId("foo")).toBeUndefined()
    expect(parseModelId("/model")).toBeUndefined()
    expect(parseModelId("provider/")).toBeUndefined()
  })
})

describe("getMemberModel", () => {
  let db: Database

  beforeEach(() => {
    db = setupDb()
    insertTeam(db, "t1", "my-team", "lead-sess")
  })

  test("returns the parsed model when the member has one set", () => {
    insertMember(db, "t1", "alice", "sess-alice")
    db.run("UPDATE team_member SET model = 'anthropic/claude-sonnet' WHERE team_id = 't1' AND name = 'alice'")

    expect(getMemberModel(db, "t1", "alice")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet",
    })
  })

  test("returns the parsed variant when the member has one set", () => {
    insertMember(db, "t1", "alice", "sess-alice")
    db.run("UPDATE team_member SET model = 'openai/gpt-6.1-terra#max' WHERE team_id = 't1' AND name = 'alice'")

    expect(getMemberModel(db, "t1", "alice")).toEqual({
      providerID: "openai",
      modelID: "gpt-6.1-terra",
      variant: "max",
    })
  })

  test("returns undefined when the member has no model set", () => {
    insertMember(db, "t1", "alice", "sess-alice")
    expect(getMemberModel(db, "t1", "alice")).toBeUndefined()
  })

  test("returns undefined when the stored model is malformed", () => {
    insertMember(db, "t1", "alice", "sess-alice")
    db.run("UPDATE team_member SET model = 'garbage' WHERE team_id = 't1' AND name = 'alice'")
    expect(getMemberModel(db, "t1", "alice")).toBeUndefined()
  })

  test("returns undefined for an unknown member", () => {
    expect(getMemberModel(db, "t1", "nobody")).toBeUndefined()
  })
})

describe("formatModelId", () => {
  test("round-trips provider/model and variants", () => {
    expect(formatModelId({ providerID: "anthropic", modelID: "claude-sonnet" })).toBe("anthropic/claude-sonnet")
    expect(formatModelId({ providerID: "openai", modelID: "gpt-6.1-terra", variant: "max" })).toBe("openai/gpt-6.1-terra#max")
  })
})

describe("getSessionSelection", () => {
  test("reads agent and model from a V2 session", async () => {
    const client = mockClient()
    client.agent = { readOnly: async () => undefined }
    client.session.get = async () => ({
      data: { agent: "plan", model: { providerID: "anthropic", id: "claude-sonnet", variant: "max" } },
    })

    expect(await getSessionSelection(client, "ses-1")).toEqual({
      agent: "plan",
      model: { providerID: "anthropic", modelID: "claude-sonnet", variant: "max" },
    })
    expect(client.calls.filter(c => c.method === "session.messages")).toHaveLength(0)
  })

  test("falls back to the last real user message on V1", async () => {
    const client = mockClient()
    client.session.messages = async () => ({
      data: [
        { info: { role: "user", agent: "build", model: { providerID: "openai", modelID: "gpt-5" } }, parts: [] },
        { info: { role: "assistant", modelID: "gpt-5", providerID: "openai" }, parts: [] },
        { info: { role: "user", agent: "plan", model: { providerID: "anthropic", modelID: "claude-sonnet" } }, parts: [{ type: "text", text: "do the thing" }] },
        // Ensemble's own wake is a user turn on V1 — must not become the source.
        { info: { role: "user", agent: "build", model: { providerID: "openai", modelID: "gpt-5" } }, parts: [{ type: "text", text: "[System: 1 new team message(s) from alice] — use team_results to read them" }] },
      ],
    })

    expect(await getSessionSelection(client, "ses-1")).toEqual({
      agent: "plan",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
    })
  })

  test("returns an empty selection when the transport fails", async () => {
    const client = mockClient()
    client.session.messages = async () => { throw new Error("transport down") }
    expect(await getSessionSelection(client, "ses-1")).toEqual({})
  })

  test("returns an empty selection when no user message is available", async () => {
    const client = mockClient()
    expect(await getSessionSelection(client, "ses-1")).toEqual({})
  })
})
