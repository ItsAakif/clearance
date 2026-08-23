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
    res.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
    res.send(Buffer.from(file.fileBytes));
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
