export interface ScrapedMedia {
  url: string;
  category?: string;
  caption?: string;
  width?: number;
  height?: number;
}

export interface ScrapedRoom {
  name: string;
  description?: string;
  maxOccupancy?: number;
  maxAdults?: number;
  maxChildren?: number;
  numBedrooms?: number;
  numBathrooms?: number;
  bedType?: string;
  bedCount?: number;
  areaSqm?: number;
  areaSqft?: number;
  viewType?: string;
  smokingAllowed?: boolean;
  amenities: string[];
  media: ScrapedMedia[];
}

export interface ScrapedHotel {
  expediaHotelId: string;
  sourceUrl: string;
  name: string;
  propertyType?: string;
  starRating?: number;
  guestRating?: number;
  reviewCount?: number;
  addressLine1?: string;
  addressLine2?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  phone?: string;
  website?: string;
  currencyCode?: string;
  headline?: string;
  shortDescription?: string;
  fullDescription?: string;
  checkInTime?: string;
  checkOutTime?: string;
  checkInInstructions?: string;
  petPolicy?: string;
  childrenPolicy?: string;
  optionalFees?: string;
  knowBeforeYouGo?: string;
  spokenLanguages?: string[];
  accessibilityNotes?: string;
  accessibilityFeatures?: string[];
  amenities: string[];
  media: ScrapedMedia[];
  rooms: ScrapedRoom[];
}

export interface GeoContext {
  countryId: string;
  stateId?: string;
  cityId?: string;
}

export interface ScrapedCity {
  name: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
}
