BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  canonical_id text;
BEGIN
  SELECT id INTO canonical_id FROM "User" ORDER BY "createdAt", id LIMIT 1;
  IF canonical_id IS NULL THEN
    INSERT INTO "User" (id, email, "createdAt", "updatedAt", name)
    VALUES (gen_random_uuid()::text, 'local@clearance.invalid', NOW(), NOW(), 'Clearance User')
    RETURNING id INTO canonical_id;
  END IF;

  UPDATE "UploadedFile" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "Resume" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "ATSReport" SET "userId" = canonical_id WHERE "userId" IS NOT NULL AND "userId" <> canonical_id;
  UPDATE "JobMatch" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  DELETE FROM "CareerProfile" WHERE "userId" <> canonical_id;
  UPDATE "JobBoard" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "SavedSearch" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "AIProviderKey" SET "userId" = canonical_id WHERE "userId" IS NOT NULL AND "userId" <> canonical_id;
  UPDATE "JobEvaluation" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "TailoredResume" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "Application" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "QuestionAnswer" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "JobAlert" SET "userId" = canonical_id WHERE "userId" <> canonical_id;

  DELETE FROM "User" WHERE id <> canonical_id;
END $$;

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "User" DROP COLUMN "passwordHash";
ALTER TABLE "User" DROP COLUMN "googleId";
ALTER TABLE "User" DROP COLUMN "emailVerified";
ALTER TABLE "User" DROP COLUMN "emailVerifyToken";
ALTER TABLE "User" DROP COLUMN "emailVerifyExpires";
ALTER TABLE "User" DROP COLUMN "passwordResetToken";
ALTER TABLE "User" DROP COLUMN "passwordResetExpires";

COMMIT;
