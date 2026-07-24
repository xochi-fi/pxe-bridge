import { describe, it, expect, vi, afterEach } from "vitest";
import { TransactionLimits } from "../src/limits.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TransactionLimits", () => {
  describe("per-tx ceiling", () => {
    it("allows amount at ceiling", () => {
      const limits = new TransactionLimits({ maxAmount: 1000n });
      const result = limits.check(1000n);
      expect(result.allowed).toBe(true);
    });

    it("rejects amount above ceiling", () => {
      const limits = new TransactionLimits({ maxAmount: 1000n });
      const result = limits.check(1001n);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain("1001");
        expect(result.reason).toContain("1000");
      }
    });

    it("allows any amount when no ceiling configured", () => {
      const limits = new TransactionLimits({});
      const result = limits.check(999_999_999n);
      expect(result.allowed).toBe(true);
    });
  });

  describe("rolling daily volume", () => {
    it("allows spend within daily limit", () => {
      const limits = new TransactionLimits({ dailyLimit: 5000n });
      limits.recordSpend(2000n);
      const result = limits.check(2000n);
      expect(result.allowed).toBe(true);
    });

    it("rejects spend that would exceed daily limit", () => {
      const limits = new TransactionLimits({ dailyLimit: 5000n });
      limits.recordSpend(3000n);
      const result = limits.check(3000n);
      expect(result.allowed).toBe(false);
    });

    it("trips circuit breaker and stays paused", () => {
      const limits = new TransactionLimits({ dailyLimit: 5000n });
      limits.recordSpend(4000n);

      // This check trips the breaker
      const result1 = limits.check(2000n);
      expect(result1.allowed).toBe(false);
      expect(limits.isPaused()).toBe(true);

      // Even small amounts are rejected while paused
      const result2 = limits.check(1n);
      expect(result2.allowed).toBe(false);
    });

    it("resumes after manual resume", () => {
      const limits = new TransactionLimits({ dailyLimit: 5000n });
      limits.recordSpend(4000n);
      limits.check(2000n); // trips breaker
      expect(limits.isPaused()).toBe(true);

      limits.resume();
      expect(limits.isPaused()).toBe(false);

      // Allows if under limit after resume
      const result = limits.check(500n);
      expect(result.allowed).toBe(true);
    });

    it("expires old spend entries after 24h", () => {
      const limits = new TransactionLimits({ dailyLimit: 5000n });

      // Record spend "25 hours ago"
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now - 25 * 60 * 60 * 1000);
      limits.recordSpend(4000n);

      // Back to present
      vi.spyOn(Date, "now").mockReturnValue(now);
      const result = limits.check(4000n);
      expect(result.allowed).toBe(true);
    });
  });

  describe("cooldown", () => {
    it("returns cooldownMs for amounts at or above threshold", () => {
      const limits = new TransactionLimits({
        cooldownThreshold: 500n,
        cooldownDelayMs: 30_000,
      });
      const result = limits.check(500n);
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.cooldownMs).toBe(30_000);
      }
    });

    it("returns no cooldownMs for amounts below threshold", () => {
      const limits = new TransactionLimits({
        cooldownThreshold: 500n,
        cooldownDelayMs: 30_000,
      });
      const result = limits.check(499n);
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.cooldownMs).toBeUndefined();
      }
    });

    it("returns no cooldownMs when cooldown not configured", () => {
      const limits = new TransactionLimits({ maxAmount: 1000n });
      const result = limits.check(999n);
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.cooldownMs).toBeUndefined();
      }
    });
  });

  describe("combined limits", () => {
    it("checks ceiling before volume", () => {
      const limits = new TransactionLimits({
        maxAmount: 100n,
        dailyLimit: 5000n,
      });
      const result = limits.check(200n);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain("per-transaction maximum");
      }
    });
  });

  describe("reservation (TOCTOU protection)", () => {
    it("counts an uncommitted reservation toward the daily volume", () => {
      const limits = new TransactionLimits({ dailyLimit: 5000n });

      // First request reserves but has not committed yet (tx in flight)
      const first = limits.reserve(3000n);
      expect(first.allowed).toBe(true);

      // A concurrent request must see the reserved amount, not a stale zero
      const second = limits.reserve(3000n);
      expect(second.allowed).toBe(false);
    });

    it("blocks concurrent requests from collectively exceeding the cap", () => {
      const limits = new TransactionLimits({ dailyLimit: 100n, maxAmount: 100n });

      // Two in-flight requests each at the per-tx max; only one may pass
      const a = limits.reserve(100n);
      const b = limits.reserve(100n);

      expect(a.allowed).toBe(true);
      expect(b.allowed).toBe(false);
    });

    it("commit() makes a reservation a permanent spend", () => {
      const limits = new TransactionLimits({ dailyLimit: 5000n });
      const r = limits.reserve(3000n);
      expect(r.allowed).toBe(true);
      if (r.allowed) {
        limits.commit(r.reservationId);
      }

      // After commit the amount still counts; a further 3000 exceeds 5000
      const next = limits.reserve(3000n);
      expect(next.allowed).toBe(false);
    });

    it("release() frees a reservation so it no longer counts", () => {
      const limits = new TransactionLimits({ dailyLimit: 5000n });
      const r = limits.reserve(3000n);
      expect(r.allowed).toBe(true);
      if (r.allowed) {
        limits.release(r.reservationId);
      }

      // After release the window is clear again
      const next = limits.reserve(5000n);
      expect(next.allowed).toBe(true);
    });

    it("propagates cooldown through the reservation", () => {
      const limits = new TransactionLimits({
        cooldownThreshold: 500n,
        cooldownDelayMs: 30_000,
      });
      const r = limits.reserve(500n);
      expect(r.allowed).toBe(true);
      if (r.allowed) {
        expect(r.cooldownMs).toBe(30_000);
      }
    });

    it("commit/release on an unknown id is a no-op", () => {
      const limits = new TransactionLimits({ dailyLimit: 5000n });
      expect(() => limits.commit(999)).not.toThrow();
      expect(() => limits.release(999)).not.toThrow();
      const r = limits.reserve(5000n);
      expect(r.allowed).toBe(true);
    });
  });
});
