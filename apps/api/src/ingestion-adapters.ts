import { z } from "zod";

export type FixtureInstitution = {
  sourceRecordKey: string;
  name: string;
  institutionType: "ENGINEERING" | "MANAGEMENT" | "PHARMACY" | "OTHER";
  address: string;
  promoterName: string;
};

export const localInstitutionRecordSchema = z.object({
  sourceRecordKey: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/),
  name: z.string().trim().min(2).max(200),
  institutionType: z.enum(["ENGINEERING", "MANAGEMENT", "PHARMACY", "OTHER"]),
  address: z.string().trim().max(1000).default(""),
  promoterName: z.string().trim().max(200).default("")
});

export class LocalJsonIngestionAdapter {
  readonly sourceType = "AUTHORIZED_LOCAL_JSON";
  parse(input: unknown) {
    return z.array(localInstitutionRecordSchema).min(1).max(500).parse(input);
  }
}

export interface IngestionAdapter {
  readonly sourceType: string;
  read(): Promise<FixtureInstitution[]>;
}

export class SyntheticLocalFixtureAdapter implements IngestionAdapter {
  readonly sourceType = "SYNTHETIC_LOCAL_FIXTURE";

  async read(): Promise<FixtureInstitution[]> {
    return [
      { sourceRecordKey: "SYNTH-001", name: "Northstar Institute of Technology", institutionType: "ENGINEERING", address: "Sample District, Example State", promoterName: "Northstar Education Trust" },
      { sourceRecordKey: "SYNTH-002", name: "Riverbend College of Management", institutionType: "MANAGEMENT", address: "Example City, Example State", promoterName: "Riverbend Learning Society" },
      { sourceRecordKey: "SYNTH-003", name: "Cedar Valley Pharmacy College", institutionType: "PHARMACY", address: "Illustration Nagar, Example State", promoterName: "Cedar Valley Foundation" }
    ];
  }
}

export class DisabledExternalSourceAdapter implements IngestionAdapter {
  readonly sourceType = "DISABLED_EXTERNAL";
  constructor(private readonly sourceName: string) {}
  async read(): Promise<FixtureInstitution[]> {
    throw new Error(`No verified source adapter or credentials are configured for ${this.sourceName}.`);
  }
}

export const syntheticFixtureAdapter: IngestionAdapter = new SyntheticLocalFixtureAdapter();
export const localJsonIngestionAdapter = new LocalJsonIngestionAdapter();
