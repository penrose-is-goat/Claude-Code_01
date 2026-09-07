import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();
  const evts = await p.listingEvent.groupBy({ by: ['type'], _count: true });
  console.log('EVENTS BY TYPE:');
  for (const e of evts.sort((a, b) => (b._count as number) - (a._count as number))) {
    console.log('  ' + e.type.padEnd(24) + e._count);
  }
  console.log('\nlistings:', await p.listing.count(),
    '| open houses:', await p.openHouse.count(),
    '| snapshots:', await p.listingSnapshot.count(),
    '| runs:', await p.pollRun.count());

  const drops = await p.listingEvent.findMany({
    where: { type: 'PRICE_CHANGE', deltaAbs: { lt: 0 } }, include: { listing: true }, take: 4,
  });
  console.log('\nSAMPLE PRICE DROPS:');
  for (const d of drops) console.log('  ' + d.listing.addressLine1.padEnd(24) + d.message);

  const oh = await p.openHouse.findMany({
    where: { cancelledAt: null }, include: { listing: true }, orderBy: { startsAt: 'asc' }, take: 5,
  });
  console.log('\nUPCOMING OPEN HOUSES:');
  for (const o of oh) {
    console.log('  ' + o.startsAt.toISOString().slice(0, 16).replace('T', ' ') + '  ' + o.listing.addressLine1);
  }

  const back = await p.listingEvent.findMany({ where: { type: 'BACK_ON_MARKET' }, include: { listing: true } });
  console.log('\nBACK ON MARKET:');
  for (const b of back) console.log('  ' + b.listing.addressLine1.padEnd(24) + b.message);

  await p.$disconnect();
}
main();
