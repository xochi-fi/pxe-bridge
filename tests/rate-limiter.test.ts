import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { RateLimiter } from "../src/server.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RateLimiter", () => {
  it("allows requests within limit", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(true);
  });

  it("rejects requests exceeding limit", () => {
    const limiter = new RateLimiter(3, 60_000);
    limiter.allow("ip1");
    limiter.allow("ip1");
    limiter.allow("ip1");
    expect(limiter.allow("ip1")).toBe(false);
  });

  it("tracks limits per key independently", () => {
    const limiter = new RateLimiter(2, 60_000);
    limiter.allow("ip1");
    limiter.allow("ip1");
    expect(limiter.allow("ip1")).toBe(false);
    expect(limiter.allow("ip2")).toBe(true);
  });

  it("allows requests after window slides", () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2, 1000);

    limiter.allow("ip1");
    limiter.allow("ip1");
    expect(limiter.allow("ip1")).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(limiter.allow("ip1")).toBe(true);

    vi.useRealTimers();
  });

  it("uses sliding window not fixed window", () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(3, 1000);

    limiter.allow("ip1"); // t=0
    vi.advanceTimersByTime(400);
    limiter.allow("ip1"); // t=400
    vi.advanceTimersByTime(400);
    limiter.allow("ip1"); // t=800
    expect(limiter.allow("ip1")).toBe(false); // t=800, 3 in window

    vi.advanceTimersByTime(201); // t=1001 -- first request expired
    expect(limiter.allow("ip1")).toBe(true);

    vi.useRealTimers();
  });

  it("handles burst at exactly the limit", () => {
    const limiter = new RateLimiter(60, 60_000);
    for (let i = 0; i < 60; i++) {
      expect(limiter.allow("ip1")).toBe(true);
    }
    expect(limiter.allow("ip1")).toBe(false);
  });

  it("returns true for first request from new key", () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.allow("new-key")).toBe(true);
  });

  it("returns false immediately after limit=1 is hit", () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.allow("ip1");
    expect(limiter.allow("ip1")).toBe(false);
    expect(limiter.allow("ip1")).toBe(false);
  });
});
