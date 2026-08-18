import { PrismaClient } from '@prisma/client';

/**
 * Creates the demo areas. Deliberately includes one of each kind so the "query coarse,
 * filter fine" path is exercised the moment you press Run poll.
 */
const prisma = new PrismaClient();

const AREAS = [
  {
    id: 'area-central-boulder',
    name: 'Central Boulder',
    kind: 'POSTAL_CODES',
    postalCodes: JSON.stringify(['80302', '80304']),
    providerIds: JSON.stringify(['mock']),
    pollCron: '*/15 * * * *',
  },
  {
    id: 'area-boulder-radius',
    name: 'Boulder — 5 mile radius',
    kind: 'CITY_RADIUS',
    city: 'Boulder',
    state: 'CO',
    centerLat: 40.015,
    centerLng: -105.2705,
    radiusMiles: 5,
    providerIds: JSON.stringify(['mock']),
    pollCron: '*/30 * * * *',
  },
  {
    id: 'area-newlands-polygon',
    name: 'Newlands (drawn)',
    kind: 'POLYGON',
    // [lng, lat] pairs, GeoJSON order.
    polygon: JSON.stringify([
      [-105.2950, 40.0250], [-105.2650, 40.0250],
      [-105.2650, 40.0450], [-105.2950, 40.0450],
    ]),
    providerIds: JSON.stringify(['mock']),
    pollCron: '0 * * * *',
  },
];

async function main() {
  for (const area of AREAS) {
    await prisma.area.upsert({ where: { id: area.id }, create: area, update: area });
    console.log(`  area: ${area.name} (${area.kind})`);
  }
  console.log(`\nSeeded ${AREAS.length} areas. Next: npm run poll`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
