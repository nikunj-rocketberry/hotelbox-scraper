/**
 * Every selector Expedia scraping touches, in one place, so a markup change
 * only requires editing this file.
 *
 * IMPORTANT — these are best-effort starting points based on Expedia's
 * long-standing use of `data-stid` test-id attributes, NOT verified against
 * a live fetch (Expedia returned HTTP 429 on the very first request made
 * while building this — see README "Verifying selectors"). Before running
 * this against real traffic:
 *   1. `npm run playwright:inspect -- "<url>"` to open a headed browser +
 *      Playwright Inspector against a real search/hotel page.
 *   2. Use the inspector's element picker to confirm/replace each selector
 *      below against what's actually on the page that day.
 * Expect to revisit this file — Expedia changes markup periodically and has
 * active anti-bot measures (rate limiting, potential CAPTCHA challenges).
 */
export const ExpediaSelectors = {
  search: {
    // "Destinations in <State>" section on a region-level search results page
    destinationsSection:
      '[data-stid="destination-recommendations"], section:has-text("Destinations in"), div:has(> h2:has-text("Destinations in")), div:has(> h3:has-text("Destinations in"))',
    destinationCategoryTabs: '[role="tab"], button[data-stid*="tab"]',
    destinationCityCard: 'a[href*="/Hotel-Search"], a[href*="destinations"], a[data-stid*="destination"], a:has(h3), a:has(h4)',
    destinationCityName: '[data-stid*="destination-name"], h3, h4, [class*="title"], [class*="name"]',
  },
  hotelList: {
    resultCard: '[data-stid="property-listing-results"] [data-stid="lodging-card-responsive"]',
    resultLink: 'a[data-stid="open-hotel-information"]',
    resultName: '[data-stid="content-hotel-title"]',
    nextPageButton: '[data-stid="pagination-next"]:not([disabled])',
    noResults: '[data-stid="no-results"]',
  },
  hotelDetail: {
    name: 'h1[data-stid="content-hotel-title"]',
    starRating: '[data-stid="rating-badge"]',
    guestRating: '[data-stid="property-review-score-badge"]',
    reviewCount: '[data-stid="property-review-count-badge"]',
    address: '[data-stid="content-hotel-address"]',
    phone: 'a[href^="tel:"]',
    description: '[data-stid="property-description"]',
    amenitiesList: '[data-stid="amenities-list"] li, [data-stid="property-amenities"] li',
    seeAllPhotosButton: 'button[data-stid="open-gallery"], button:has-text("See all photos")',
    galleryImage: '[data-stid="gallery"] img, [role="dialog"] img',
    checkInTime: '[data-stid="policies-checkin-time"]',
    checkOutTime: '[data-stid="policies-checkout-time"]',
    petPolicy: '[data-stid="policies-pets"]',
  },
  rooms: {
    // Room cards on the property detail page (Expedia often renders these
    // under a "Room Options"/"Choose your room" section further down the page)
    roomCard: '[data-stid="section-room-list"] [data-stid^="room-card"]',
    roomName: '[data-stid="room-name"]',
    roomDescription: '[data-stid="room-description"]',
    roomOccupancy: '[data-stid="room-occupancy"]',
    roomBedType: '[data-stid="room-bed-type"]',
    roomAmenities: '[data-stid="room-amenities"] li',
    roomImage: '[data-stid="room-gallery"] img',
    roomImageOpenButton: 'button[data-stid="room-media-trigger"]',
  },
} as const;
