/**
 * Token bucket rate limiter for controlling concurrent LLM inference.
 * Capacity 0 disables the limiter (all calls pass immediately).
 */
export class TokenBucket {
  private tokens: number
  private readonly capacity: number
  private readonly refillRate: number
  private readonly refillIntervalMs: number
  private lastRefill: number
  private readonly disabled: boolean

  constructor(opts: { capacity: number; refillRate: number; refillIntervalMs: number }) {
    this.disabled = opts.capacity === 0
    this.capacity = opts.capacity
    this.tokens = opts.capacity
    this.refillRate = opts.refillRate
    this.refillIntervalMs = opts.refillIntervalMs
    this.lastRefill = Date.now()
  }

  /** Refill tokens based on elapsed time. */
  private refill(): void {
    if (this.disabled) return
    const now = Date.now()
    const elapsed = now - this.lastRefill
    if (elapsed < this.refillIntervalMs) return
    const intervals = Math.floor(elapsed / this.refillIntervalMs)
    this.tokens = Math.min(this.capacity, this.tokens + intervals * this.refillRate)
    this.lastRefill += intervals * this.refillIntervalMs
  }

  /**
   * Try to consume one token. Returns true if a token was available,
   * false if the bucket is empty. Disabled buckets always return true.
   */
  tryConsume(): boolean {
    if (this.disabled) return true
    this.refill()
    if (this.tokens > 0) {
      this.tokens--
      return true
    }
    return false
  }

  /**
   * Wait until a token is available, then consume it.
   * Respects an optional AbortSignal.
   */
  async waitForToken(signal?: AbortSignal): Promise<void> {
    if (this.disabled) return
    if (this.tryConsume()) return

    return new Promise((resolve, reject) => {
      const checkInterval = Math.max(10, Math.floor(this.refillIntervalMs / 2))

      const timer = setInterval(() => {
        if (signal?.aborted) {
          clearInterval(timer)
          reject(new Error("Rate limit wait aborted"))
          return
        }
        if (this.tryConsume()) {
          clearInterval(timer)
          resolve()
        }
      }, checkInterval)

      signal?.addEventListener("abort", () => {
        clearInterval(timer)
        reject(new Error("Rate limit wait aborted"))
      }, { once: true })
    })
  }
}
