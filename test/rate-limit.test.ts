import { describe, test, expect, beforeEach } from "bun:test"
import { TokenBucket } from "../src/rate-limit"

describe("TokenBucket", () => {
  test("allows requests within capacity", () => {
    const bucket = new TokenBucket({ capacity: 5, refillRate: 1, refillIntervalMs: 1000 })
    for (let i = 0; i < 5; i++) {
      expect(bucket.tryConsume()).toBe(true)
    }
  })

  test("rejects when bucket is empty", () => {
    const bucket = new TokenBucket({ capacity: 2, refillRate: 1, refillIntervalMs: 1000 })
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false)
  })

  test("refills tokens over time", async () => {
    const bucket = new TokenBucket({ capacity: 2, refillRate: 2, refillIntervalMs: 100 })
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false)

    // Wait for refill
    await Bun.sleep(150)
    expect(bucket.tryConsume()).toBe(true)
  })

  test("does not exceed capacity on refill", async () => {
    const bucket = new TokenBucket({ capacity: 3, refillRate: 10, refillIntervalMs: 100 })
    // Wait long enough for many refills
    await Bun.sleep(200)
    // Should still only have capacity tokens
    let consumed = 0
    while (bucket.tryConsume()) consumed++
    expect(consumed).toBe(3)
  })

  test("waitForToken resolves when token becomes available", async () => {
    const bucket = new TokenBucket({ capacity: 1, refillRate: 1, refillIntervalMs: 50 })
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false)

    const start = Date.now()
    await bucket.waitForToken()
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(40) // ~50ms refill, allow some jitter
    expect(elapsed).toBeLessThan(200)
  })

  test("waitForToken respects abort signal", async () => {
    const bucket = new TokenBucket({ capacity: 1, refillRate: 1, refillIntervalMs: 5000 })
    expect(bucket.tryConsume()).toBe(true)

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)

    await expect(bucket.waitForToken(controller.signal))
      .rejects.toThrow("aborted")
  })

  test("disabled bucket always allows", () => {
    const bucket = new TokenBucket({ capacity: 0, refillRate: 0, refillIntervalMs: 0 })
    for (let i = 0; i < 100; i++) {
      expect(bucket.tryConsume()).toBe(true)
    }
  })

  test("concurrent consumers share the same bucket", async () => {
    const bucket = new TokenBucket({ capacity: 3, refillRate: 1, refillIntervalMs: 1000 })

    const results = await Promise.all(
      Array.from({ length: 5 }, () => Promise.resolve(bucket.tryConsume()))
    )
    const passed = results.filter(r => r === true).length
    const failed = results.filter(r => r === false).length
    expect(passed).toBe(3)
    expect(failed).toBe(2)
  })

  test("partial interval elapsed does not refill", async () => {
    const bucket = new TokenBucket({ capacity: 2, refillRate: 1, refillIntervalMs: 1000 })
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false)

    // Wait well under one full interval
    await Bun.sleep(50)
    expect(bucket.tryConsume()).toBe(false)
  })

  test("refill adds refillRate tokens per interval", async () => {
    const bucket = new TokenBucket({ capacity: 6, refillRate: 3, refillIntervalMs: 100 })
    // Drain all 6
    for (let i = 0; i < 6; i++) expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false)

    // Wait for one interval — should get 3 tokens back
    await Bun.sleep(120)
    for (let i = 0; i < 3; i++) expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false)
  })

  test("multiple intervals accumulate tokens up to capacity", async () => {
    const bucket = new TokenBucket({ capacity: 4, refillRate: 1, refillIntervalMs: 50 })
    // Drain all
    for (let i = 0; i < 4; i++) expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false)

    // Wait for ~3 intervals — should get 3 tokens (not 4, unless timing allows)
    await Bun.sleep(170)
    let consumed = 0
    while (bucket.tryConsume()) consumed++
    expect(consumed).toBeGreaterThanOrEqual(3)
    expect(consumed).toBeLessThanOrEqual(4)
  })

  test("capacity of 1 — single token boundary", () => {
    const bucket = new TokenBucket({ capacity: 1, refillRate: 1, refillIntervalMs: 1000 })
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false)
    expect(bucket.tryConsume()).toBe(false)
  })

  test("waitForToken resolves immediately when tokens available", async () => {
    const bucket = new TokenBucket({ capacity: 3, refillRate: 1, refillIntervalMs: 5000 })
    const start = Date.now()
    await bucket.waitForToken()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(50)
  })

  test("waitForToken on disabled bucket resolves immediately", async () => {
    const bucket = new TokenBucket({ capacity: 0, refillRate: 0, refillIntervalMs: 0 })
    const start = Date.now()
    await bucket.waitForToken()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(50)
  })

  test("waitForToken rejects with already-aborted signal", async () => {
    const bucket = new TokenBucket({ capacity: 1, refillRate: 1, refillIntervalMs: 5000 })
    expect(bucket.tryConsume()).toBe(true)

    const controller = new AbortController()
    controller.abort()

    await expect(bucket.waitForToken(controller.signal))
      .rejects.toThrow("aborted")
  })

  test("multiple waitForToken callers are each served", async () => {
    const bucket = new TokenBucket({ capacity: 1, refillRate: 1, refillIntervalMs: 50 })
    expect(bucket.tryConsume()).toBe(true)

    // Two callers waiting concurrently
    const p1 = bucket.waitForToken()
    const p2 = bucket.waitForToken()

    // Both should eventually resolve (each gets a refilled token)
    await Promise.all([p1, p2])
  })

  test("disabled bucket tryConsume never decrements", () => {
    const bucket = new TokenBucket({ capacity: 0, refillRate: 0, refillIntervalMs: 0 })
    // Even after many calls, it keeps returning true
    for (let i = 0; i < 1000; i++) {
      expect(bucket.tryConsume()).toBe(true)
    }
  })
})
