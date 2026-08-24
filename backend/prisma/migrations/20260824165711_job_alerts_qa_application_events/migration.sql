-- Add columns to existing tables
ALTER TABLE "Application" ADD COLUMN "followUpAt" TIMESTAMP(3);
ALTER TABLE "Application" ADD COLUMN "ghostedAt" TIMESTAMP(3);
ALTER TABLE "Application" ADD COLUMN "withdrawnAt" TIMESTAMP(3);

ALTER TABLE "SavedSearch" ADD COLUMN "minMatchScore" INTEGER;
ALTER TABLE "SavedSearch" ADD COLUMN "remoteOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SavedSearch" ADD COLUMN "sortBy" TEXT NOT NULL DEFAULT 'relevance';
ALTER TABLE "SavedSearch" ADD COLUMN "lastRunAt" TIMESTAMP(3);
ALTER TABLE "SavedSearch" ADD COLUMN "matchCount" INTEGER NOT NULL DEFAULT 0;

-- Create new tables
CREATE TABLE "QuestionAnswer" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "category" TEXT,
  "notes" TEXT,
  "tags" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QuestionAnswer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApplicationEvent" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "applicationId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "title" TEXT,
  "description" TEXT,
  "scheduledAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApplicationEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JobAlert" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "savedSearchId" TEXT,
  "name" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "location" TEXT,
  "sources" JSONB,
  "minMatchScore" INTEGER,
  "remoteOnly" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "lastRunAt" TIMESTAMP(3),
  "lastMatchCount" INTEGER NOT NULL DEFAULT 0,
  "notifyInApp" BOOLEAN NOT NULL DEFAULT true,
  "notifyEmail" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JobAlert_pkey" PRIMARY KEY ("id")
);

-- Create indexes
CREATE INDEX "QuestionAnswer_userId_idx" ON "QuestionAnswer"("userId");
CREATE INDEX "QuestionAnswer_category_idx" ON "QuestionAnswer"("category");
CREATE INDEX "ApplicationEvent_applicationId_idx" ON "ApplicationEvent"("applicationId");
CREATE INDEX "ApplicationEvent_scheduledAt_idx" ON "ApplicationEvent"("scheduledAt");
CREATE INDEX "JobAlert_userId_idx" ON "JobAlert"("userId");
CREATE INDEX "JobAlert_isActive_lastRunAt_idx" ON "JobAlert"("isActive", "lastRunAt");

-- Add foreign keys
ALTER TABLE "QuestionAnswer" ADD CONSTRAINT "QuestionAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApplicationEvent" ADD CONSTRAINT "ApplicationEvent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobAlert" ADD CONSTRAINT "JobAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobAlert" ADD CONSTRAINT "JobAlert_savedSearchId_fkey" FOREIGN KEY ("savedSearchId") REFERENCES "SavedSearch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
