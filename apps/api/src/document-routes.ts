import type { Express, Request, Response, NextFunction } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { requireAuth } from "./security";
import { prisma } from "./db";
import { processDocument } from "./document-processing";

const storageRoot = path.resolve(process.cwd(), "private-uploads");
fs.mkdirSync(storageRoot, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, storageRoot),
    filename: (_req, _file, cb) => cb(null, randomUUID())
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      "application/pdf",
      "image/jpeg",
      "image/png"
    ]);
    if (!allowed.has(file.mimetype)) {
      cb(new Error("Only PDF, JPEG and PNG files are allowed"));
      return;
    }
    cb(null, true);
  }
});

export function registerDocumentRoutes(app: Express) {
  app.get(
    "/applications/:applicationId/documents",
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = req.authUser!.tenantId;
        const application = await prisma.application.findFirst({
          where: {
            id: String(req.params.applicationId),
            tenantId
          },
          select: { id: true }
        });

        if (!application) {
          return res.status(404).json({ error: "Application not found" });
        }

        const items = await prisma.document.findMany({
          where: { applicationId: application.id },
          select: {
            id: true,
            originalName: true,
            mimeType: true,
            checksumSha256: true,
            version: true,
            status: true,
            uploadedAt: true,
            extractions: {
              select: {
                id: true,
                fieldName: true,
                extractedValue: true,
                confidence: true,
                pageNumber: true,
                sourceText: true,
                humanVerified: true, verifiedByUserId: true, verifiedAt: true
              }
            }
          },
          orderBy: { uploadedAt: "desc" },
          take: 100
        });

        return res.json({ items });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/applications/:applicationId/documents",
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      upload.single("file")(req, res, async (uploadError) => {
        if (uploadError) {
          const message = uploadError instanceof Error
            ? uploadError.message
            : "Upload failed";
          const status = message.includes("File too large") ? 413 : 400;
          return res.status(status).json({ error: message });
        }

        const file = req.file;
        if (!file) {
          return res.status(400).json({ error: "Choose a PDF, JPEG or PNG file" });
        }

        try {
          const auth = req.authUser!;
          const application = await prisma.application.findFirst({
            where: {
              id: String(req.params.applicationId),
              tenantId: auth.tenantId
            },
            select: { id: true }
          });

          if (!application) {
            await fs.promises.unlink(file.path).catch(() => undefined);
            return res.status(404).json({ error: "Application not found" });
          }

          const signature = Buffer.alloc(8);
          const handle = await fs.promises.open(file.path, "r");
          try {
            await handle.read(signature, 0, 8, 0);
          } finally {
            await handle.close();
          }

          const isPdf = signature.subarray(0, 5).toString() === "%PDF-";
          const isPng = signature.subarray(0, 8).equals(
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
          );
          const isJpeg = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;

          const signatureMatches =
            (file.mimetype === "application/pdf" && isPdf) ||
            (file.mimetype === "image/png" && isPng) ||
            (file.mimetype === "image/jpeg" && isJpeg);

          if (!signatureMatches) {
            await fs.promises.unlink(file.path).catch(() => undefined);
            return res.status(400).json({
              error: "File content does not match its declared PDF or image type"
            });
          }

          const bytes = await fs.promises.readFile(file.path);
          const checksumSha256 = createHash("sha256").update(bytes).digest("hex");

          const previous = await prisma.document.findFirst({
            where: {
              applicationId: application.id,
              originalName: file.originalname
            },
            orderBy: { version: "desc" },
            select: { version: true }
          });

          const document = await prisma.document.create({
            data: {
              applicationId: application.id,
              storageKey: path.basename(file.filename),
              originalName: path.basename(file.originalname).slice(0, 255),
              mimeType: file.mimetype,
              checksumSha256,
              version: (previous?.version ?? 0) + 1,
              status: "QUARANTINED",
              uploadedByUserId: auth.userId
            },
            select: {
              id: true,
              originalName: true,
              mimeType: true,
              checksumSha256: true,
              version: true,
              status: true,
              uploadedAt: true
            }
          });

          await prisma.auditEvent.create({
            data: {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: "DOCUMENT_UPLOADED",
              resourceType: "Document",
              resourceId: document.id
            }
          });

          return res.status(201).json({
            document,
            message: "Document stored privately. It remains quarantined until processing and review."
          });
        } catch (error) {
          await fs.promises.unlink(file.path).catch(() => undefined);
          return next(error);
        }
      });
    }
  );

  app.post(
    "/documents/:documentId/process",
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = req.authUser!.tenantId;
        const documentId = String(req.params.documentId);

        const document = await prisma.document.findFirst({
          where: {
            id: documentId,
            application: { tenantId }
          },
          select: {
            id: true,
            storageKey: true,
            mimeType: true,
            originalName: true
          }
        });

        if (!document) {
          return res.status(404).json({ error: "Document not found" });
        }

        const filePath = path.join(storageRoot, document.storageKey);

        const result = await processDocument(filePath, document.mimeType);

        // Replace previous machine-generated, unverified fields.
        // Preserve any fields already verified by a human reviewer.
        await prisma.$transaction(async tx => {
          await tx.evidenceExtraction.deleteMany({
            where: {
              documentId: document.id,
              humanVerified: false
            }
          });

          for (const field of result.fields) {
            await tx.evidenceExtraction.create({
              data: {
                documentId: document.id,
                fieldName: field.fieldName,
                extractedValue: field.extractedValue,
                confidence: field.confidence,
                sourceText: field.sourceText,
                humanVerified: false
              }
            });
          }

          await tx.auditEvent.create({
            data: {
              tenantId,
              actorUserId: req.authUser!.userId,
              action: "DOCUMENT_TEXT_EXTRACTED",
              resourceType: "Document",
              resourceId: document.id
            }
          });
        });

        return res.json({
          documentId: document.id,
          originalName: document.originalName,
          processingMode: result.processingMode,
          pageCount: result.pageCount,
          extractedFieldCount: result.fields.length,
          fields: result.fields,
          warnings: result.warnings,
          reviewRequired: true
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/documents/:documentId/extractions/:extractionId/verify",
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const user = req.authUser!;
        const role = String(user.role).toUpperCase();

        if (!["ADMIN", "REVIEWER"].includes(role)) {
          return res.status(403).json({
            error: "Only an admin or reviewer can verify extracted evidence."
          });
        }

        const documentId = String(req.params.documentId);
        const extractionId = String(req.params.extractionId);
        const tenantId = user.tenantId;

        const extraction = await prisma.evidenceExtraction.findFirst({
          where: {
            id: extractionId,
            documentId,
            document: {
              application: { tenantId }
            }
          },
          select: {
            id: true,
            fieldName: true,
            extractedValue: true,
            humanVerified: true, verifiedByUserId: true, verifiedAt: true
          }
        });

        if (!extraction) {
          return res.status(404).json({ error: "Evidence field not found." });
        }

        const updated = await prisma.$transaction(async tx => {
          const result = await tx.evidenceExtraction.update({
            where: { id: extraction.id },
            data: {
              humanVerified: true, verifiedByUserId: user.userId, verifiedAt: new Date()
            }
          });

          await tx.auditEvent.create({
            data: {
              tenantId,
              actorUserId: user.userId,
              action: "EVIDENCE_EXTRACTION_VERIFIED",
              resourceType: "EvidenceExtraction",
              resourceId: extraction.id
            }
          });

          return result;
        });

        return res.json({
          id: updated.id,
          fieldName: updated.fieldName,
          extractedValue: updated.extractedValue,
          humanVerified: updated.humanVerified,
          verifiedAt: updated.verifiedAt,
          verifiedByUserId: updated.verifiedByUserId
        });
      } catch (error) {
        return next(error);
      }
    }
  );
}



