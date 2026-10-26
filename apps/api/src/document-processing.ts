import fs from "node:fs/promises";
import pdfParse from "pdf-parse";
import { createWorker } from "tesseract.js";

export type ExtractedField = {
  fieldName: string;
  extractedValue: string;
  confidence: number;
  sourceText: string;
};

export type DocumentProcessingResult = {
  processingMode: "PDF_TEXT" | "IMAGE_OCR";
  text: string;
  pageCount: number | null;
  fields: ExtractedField[];
  warnings: string[];
};

function addField(
  fields: ExtractedField[],
  fieldName: string,
  value: string,
  sourceText: string,
  confidence: number
) {
  const cleanValue = value.trim().replace(/\s+/g, " ");
  if (!cleanValue) return;

  if (fields.some(
    field =>
      field.fieldName === fieldName &&
      field.extractedValue.toLowerCase() === cleanValue.toLowerCase()
  )) return;

  fields.push({
    fieldName,
    extractedValue: cleanValue,
    confidence,
    sourceText: sourceText.trim().slice(0, 500)
  });
}

function extractFields(text: string): ExtractedField[] {
  const fields: ExtractedField[] = [];
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

  const patterns: Array<{
    fieldName: string;
    regex: RegExp;
    confidence: number;
  }> = [
    {
      fieldName: "registration_number",
      regex: /\b(?:registration|reg\.?|certificate)\s*(?:number|no\.?|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/._-]{2,})/i,
      confidence: 0.75
    },
    {
      fieldName: "document_number",
      regex: /\b(?:document|reference|ref\.?|order|file)\s*(?:number|no\.?|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/._-]{2,})/i,
      confidence: 0.70
    },
    {
      fieldName: "issue_date",
      regex: /\b(?:date of issue|issued on|issue date)\s*[:\-]?\s*((?:\d{1,2}[\/.-]){2}\d{2,4}|\d{4}-\d{2}-\d{2}|(?:\d{1,2}\s+)?[A-Za-z]{3,9}\s+\d{4})/i,
      confidence: 0.70
    },
    {
      fieldName: "validity_until",
      regex: /\b(?:valid (?:until|till|upto|up to)|validity|expires? on|expiry date|expiration date)\s*[:\-]?\s*((?:\d{1,2}[\/.-]){2}\d{2,4}|\d{4}-\d{2}-\d{2}|(?:\d{1,2}\s+)?[A-Za-z]{3,9}\s+\d{4})/i,
      confidence: 0.70
    },
    {
      fieldName: "institution_name",
      regex: /\b(?:name of institution|institution name|name of college|college name|institution)\s*[:\-]\s*([^\r\n]{3,180})/i,
      confidence: 0.65
    },
    {
      fieldName: "promoter_name",
      regex: /\b(?:trust name|society name|promoter name|name of trust|name of society|section 8 company)\s*[:\-]\s*([^\r\n]{3,180})/i,
      confidence: 0.65
    }
  ];

  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (match?.[1]) {
        addField(fields, pattern.fieldName, match[1], line, pattern.confidence);
      }
    }
  }

  // Capture dates for review when no labelled date was found.
  const dateRegex =
    /\b(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/g;

  for (const match of text.matchAll(dateRegex)) {
    const sourceLine =
      lines.find(line => line.includes(match[0])) ?? match[0];

    addField(fields, "date_for_review", match[0], sourceLine, 0.50);
  }

  return fields;
}

export async function processDocument(
  filePath: string,
  mimeType: string
): Promise<DocumentProcessingResult> {
  const buffer = await fs.readFile(filePath);
  const warnings: string[] = [];
  let text = "";
  let pageCount: number | null = null;
  let processingMode: DocumentProcessingResult["processingMode"];

  if (mimeType === "application/pdf") {
    processingMode = "PDF_TEXT";

    const parsed = await pdfParse(buffer);
    text = parsed.text ?? "";
    pageCount = parsed.numpages ?? null;

    if (text.trim().length < 30) {
      warnings.push(
        "Little or no selectable text was found. This may be a scanned PDF; PDF page-to-image OCR is not yet enabled."
      );
    }
  } else if (mimeType === "image/jpeg" || mimeType === "image/png") {
    processingMode = "IMAGE_OCR";

    const worker = await createWorker("eng");
    try {
      const result = await worker.recognize(buffer);
      text = result.data.text ?? "";
    } finally {
      await worker.terminate();
    }

    if (!text.trim()) {
      warnings.push("OCR did not detect readable text in this image.");
    }
  } else {
    throw new Error("Unsupported document type for text extraction.");
  }

  if (text.trim().length > 0) {
    warnings.push(
      "Extracted fields are machine-generated suggestions. A reviewer must verify them against the source document."
    );
  }

  return {
    processingMode,
    text,
    pageCount,
    fields: extractFields(text),
    warnings
  };
}
