const puppeteer = require('puppeteer');
const axios = require('axios');
const xml2js = require('xml2js');
const algoliasearch = require('algoliasearch');
const SITEMAP_URL = 'https://docs.redpanda.com/sitemap-api.xml';

const ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID;
const ALGOLIA_ADMIN_API_KEY = process.env.ALGOLIA_ADMIN_API_KEY;
const ALGOLIA_INDEX_NAME = process.env.ALGOLIA_INDEX_NAME;

if (!ALGOLIA_APP_ID || !ALGOLIA_ADMIN_API_KEY || !ALGOLIA_INDEX_NAME) {
  console.error('Algolia configuration is missing. Set ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY, and ALGOLIA_INDEX_NAME environment variables.');
  process.exit(1);
}

const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY);
const index = client.initIndex(ALGOLIA_INDEX_NAME);

async function fetchSitemapUrls(sitemapUrl) {
  try {
    const response = await axios.get(sitemapUrl);
    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
    const result = await parser.parseStringPromise(response.data);
    const urls = result.urlset.url.map((urlEntry) => urlEntry.loc);
    return urls;
  } catch (error) {
    console.error('Error fetching sitemap:', error);
    throw error;
  }
}

async function indexUrlsInAlgolia(urls) {
  const browser = await puppeteer.launch({headless: "new"});
  const records = await Promise.all(urls.map(async (url) => {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle0' });
      const data = await page.evaluate(() => {
        const title = document.querySelector('title')?.innerText;
        const h1 = document.querySelector('h1')?.innerText;
        const intro = document.querySelector('div[data-role="redoc-description"] > p')?.innerText;
        const metaVersion = document.querySelector('meta[name="latest-version"]');
        const latestVersion = metaVersion.getAttribute('content');
        const titles = Array.from(document.querySelectorAll('h2,h3,h4,h5,h6'))
          .map(element => {
            const anchor = element.querySelector('a');
            const href = anchor ? anchor.getAttribute('href') : null;
            return href ? { t: element.textContent.trim(), h: href } : null;
          })
          .filter(item => item !== null);
        return { title, h1, intro, titles, latestVersion };
      });
      if (!data.h1) {
        console.warn(`No H1 in ${url}...skipping`);
        return null;
      }
      const { pathname } = new URL(url);
      return {
        objectID: pathname,
        product: "Redpanda",
        version: data.latestVersion,
        title: data.h1,
        titles: data.titles,
        intro: data.intro,
        type: 'Doc',
        _tags: ['docs','apis']
      };
    } catch (error) {
      console.error(`Error processing URL ${url}:`, error);
      return null;
    } finally {
      await page.close();
    }
  }));
  await browser.close();

  const validRecords = records.filter(record => record !== null);

  try {
    const { objectIDs } = await index.saveObjects(validRecords);
    console.log(`Successfully indexed URLs in Algolia with object IDs: ${objectIDs.join(', ')}`);
  } catch (error) {
    console.error('Error indexing URLs in Algolia:', error);
    throw error;
  }
}

async function generateAlgoliaIndex(sitemapUrl) {
  console.log('Fetching sitemap and processing URLs...');
  const pageUrls = await fetchSitemapUrls(sitemapUrl);
  await indexUrlsInAlgolia(pageUrls);
  console.log('Algolia indexing completed!');
}

generateAlgoliaIndex(SITEMAP_URL)
  .then(() => console.log('Indexing completed!'))
  .catch(error => console.error('Indexing failed:', error));