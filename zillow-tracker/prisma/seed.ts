import { PrismaClient } from '@prisma/client';

/**
 * Seeds the areas from the real capture in data/snapshots/.
 *
 * `zillow` is the primary provider so a fresh install goes straight at live data on a
 * machine that can reach it. `snapshot` is listed second as the offline fallback: it
 * replays real captured listings and invents nothing, so the app is inspectable even
 * where outbound HTTPS is blocked.
 */
const prisma = new PrismaClient();

const AREAS = [
  {
    id: 'area-central-boulder',
    name: 'Central Boulder (80302)',
    kind: 'POSTAL_CODES',
    postalCodes: JSON.stringify(['80302']),
    providerIds: JSON.stringify(['zillow', 'snapshot']),
    pollCron: '*/15 * * * *',
  },
  {
    id: 'area-north-boulder',
    name: 'North Boulder (80304)',
    kind: 'POSTAL_CODES',
    postalCodes: JSON.stringify(['80304']),
    providerIds: JSON.stringify(['zillow', 'snapshot']),
    pollCron: '*/15 * * * *',
  },
  {
    id: 'area-south-boulder',
    name: 'South/East Boulder (80303, 80305)',
    kind: 'POSTAL_CODES',
    postalCodes: JSON.stringify(['80303', '80305']),
    providerIds: JSON.stringify(['zillow', 'snapshot']),
    pollCron: '*/30 * * * *',
  },
];

async function main() {
  for (const area of AREAS) {
    await prisma.area.upsert({ where: { id: area.id }, create: area, update: area });
    console.log(`  ${area.name}`);
  }
  console.log(`\nSeeded ${AREAS.length} areas.`);
  console.log('Edit the ZIP codes on the Areas page (or here) to match your own neighborhoods.');
  console.log('Next: npm run poll');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
