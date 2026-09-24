import { describe, expect, it } from "vitest";
import { assignKey } from "@/lib/sync/discover";

describe("assignKey", () => {
  it("uses the letter prefix from names like 'A: …'", () => {
    expect(assignKey("A: Website + Normal SMS", new Set())).toBe("A");
    expect(assignKey("e - New test", new Set())).toBe("E");
  });

  it("falls back to the next free letter, then L27+", () => {
    expect(assignKey("A: dup", new Set(["A"]))).toBe("B");
    expect(assignKey("Acme Roofing", new Set(["A", "B"]))).toBe("C");
    const all = new Set(Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)));
    expect(assignKey("Another", all)).toBe("L27");
  });
});
