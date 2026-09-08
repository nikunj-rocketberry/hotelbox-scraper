/**
 * Every selector Expedia scraping touches, in one place, so a markup change
 * only requires editing this file.
 *
 * `hotelList` and `hotelDetail` below were re-verified live against
 * expedia.co.in on 2026-09-08 (via a headed Playwright/MCP session) after the
 * original best-effort guesses turned out to be stale — notably:
 *   - hotel cards link via `data-stid="open-product-information"`, not
 *     `open-hotel-information`; there is no `content-hotel-title` inside a
 *     card, the name is just a plain `<h3>`.
 *   - the hotel-detail page's `content-hotel-title` node is a `<div>`
 *     wrapper (badge + star-class + name), not an `<h1>` — the name text
 *     itself lives in a nested `<h1>`. Star class is only exposed as
 *     visually-hidden text ("Property class: 5 and above") inside that div,
 *     there is no `rating-badge`.
 *   - guest rating / review count are exposed as schema.org microdata
 *     (`<meta itemprop="ratingValue">` / `itemprop="reviewCount"`) inside
 *     `content-hotel-reviewsummary`, not dedicated badge elements.
 *   - there is no `[data-stid="property-description"]` — the About-this-
 *     property paragraph lives under `[data-stid="sp-content-text"]`.
 *   - policy fields (check-in/out, pets, special instructions, ...) have no
 *     per-field selector; each is a generic `[data-stid="content-item"]`
 *     block distinguishable only by its heading text.
 *   - room cards are `[data-stid="property-offer-N"]` inside
 *     `section-room-list` (not `room-card*`), and per-field room selectors
 *     (occupancy/bed-type/amenities) don't exist either — every room fact
 *     (view, size, "Sleeps N", bed type, amenities) is a flat, untagged
 *     `<li>` under one `<ul>`, parsed heuristically in hotel-detail.service.
 *   - Expedia no longer renders a dedicated property-level "Amenities"
 *     section on this page template at all (checked on two different
 *     properties) — `ExpediaSelectors.hotelDetail.amenitiesHeading` is kept
 *     as a best-effort text-anchored lookup for properties that still have
 *     one; expect it to often come back empty, and don't backfill it from
 *     room-level perks (those are room extras/promos, not property
 *     amenities, and would misrepresent the data).
 *   - pagination is gone from the hotel list — instead of a "next page"
 *     link, a "Show more stays" button appends more cards to the same page
 *     (infinite-scroll style), so `hotelList.showMoreButton` must be
 *     clicked-and-waited-for-growth rather than clicked-and-navigated.
 *
 * `search` (region/city discovery) was NOT confirmed live: Expedia's
 * "Destinations in <State>" recommendation module used by Strategy 1 no
 * longer appears on a state-level search at all (checked Karnataka) — the
 * state search just returns a normal hotel list for the whole state. The
 * sidebar's "Popular locations" filter (Strategy 2 in region-discovery.
 * service.ts) does still exist, but only surfaces landmarks/neighbourhoods
 * ("M.G. Road", "Bandipur National Park"), not city names, so it was
 * removed rather than "fixed" — matching those selectors would have
 * silently written landmarks into master_city. Keep an eye on this: city
 * discovery for a new state currently depends entirely on the curated
 * `STATE_FALLBACK_CITIES` map in region-discovery.service.ts.
 *
 * Expect to revisit this file again — Expedia changes markup periodically
 * and has active anti-bot measures (rate limiting, potential CAPTCHA
 * challenges). Re-run `npm run playwright:inspect -- "<url>"` (or a
 * Playwright MCP session) before trusting a real run against fresh drift.
 */
export const ExpediaSelectors = {
  search: {
    // "Destinations in <State>" section — last seen present on some states'
    // search pages, absent on others (see file header). Cheap to attempt,
    // safe to fail: region-discovery.service.ts falls back to curated data
    // when this finds nothing.
    destinationsSection:
      '[data-stid="destination-recommendations"], section:has-text("Destinations in"), div:has(> h2:has-text("Destinations in")), div:has(> h3:has-text("Destinations in"))',
    destinationCategoryTabs: '[role="tab"], button[data-stid*="tab"]',
    destinationCityCard: 'a[href*="/Hotel-Search"], a[href*="destinations"], a[data-stid*="destination"], a:has(h3), a:has(h4)',
    destinationCityName: '[data-stid*="destination-name"], h3, h4, [class*="title"], [class*="name"]',
  },
  hotelList: {
    resultCard: '[data-stid="property-listing-results"] [data-stid="lodging-card-responsive"]',
    resultLink: 'a[data-stid="open-product-information"]',
    // No data-stid on the title; it's a plain <h3> (a second, visually-hidden
    // "Photo gallery for <name>" <h3> also exists in the same card — filter
    // it out by text in code rather than by class, see city-hotels.service.ts).
    resultHeading: 'h3',
    // Infinite-scroll "load more" button, replaces the old page-1/page-2 pagination.
    showMoreButton: 'button[aria-label^="Show more"]',
    noResults: '[data-stid="no-results"]',
  },
  hotelDetail: {
    titleBlock: '[data-stid="content-hotel-title"]',
    name: '[data-stid="content-hotel-title"] h1',
    reviewSummary: '[data-stid="content-hotel-reviewsummary"]',
    guestRatingMeta: '[data-stid="content-hotel-reviewsummary"] meta[itemprop="ratingValue"]',
    reviewCountMeta: '[data-stid="content-hotel-reviewsummary"] meta[itemprop="reviewCount"]',
    address: '[data-stid="content-hotel-address"]',
    phone: 'a[href^="tel:"]',
    description: '[data-stid="sp-content-text"]',
    // Best-effort only — see file header, this section is frequently absent.
    amenitiesHeadingPattern: 'amenit|what this (place|property) offers',
    galleryOpenButton: 'button[aria-label^="Show all"]',
    galleryImage: '[role="dialog"] img',
    // Every policy fact (check-in, check-out, pets, special instructions, ...)
    // is one of these, distinguished only by its own heading text — matched
    // in code via policyText(), not by a per-field selector.
    policyItem: '[data-stid="content-item"]',
  },
  rooms: {
    roomCard: '[data-stid="section-room-list"] [data-stid^="property-offer-"]',
    // Room facts (view, size, occupancy, bed type, amenities) are all flat
    // <li> items under one <ul>, categorized heuristically in
    // hotel-detail.service.ts — there is no per-field selector for them.
  },
} as const;
