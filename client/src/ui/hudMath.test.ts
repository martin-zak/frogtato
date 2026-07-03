import { describe, expect, it } from "vitest";
import { computeRemainingSec, formatCountdown, cooldownSweepFraction } from "./hudMath.js";

describe("computeRemainingSec", () => {
  it("returns null when the snapshot has no phaseEndsAt", () => {
    expect(computeRemainingSec(undefined, 1000, 1000)).toBeNull();
  });

  it("returns the full remaining time at the moment of receipt", () => {
    // phaseEndsAt is 5000ms after recvAt; asking "now" == recvAt.
    expect(computeRemainingSec(6000, 1000, 1000)).toBe(5);
  });

  it("ticks down using client-side elapsed time since receipt, not raw Date.now() vs phaseEndsAt", () => {
    // 5s remaining at recvAt=1000; 2s of client wall-clock time pass.
    expect(computeRemainingSec(6000, 1000, 3000)).toBe(3);
  });

  it("clamps to 0 once the deadline has passed", () => {
    expect(computeRemainingSec(6000, 1000, 9000)).toBe(0);
  });

  it("re-anchors per snapshot: two snapshots with the same phaseEndsAt but different recvAt still agree once time has passed accordingly", () => {
    // snapshot A: recvAt=1000, snapshot B: recvAt=1500 (both report the same
    // absolute phaseEndsAt=6000). At the same absolute "now", they must
    // produce the same remaining value regardless of which snapshot the
    // caller used.
    const a = computeRemainingSec(6000, 1000, 4000);
    const b = computeRemainingSec(6000, 1500, 4000);
    expect(a).toBe(b);
    expect(a).toBe(2);
  });
});

describe("formatCountdown", () => {
  it("renders null as an empty string", () => {
    expect(formatCountdown(null)).toBe("");
  });

  it("rounds up to the nearest whole second", () => {
    expect(formatCountdown(4.2)).toBe("5s");
  });

  it("never goes negative", () => {
    expect(formatCountdown(-1)).toBe("0s");
  });

  it("shows 0s at exactly zero", () => {
    expect(formatCountdown(0)).toBe("0s");
  });
});

describe("cooldownSweepFraction", () => {
  it("is 0 when the weapon has never fired (no lastAttackAtMs)", () => {
    expect(cooldownSweepFraction(null, 1000, 0.8)).toBe(0);
  });

  it("is 1 immediately after firing", () => {
    expect(cooldownSweepFraction(1000, 1000, 0.8)).toBe(1);
  });

  it("is half at the cooldown's midpoint", () => {
    expect(cooldownSweepFraction(1000, 1400, 0.8)).toBeCloseTo(0.5);
  });

  it("is 0 once the cooldown has fully elapsed", () => {
    expect(cooldownSweepFraction(1000, 1800, 0.8)).toBe(0);
    expect(cooldownSweepFraction(1000, 5000, 0.8)).toBe(0);
  });

  it("is 0 for a non-positive cooldown (defensive)", () => {
    expect(cooldownSweepFraction(1000, 1000, 0)).toBe(0);
  });
});
