/**
 * Deliberately a no-op.
 *
 * This app has no built-in area and no ZIP-code concept — the user chose "city +
 * radius" and "draw on a map", so nothing is seeded. An empty database (zero saved
 * searches, zero listings) is the correct state for a fresh install, and the dashboard
 * is designed to prompt for a first search rather than assume Boulder, or any other
 * place, on the user's behalf.
 *
 * Kept as a script (rather than deleted) so `npm run setup` and any docs that still
 * reference `npm run seed` keep working — it just tells you what to do instead of
 * pretending to have done it.
 */
console.log('Nothing to seed — this app starts empty by design.');
console.log('Open the app and search for a place (or draw an area on the map) to get started.');
