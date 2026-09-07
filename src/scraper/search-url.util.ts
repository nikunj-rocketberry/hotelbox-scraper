/** Builds an Expedia Hotel-Search URL for a free-text destination (state or city). */
export function buildHotelSearchUrl(baseUrl: string, destination: string, stayNights: number): string {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() + 30); // 30 days out: avoids "sold out"/last-minute edge cases
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + stayNights);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const params = new URLSearchParams({
    destination,
    d1: fmt(startDate),
    startDate: fmt(startDate),
    d2: fmt(endDate),
    endDate: fmt(endDate),
    adults: '2',
    rooms: '1',
    sort: 'RECOMMENDED',
  });

  return `${baseUrl.replace(/\/$/, '')}/Hotel-Search?${params.toString()}`;
}
