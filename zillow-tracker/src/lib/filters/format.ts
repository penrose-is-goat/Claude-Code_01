/** Shared by both server components and the Excel exporter, so keep it dependency-free. */
export function humanize(s: string | null | undefined): string {
  if (!s) return '—';
  return s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function usd(n: number | null | undefined): string {
  if (n == null) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
