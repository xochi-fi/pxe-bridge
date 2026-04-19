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
});
