// Uploaded Files Routes - store raw uploaded resumes (PDF/DOCX/TXT) for Job Match.
// These are NOT parsed into builder resumes and do NOT appear in "My Resumes".
// Only deterministic raw-text extraction is performed (no LLM structured parsing).

import { Router, type Request, type Response } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.js";
import { handleApiError } from "../shared/errors.js";
import { BadRequestError, NotFoundError } from "../shared/errors.js";
import { ensureOwnership } from "../shared/auth.js";
import { prisma } from "../lib/prisma.js";
import { extractRawText, validateUploadedFile } from "../resume/parser.js";

const router = Router();

// Configure multer for file uploads (10MB limit)
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 },
  storage: multer.memoryStorage(),
});

const ALLOWED_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
];

// Response-size guard for a 10 MB TXT upload whose extracted text is unbounded.
export const MAX_EXTRACTED_TEXT_CAP = 200_000;

function sanitizeFileName(name: string): string {
  const cleaned = (name || "").replace(/["\x00-\x1F\x7F]/g, "").trim();
  return cleaned || "file";
}

/**
 * Upload a raw resume file. Stored as bytes + deterministic extracted text.
 * Never parsed into a structured builder resume.
 */
router.post("/", requireAuth, upload.single("file"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      throw new BadRequestError("No file uploaded");
    }

    if (!ALLOWED_MIME.includes(file.mimetype)) {
      throw new BadRequestError("Invalid file type. Allowed: PDF, DOCX, TXT");
    }

    validateUploadedFile(file.buffer, file.mimetype, file.originalname);

    const extractedText = await extractRawText(file.buffer, file.mimetype);
    if (!extractedText || extractedText.trim() === '') {
      // Warning only: store the raw bytes anyway so the original file stays
      // downloadable and viewable even when nothing extractable was found.
      console.warn(
        `[uploaded-files] no extractable text for upload "${file.originalname}" ` +
          `(${file.mimetype}, ${file.buffer.length} bytes); storing bytes anyway`
      );
    }

    const created = await prisma.uploadedFile.create({
      data: {
        userId: req.user!.id,
        fileName: file.originalname,
        fileType: file.mimetype,
        fileBytes: file.buffer,
        extractedText,
      },
    });

    res.status(201).json({
      id: created.id,
      fileName: created.fileName,
      fileType: created.fileType,
      createdAt: created.createdAt,
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

/**
 * List the current user's uploaded files (raw, for Job Match).
 */
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const files = await prisma.uploadedFile.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        fileName: true,
        fileType: true,
        createdAt: true,
      },
    });
    res.json({ files });
  } catch (error) {
    handleApiError(error, res);
  }
});

/**
 * View an uploaded file's raw bytes inline (no download, no builder rendering).
 */
router.get("/:fileId/view", requireAuth, async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file) {
      throw new NotFoundError("Uploaded file");
    }
    await ensureOwnership(req.user!.id, file.userId, "Uploaded file");

    res.setHeader("Content-Type", file.fileType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${sanitizeFileName(file.fileName)}"`);
    res.setHeader("Content-Length", String(Buffer.from(file.fileBytes).length));
    res.send(Buffer.from(file.fileBytes));
  } catch (error) {
    handleApiError(error, res);
  }
});

/**
 * Read an uploaded file's stored extracted text (capped response, never bytes).
 */
router.get("/:fileId/text", requireAuth, async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file) {
      throw new NotFoundError("Uploaded file");
    }
    await ensureOwnership(req.user!.id, file.userId, "Uploaded file");

    const stored = file.extractedText ?? "";
    const truncated = stored.length > MAX_EXTRACTED_TEXT_CAP;
    res.json({ text: truncated ? stored.slice(0, MAX_EXTRACTED_TEXT_CAP) : stored, truncated });
  } catch (error) {
    handleApiError(error, res);
  }
});

/**
 * Download an uploaded file's raw bytes.
 */
router.get("/:fileId", requireAuth, async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file) {
      throw new NotFoundError("Uploaded file");
    }
    await ensureOwnership(req.user!.id, file.userId, "Uploaded file");

    res.setHeader("Content-Type", file.fileType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFileName(file.fileName)}"`);
    res.send(Buffer.from(file.fileBytes));
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
