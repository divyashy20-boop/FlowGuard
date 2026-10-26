import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createWorker } from "tesseract.js";

export type ExtractedField = {
  fieldName: string;
  extractedValue: string;
  confidence: number;
  confidenceBasis: string;
  sourceText: string;
  pageNumber: number | null;
  extractor: string;
  extractorVersion: string;
};

export type ProcessingResult = {
  processingMode: string;
  pageCount: number | null;
  fields: ExtractedField[];
  warnings: string[];
};

export interface FieldExtractor {
  readonly name: string;
  readonly version: string;
  extract(pages: Array<{ text: string; pageNumber: number | null; confidenceBasis: string }>): ExtractedField[];
}

export interface AIFieldExtractionProvider {
  readonly providerName: string;
  readonly modelVersion: string;
  extract(input: { text: string; workflowCategory: string | null }): Promise<ExtractedField[]>;
}

export class RuleBasedFieldExtractor implements FieldExtractor {
  readonly name = "RULES";
  readonly version = "rules-v1";

  extract(pages: Array<{ text: string; pageNumber: number | null; confidenceBasis: string }>) {
    const output: ExtractedField[] = [];
    const patterns: Array<[string, RegExp]> = [
      ["registration_number", /\b(?:registration|reg\.?|certificate)\s*(?:number|no\.?|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/. _-]{2,})/i],
      ["document_number", /\b(?:document|reference|ref\.?|order|file)\s*(?:number|no\.?|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/. _-]{2,})/i],
      ["issue_date", /\b(?:date of issue|issued on|issue date)\s*[:\-]?\s*((?:\d{1,2}[\/.-]){2}\d{2,4}|\d{4}-\d{2}-\d{2}|(?:\d{1,2}\s+)?[A-Za-z]{3,9}\s+\d{4})/i],
      ["validity_until", /\b(?:valid (?:until|till|upto|up to)|validity|expires? on|expiry date|expiration date)\s*[:\-]?\s*((?:\d{1,2}[\/.-]){2}\d{2,4}|\d{4}-\d{2}-\d{2}|(?:\d{1,2}\s+)?[A-Za-z]{3,9}\s+\d{4})/i],
      ["institution_name", /\b(?:name of institution|institution name|name of college|college name|institution)\s*[:\-]\s*([^\r\n]{3,180})/i],
      ["promoter_name", /\b(?:trust name|society name|promoter name|name of trust|name of society|section 8 company)\s*[:\-]\s*([^\r\n]{3,180})/i]
    ];

    for (const page of pages) {
      for (const line of page.text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
        for (const [fieldName, pattern] of patterns) {
          const match = line.match(pattern);
          const value = match?.[1]?.trim().replace(/\s+/g, " ").slice(0, 500);
          if (!value || output.some(field => field.fieldName === fieldName && field.extractedValue.toLowerCase() === value.toLowerCase())) continue;
          output.push({
            fieldName,
            extractedValue: value,
            confidence: 0.5,
            confidenceBasis: `${page.confidenceBasis}_HEURISTIC_UNCALIBRATED`,
            sourceText: line.slice(0, 1000),
            pageNumber: page.pageNumber,
            extractor: this.name,
            extractorVersion: this.version
          });
        }
      }
    }
    return output;
  }
}

export const fieldExtractor: FieldExtractor = new RuleBasedFieldExtractor();

function rasterizePdf(source: string, prefix: string) {
  return new Promise<void>((resolve, reject) => {
    execFile("pdftoppm", ["-f", "1", "-l", "20", "-scale-to", "2400", "-png", source, prefix], { timeout: 60_000, windowsHide: true }, error => error ? reject(error) : resolve());
  });
}

async function recognizeImage(bytes: Buffer) {
  const worker = await createWorker("eng");
  try {
    const result = await worker.recognize(bytes);
    return { text: result.data.text ?? "", confidence: Number(result.data.confidence) };
  } finally {
    await worker.terminate();
  }
}

export async function processDocumentBytes(bytes: Buffer, mimeType: string): Promise<ProcessingResult> {
  const warnings: string[] = [];
  let pages: Array<{ text: string; pageNumber: number | null; confidenceBasis: string }> = [];
  let processingMode = "RULE_BASED";
  let pageCount: number | null = null;

  if (mimeType === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(bytes);
    pageCount = Number.isFinite(parsed.numpages) ? parsed.numpages : null;
    const textPages = String(parsed.text ?? "").split("\f").map(value => value.trim());
    if (textPages.some(value => value.length > 0)) {
      pages = textPages.flatMap((text, index) => text ? [{ text, pageNumber: textPages.length > 1 ? index + 1 : null, confidenceBasis: "PDF_TEXT" }] : []);
      processingMode = "PDF_TEXT";
    }

    const needsOcr = !pages.length || textPages.length < (pageCount ?? textPages.length) || textPages.some(value => value.length < 30);
    if (needsOcr) {
      if (pageCount && pageCount > 20) warnings.push("Scanned PDF OCR is limited to the first 20 pages per processing run.");
      const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "flowguard-pdf-"));
      try {
        const pdfPath = path.join(temporaryDirectory, "source.pdf");
        const prefix = path.join(temporaryDirectory, "page");
        await fs.writeFile(pdfPath, bytes, { mode: 0o600 });
        await rasterizePdf(pdfPath, prefix);
        const imagePaths = (await fs.readdir(temporaryDirectory)).filter(name => name.endsWith(".png")).sort();
        for (let index = 0; index < imagePaths.length; index += 1) {
          if ((textPages[index] ?? "").length >= 30) continue;
          const recognized = await recognizeImage(await fs.readFile(path.join(temporaryDirectory, imagePaths[index])));
          if (recognized.text.trim()) pages.push({ text: recognized.text, pageNumber: index + 1, confidenceBasis: "TESSERACT_RAW_UNCALIBRATED" });
        }
        if (pages.some(page => page.confidenceBasis === "TESSERACT_RAW_UNCALIBRATED")) processingMode = textPages.some(value => value.length) ? "PDF_TEXT_AND_IMAGE_OCR" : "PDF_IMAGE_OCR";
        if (!pages.length) warnings.push("No selectable text or OCR text was detected in the PDF.");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        warnings.push(code === "ENOENT" ? "Scanned PDF OCR is unavailable because the optional Poppler pdftoppm utility is not installed." : "Scanned PDF rasterization failed; the original file remains available for review.");
      } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  } else if (mimeType === "image/jpeg" || mimeType === "image/png") {
    const recognized = await recognizeImage(bytes);
    pages = recognized.text.trim() ? [{ text: recognized.text, pageNumber: 1, confidenceBasis: "TESSERACT_RAW_UNCALIBRATED" }] : [];
    processingMode = "IMAGE_OCR";
    pageCount = 1;
    if (!pages.length) warnings.push("OCR did not detect readable text in this image.");
  } else {
    throw new Error("Unsupported document type.");
  }

  if (!pages.length && !warnings.length) warnings.push("No readable text was extracted.");
  if (pages.length) warnings.push("Extracted fields are unverified suggestions. Rule confidence is heuristic and uncalibrated; OCR confidence is a raw engine signal, not a probability.");
  return { processingMode, pageCount, fields: fieldExtractor.extract(pages), warnings };
}
