/**
 * Buckets a raw Expedia room name into the coarse taxonomy master_room stores
 * (e.g. "Deluxe Room, 2 Queen Beds, City View" -> "Deluxe Room"). Heuristic,
 * first-match-wins — refine the keyword list as real room names are observed.
 */
const CATEGORY_KEYWORDS: string[] = [
  'Presidential Suite',
  'Executive Suite',
  'Junior Suite',
  'Suite',
  'Villa',
  'Studio',
  'Penthouse',
  'Deluxe Room',
  'Deluxe',
  'Superior Room',
  'Superior',
  'Premium Room',
  'Premium',
  'Standard Room',
  'Classic Room',
  'Standard',
];

const DEFAULT_CATEGORY = 'Standard Room';

export function resolveRoomCategory(rawRoomName: string): string {
  const haystack = rawRoomName.toLowerCase();
  for (const category of CATEGORY_KEYWORDS) {
    if (haystack.includes(category.toLowerCase())) {
      return category;
    }
  }
  return DEFAULT_CATEGORY;
}
