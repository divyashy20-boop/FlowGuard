import { describe, expect, it } from "vitest";
import { RuleBasedFieldExtractor } from "./document-processing-pipeline";
import { similarity } from "./matching-intelligence";

describe("rule-based extraction provenance", () => {
  it("preserves field source, page and uncalibrated confidence metadata", () => {
    const extractor = new RuleBasedFieldExtractor();
    const fields = extractor.extract([{ text: "Institution Name: Northstar Institute\nRegistration Number: SYNTH-001", pageNumber: 2, confidenceBasis: "PDF_TEXT" }]);

    expect(fields.map(field => field.fieldName)).toEqual(["institution_name", "registration_number"]);
    const registration = fields.find(field => field.fieldName === "registration_number");
    expect(registration).toMatchObject({ extractedValue: "SYNTH-001", pageNumber: 2, confidence: 0.5, confidenceBasis: "RULE_HEURISTIC_UNCALIBRATED_FROM_PDF_TEXT", extractor: "RULES", extractorVersion: "rules-v1" });
    expect(registration?.sourceText).toContain("Registration Number");
  });
});

describe("deterministic candidate similarity", () => {
  it("normalizes case and punctuation while retaining uncertainty for near matches", () => {
    expect(similarity("Northstar Institute of Technology", "NORTHSTAR Institute of Technology")).toBe(1);
    expect(similarity("Riverbend College", "Riverbend Collage")).toBeGreaterThan(0.8);
    expect(similarity("Northstar Institute", "Cedar Valley Pharmacy")).toBeLessThan(0.5);
  });
});
