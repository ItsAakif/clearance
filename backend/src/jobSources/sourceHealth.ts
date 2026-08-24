import prisma from '../lib/prisma.js';

export async function recordSourceSuccess(jobBoardId: string, resultCount: number, latencyMs: number): Promise<void> {
  try {
    await prisma.jobSourceHealth.upsert({
      where: { jobBoardId },
      create: {
        jobBoardId,
        status: 'healthy',
        consecutiveFailures: 0,
        lastRunAt: new Date(),
        lastSuccessAt: new Date(),
        lastFailureAt: null,
        lastError: null,
        lastResultCount: resultCount,
        lastLatencyMs: latencyMs,
      },
      update: {
        status: 'healthy',
        consecutiveFailures: 0,
        lastRunAt: new Date(),
        lastSuccessAt: new Date(),
        lastFailureAt: null,
        lastError: null,
        lastResultCount: resultCount,
        lastLatencyMs: latencyMs,
      },
    });
  } catch (error) {
    console.warn('[jobSources/sourceHealth] unable to record source health:', (error as Error).message);
  }
}

export async function recordSourceFailure(jobBoardId: string, error: unknown, latencyMs: number): Promise<void> {
  try {
    const message = String(error instanceof Error ? error.message : error).slice(0, 2000);
    await prisma.jobSourceHealth.upsert({
      where: { jobBoardId },
      create: {
        jobBoardId,
        status: 'failed',
        consecutiveFailures: 1,
        lastRunAt: new Date(),
        lastFailureAt: new Date(),
        lastError: message,
        lastResultCount: 0,
        lastLatencyMs: latencyMs,
      },
      update: {
        status: 'failed',
        consecutiveFailures: { increment: 1 },
        lastRunAt: new Date(),
        lastFailureAt: new Date(),
        lastError: message,
        lastResultCount: 0,
        lastLatencyMs: latencyMs,
      },
    });
  } catch (error) {
    console.warn('[jobSources/sourceHealth] unable to record source health:', (error as Error).message);
  }
}
