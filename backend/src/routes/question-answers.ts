// Question Answer Bank Routes - per-user interview Q&A management

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError } from '../shared/errors.js';
import { ensureOwnership } from '../shared/auth.js';
import { validateInput, createQuestionAnswerSchema, updateQuestionAnswerSchema } from '../shared/validation.js';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const category = req.query.category ? String(req.query.category) : undefined;
    const q = req.query.q ? String(req.query.q) : undefined;

    const where: Record<string, unknown> = { userId: req.user!.id };
    if (category) where.category = category;
    if (q) {
      where.OR = [
        { question: { contains: q, mode: 'insensitive' as any } },
        { answer: { contains: q, mode: 'insensitive' as any } },
      ];
    }

    const items = await prisma.questionAnswer.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });

    res.json(items);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(createQuestionAnswerSchema, req.body);

    const item = await prisma.questionAnswer.create({
      data: {
        userId: req.user!.id,
        question: body.question,
        answer: body.answer,
        category: body.category ?? null,
        notes: body.notes ?? null,
        tags: (body.tags ?? null) as any,
      },
    });

    res.status(201).json(item);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(updateQuestionAnswerSchema, req.body);
    const item = await prisma.questionAnswer.findUnique({ where: { id: req.params.id } });
    if (!item) throw new NotFoundError('Question Answer');
    await ensureOwnership(req.user!.id, item.userId, 'Question Answer');

    const updated = await prisma.questionAnswer.update({
      where: { id: item.id },
      data: {
        question: body.question,
        answer: body.answer,
        category: body.category,
        notes: body.notes,
        tags: (body.tags ?? null) as any,
      },
    });

    res.json(updated);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const item = await prisma.questionAnswer.findUnique({ where: { id: req.params.id } });
    if (!item) throw new NotFoundError('Question Answer');
    await ensureOwnership(req.user!.id, item.userId, 'Question Answer');
    await prisma.questionAnswer.delete({ where: { id: item.id } });
    res.status(204).send();
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
