/**
 * Interactive selector-finding tool. Opens a HEADED browser + the Playwright
 * Inspector against a real Expedia page so you can click elements and see
 * their actual selectors, then copy the right ones into
 * src/scraper/expedia-selectors.ts.
 *
 * Usage:
 *   npm run playwright:inspect -- "https://www.expedia.co.in/Hotel-Search?destination=Rajasthan%2C%20India"
 *
 * Note: run this sparingly and manually (never in a loop/CI) — Expedia rate
 * limits aggressively; this project's very first automated fetch attempt
 * during development got HTTP 429.
 */
import { chromium } from 'playwright';

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: npm run playwright:inspect -- "<expedia-url>"');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  console.log('Browser open. Use the Playwright Inspector / devtools element picker to find real selectors.');
  console.log('Close the browser window when done.');
  await page.pause();

  await browser.close();
}

main();
