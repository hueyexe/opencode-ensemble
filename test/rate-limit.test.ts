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
})
