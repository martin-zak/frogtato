import { beforeEach, describe, expect, it } from "vitest";
import { MAX_NAME_LENGTH } from "@frogtato/shared";
import { sanitizeName, loadStoredName, storeName, fallbackName, displayName } from "./nameField.js";

describe("sanitizeName", () => {
  it("trims surrounding whitespace", () => {
    expect(sanitizeName("  Frogger  ")).toBe("Frogger");
  });

  it("truncates to MAX_NAME_LENGTH characters", () => {
    const long = "x".repeat(MAX_NAME_LENGTH + 10);
    expect(sanitizeName(long)).toHaveLength(MAX_NAME_LENGTH);
    expect(sanitizeName(long)).toBe("x".repeat(MAX_NAME_LENGTH));
  });

  it("leaves a short name unchanged", () => {
    expect(sanitizeName("Kip")).toBe("Kip");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(sanitizeName("   ")).toBe("");
  });
});

describe("fallbackName", () => {
  it("1-indexes the row position", () => {
    expect(fallbackName(0)).toBe("Frog 1");
    expect(fallbackName(3)).toBe("Frog 4");
  });
});

describe("displayName", () => {
  it("uses the player's name when set", () => {
    expect(displayName({ name: "Kip" }, 0)).toBe("Kip");
  });

  it("falls back to Frog N when name is undefined", () => {
    expect(displayName({}, 2)).toBe("Frog 3");
  });

  it("falls back to Frog N when name is empty/whitespace-only", () => {
    expect(displayName({ name: "   " }, 1)).toBe("Frog 2");
  });

  it("trims a name with surrounding whitespace when displaying it", () => {
    expect(displayName({ name: "  Kip  " }, 0)).toBe("Kip");
  });
});

describe("loadStoredName / storeName", () => {
  beforeEach(() => {
    try {
      globalThis.localStorage?.clear();
    } catch {
      // no localStorage in this environment (plain Node) — nothing to clear
    }
  });

  it("round-trips a stored name when localStorage is available", () => {
    if (typeof globalThis.localStorage === "undefined") return; // plain Node: no-op environment
    storeName("Kip");
    expect(loadStoredName()).toBe("Kip");
  });

  it("returns empty string when nothing is stored", () => {
    expect(loadStoredName()).toBe("");
  });
});
