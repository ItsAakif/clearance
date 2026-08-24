CREATE TABLE "JobSourceHealth" (
  "id" TEXT NOT NULL,
  "jobBoardId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "lastRunAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastError" TEXT,
  "lastResultCount" INTEGER NOT NULL DEFAULT 0,
  "lastLatencyMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JobSourceHealth_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JobSourceHealth_jobBoardId_key" ON "JobSourceHealth"("jobBoardId");
ALTER TABLE "JobSourceHealth" ADD CONSTRAINT "JobSourceHealth_jobBoardId_fkey"
  FOREIGN KEY ("jobBoardId") REFERENCES "JobBoard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
