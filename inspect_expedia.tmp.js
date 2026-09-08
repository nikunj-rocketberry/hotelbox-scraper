const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  }).catch(async () => chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] }));

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });

  const page = await context.newPage();

  console.log('Warming up on homepage...');
  const homeRes = await page.goto('https://www.expedia.co.in', { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log('Homepage status:', homeRes.status());
  await page.waitForTimeout(4000);

  const startDate = new Date(); startDate.setDate(startDate.getDate() + 30);
  const endDate = new Date(startDate); endDate.setDate(endDate.getDate() + 2);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    destination: 'Bengaluru, Karnataka, India',
    d1: fmt(startDate), startDate: fmt(startDate),
    d2: fmt(endDate), endDate: fmt(endDate),
    adults: '2', rooms: '1', sort: 'RECOMMENDED',
  });
  const url = `https://www.expedia.co.in/Hotel-Search?${params.toString()}`;
  console.log('Navigating to:', url);
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000, referer: 'https://www.expedia.co.in' });
  console.log('Search page status:', res.status());
  await page.waitForTimeout(5000);

  console.log('Title:', await page.title());
  const html = await page.content();
  require('fs').writeFileSync('C:/Users/HP/AppData/Local/Temp/claude/c--Users-HP-Desktop-hotelbox/e60d51d4-566b-4daa-a77f-8eaf3cc679fe/scratchpad/expedia_search.html', html);
  console.log('Saved HTML, length:', html.length);

  await browser.close();
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
