export const QUEUE_REGION_DISCOVERY = 'region-discovery';
export const QUEUE_CITY_HOTELS = 'city-hotels';
export const QUEUE_HOTEL_DETAIL = 'hotel-detail';

export interface RegionDiscoveryJob {
  countryId: string;
  countryName: string;
  countryIso2: string;
  stateId: string;
  stateName: string;
}

export interface CityHotelsJob {
  countryId: string;
  stateId: string;
  cityId: string;
  cityName: string;
  stateName: string;
  countryName: string;
  /** page/offset to resume from, for paginated hotel-list scraping */
  page?: number;
}

export interface HotelDetailJob {
  countryId: string;
  stateId: string;
  /** Unset for hotels harvested directly from a state-wide sweep (no destinations module) whose locality didn't match any discovered city. */
  cityId?: string;
  expediaHotelId: string;
  detailUrl: string;
}
