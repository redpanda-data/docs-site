const puppeteer = require('puppeteer');
const algoliasearch = require('algoliasearch');

const BASE_URL = 'https://docs.redpanda.com';
const DOC_PATHS = [
  '/api/doc/admin/',
  '/api/doc/http-proxy/',
  '/api/doc/schema-registry/',
  '/api/doc/cloud-controlplane/',
  '/api/doc/cloud-dataplane/',
];

const ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID;
const ALGOLIA_ADMIN_API_KEY = process.env.ALGOLIA_ADMIN_API_KEY;
const ALGOLIA_INDEX_NAME = process.env.ALGOLIA_INDEX_NAME;

if (!ALGOLIA_APP_ID || !ALGOLIA_ADMIN_API_KEY || !ALGOLIA_INDEX_NAME) {
  console.error('Algolia configuration is missing. Set ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY, and ALGOLIA_INDEX_NAME environment variables.');
  process.exit(1);
}

const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY);
const index = client.initIndex(ALGOLIA_INDEX_NAME);

async function scrapeAndIndex() {
  const browser = await puppeteer.launch({ headless: 'new' });
  const allRecords = [];

  for (const path of DOC_PATHS) {
    const url = `${BASE_URL}${path}`;
    const page = await browser.newPage();
    try {
      console.log(`Visiting: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const records = await page.evaluate(() => {
        const basePath = window.location.pathname;
        const latestVersion = document.querySelector('meta[name="latest-redpanda-version"]')?.getAttribute('content');

        return Array.from(document.querySelectorAll('turbo-frame[id^="operation-"]')).map(frame => {
          const titleEl = frame.querySelector('h2.operation-title');
          const descEl = frame.querySelector('.markdown-content p');
          const verbEl = frame.querySelector('.operation-verb');
          const pathEl = frame.querySelector('.operation-path');
          const anchor = titleEl?.querySelector('a')?.getAttribute('href');

          const method = verbEl?.textContent?.trim();
          const path = pathEl?.textContent?.trim();
          const title = titleEl?.textContent?.trim();
          const description = descEl?.textContent?.trim();

          if (!method || !path) return null;

          return {
            objectID: `${basePath}${anchor || ''}`,
            product: 'Self-Managed',
            version: latestVersion,
            type: 'Endpoint',
            method,
            path,
            title,
            description,
            url: `${location.origin}${anchor || ''}`,
            _tags: [`Self-Managed v${latestVersion}`],
          };
        }).filter(Boolean);
      });

      allRecords.push(...records);
    } catch (err) {
      console.error(`Error scraping ${url}:`, err);
    } finally {
      await page.close();
    }
  }

  await browser.close();

  if (allRecords.length === 0) {
    console.warn('No records to index.');
    return;
  }

  try {
    const { objectIDs } = await index.saveObjects(allRecords);
    console.log(`✅ Indexed ${objectIDs.length} endpoint records to Algolia.`);
  } catch (err) {
    console.error('❌ Error saving to Algolia:', err);
  }
}

scrapeAndIndex().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
