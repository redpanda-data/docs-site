const puppeteer = require('puppeteer');
const axios = require('axios');
const xml2js = require('xml2js');
const retry = require('async-retry');
const algoliasearch = require('algoliasearch');
const BASE_URL = 'https://redpanda.com';
const SITEMAP_URL = 'https://redpanda.com/sitemap.xml';

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
    if (!url.includes('/blog/')) return null
    const page = await browser.newPage();
    try {
      await retry(async () => {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 80000 }); // Increased timeout
      }, {
        retries: 3,
        factor: 2,
        minTimeout: 1000,
        onRetry: (error, attempt) => console.log(`Retry attempt ${attempt} for ${url} due to ${error.message}`)
      });
      const data = await page.evaluate(() => {
        const titles = Array.from(document.querySelectorAll('h2,h3'))
          .map(element => {
            const anchor = element.id;
            return { t: element.textContent.trim(), h: anchor }
          })
        const categorySelector = '[class^="styles_BlogPostTemplate__headerCategory"]'; // Example for 'starts with'
        const titleSelector = '[class*="styles_BlogPostTemplate__headerTitle"]'; // Example for 'contains'
        const descriptionSelector = '[class*="styles_BlogPostTemplate__headerDescription"]';
        const authorSelector = '[class*="styles_BlogPostTemplate__headerAuthor"]';
        const dateSelector = '[class*="styles_BlogPostTemplate__headerAuthorsAndDate"] span:last-child';
        const imageSelector = '[class*="styles_BlogPostTemplate__headerImageWrapper"] img';

        const category = document.querySelector(categorySelector)?.innerText;
        const h1 = document.querySelector(titleSelector)?.innerText;
        const intro = document.querySelector(descriptionSelector)?.innerText;
        const author = document.querySelector(authorSelector)?.innerText;
        const date = document.querySelector(dateSelector)?.innerText;
        const imageUrl = document.querySelector(imageSelector)?.src;

        return {
          category,
          h1,
          intro,
          author,
          titles,
          date,
          imageUrl,
        };
      });
      if (!data.h1) {
        console.warn(`No H1 in ${url}...skipping`);
        return null;
      }
      const { pathname } = new URL(url);
      return {
        objectID: `${BASE_URL}${pathname}`,
        product: "Redpanda",
        title: data.h1,
        titles: data.titles,
        intro: data.intro,
        category: data.category,
        image: data.imageUrl,
        date: data.date,
        author: data.author,
        type: 'blog',
        _tags: ['blogs']
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
    const existingRecords = {};
    await index.browseObjects({
      query: '',
      filters: '_tags:blogs',
      batch: batch => {
        batch.forEach(record => {
          existingRecords[record.objectID] = record;
        });
      }
    });
    // Determine which blogs to delete
    const existingObjectIDs = Object.keys(existingRecords);
    const newObjectIDs = validRecords.map(blog => blog.objectID);
    const blogsToDelete = existingObjectIDs.filter(id => !newObjectIDs.includes(id));

    // Delete old blogs
    if (blogsToDelete.length > 0) {
      await index.deleteObjects(blogsToDelete);
    }
    const { objectIDs } = await index.saveObjects(validRecords);
    console.log(`Successfully indexed blogs in Algolia with object IDs: ${objectIDs.join(', ')}`);
  } catch (error) {
    console.error('Error indexing blog URLs in Algolia:', error);
    throw error;
  }
}

async function generateAlgoliaIndex(sitemapUrl) {
  console.log('Fetching Redpanda sitemap and processing blog URLs...');
  const pageUrls = await fetchSitemapUrls(sitemapUrl);
  await indexUrlsInAlgolia(pageUrls);
  console.log('Algolia indexing completed!');
}

generateAlgoliaIndex(SITEMAP_URL)
  .then(() => console.log('Blog indexing completed!'))
  .catch(error => console.error('Blog indexing failed:', error));