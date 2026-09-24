import { describe, expect, it } from "vitest";
import { ghlContactSchema } from "@/lib/ghl/schemas";
import { canonicalStage, deriveNiche, mapContact, normalizeStageName, parseMessageError, phoneLast4 } from "@/lib/sync/mappers";

describe("stage normalization", () => {
  it("lowercases, trims and collapses spaces", () => {
    expect(normalizeStageName("  Loom   Sent ")).toBe("loom sent");
    expect(normalizeStageName("Interested -  Positive Reply")).toBe("interested - positive reply");
  });

  it("maps spelling variants to the canonical name", () => {
    expect(canonicalStage("Loom Sent", "A")).toBe("Loom sent");
    expect(canonicalStage("loom sent", "B")).toBe("Loom sent");
    expect(canonicalStage("FOLLOW UP LATER", "C")).toBe("Follow Up Later");
    expect(canonicalStage("Something else", "A")).toBeNull();
  });

  it("applies overrides, location-specific first", () => {
    const overrides = [
      { locationKey: "*", normalizedName: "loom delivered", canonicalName: "Loom sent" },
      { locationKey: "D", normalizedName: "loom delivered", canonicalName: "Watched No Reply" },
    ];
    expect(canonicalStage("Loom Delivered", "A", overrides)).toBe("Loom sent");
    expect(canonicalStage("Loom Delivered", "D", overrides)).toBe("Watched No Reply");
  });
});

describe("field helpers", () => {
  it("keeps only the last 4 phone digits", () => {
    expect(phoneLast4("+1 (678) 629-7315")).toBe("7315");
    expect(phoneLast4("12")).toBeNull();
    expect(phoneLast4(null)).toBeNull();
  });

  it("parses carrier error codes", () => {
    expect(parseMessageError("Error 30007 - Carrier filtered")).toEqual({
      code: "30007",
      message: "Error 30007 - Carrier filtered",
    });
    expect(parseMessageError(undefined)).toEqual({ code: null, message: null });
    expect(parseMessageError({ code: 30003 }).code).toBe("30003");
  });

  it("derives niche from tag prefix or custom field", () => {
    const c = { tags: ["sms 1", "Niche:Roofing"], customFields: [{ id: "f1", value: "Decks " }] };
    expect(deriveNiche(c, { type: "tag_prefix", prefix: "niche:" })).toBe("roofing");
    expect(deriveNiche(c, { type: "custom_field", fieldId: "f1" })).toBe("decks");
    expect(deriveNiche(c, { type: "none" })).toBeNull();
  });
});

describe("mapContact", () => {
  it("treats an active SMS DND setting as DND and falls back to the name for company", () => {
    const contact = ghlContactSchema.parse({
      id: "c1",
      locationId: "L",
      firstName: "Acme",
      lastName: "Builders LLC",
      companyName: null,
      phone: "+15551234567",
      dnd: false,
      dndSettings: { SMS: { status: "active", message: "TWILIO_ERROR_CODE: 30005" } },
      unknownField: "tolerated",
    });
    const row = mapContact(contact, "A", { type: "none" });
    expect(row).toMatchObject({
      companyName: "Acme Builders LLC",
      dnd: true,
      dndMessage: "TWILIO_ERROR_CODE: 30005",
      phoneLast4: "4567",
      tags: [],
    });
  });
});
