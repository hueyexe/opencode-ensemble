import { describe, test, expect, beforeEach } from "bun:test"
import { setupDb, insertTeam, insertMember } from "./helpers"
import type { Database } from "../src/db"
import { parseModelId, getMemberModel } from "../src/member-model"

describe("parseModelId", () => {
  test("parses a valid provider/model string", () => {
    expect(parseModelId("anthropic/claude-3-5-sonnet")).toEqual({
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet",
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
