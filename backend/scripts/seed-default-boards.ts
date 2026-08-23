// Backfill script: seed default job boards for ALL existing users who have none.
// Run: cd backend && npx tsx scripts/seed-default-boards.ts
import prisma from '../src/lib/prisma.js';
import { seedDefaultBoardsForUser } from '../src/jobSources/defaultBoards.js';

async function main() {
  const users = await prisma.user.findMany({ select: { id: true } });
  let seeded = 0;
  for (const u of users) {
    const before = await prisma.jobBoard.count({ where: { userId: u.id } });
    if (before === 0) {
      await seedDefaultBoardsForUser(u.id);
      seeded++;
    }
  }
  console.log(`Seeded default boards for ${seeded}/${users.length} users.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
