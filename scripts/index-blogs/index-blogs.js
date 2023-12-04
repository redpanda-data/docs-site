const puppeteer = require('puppeteer');
const axios = require('axios');
const xml2js = require('xml2js');
const retry = require('async-retry');
const _ = require('lodash');
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
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 80000 });
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
        const categorySelector = '[class^="styles_BlogPostTemplate__headerCategory"]';
        const titleSelector = '[class*="styles_BlogPostTemplate__headerTitle"]';
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
        title: data.h1,
        titles: data.titles,
        intro: data.intro,
        category: data.category,
        image: data.imageUrl,
        date: data.date,
        author: data.author,
        type: 'Blog',
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

  let existingObjectsMap = new Map()

  // Save objects in a local cache to query later.
  // Avoids sending multiple requests.
  // browseObjects does not affect analytics or usage limits.
  // See https://www.algolia.com/doc/api-reference/api-methods/browse/#about-this-method
  try {
    await index.browseObjects({
      query: '',
      tagFilters: 'blogs',
      batch: batch => {
        for (const obj of batch) {
          existingObjectsMap.set(obj.objectID, obj)
        }
      }
    })
  } catch (err) {
    console.error(JSON.stringify(err))
  }

  const objectsToUpdate = []
  const objectsToAdd = []
  for (const obj of validRecords) {
    const existingObject = existingObjectsMap.get(obj.objectID)
    if (existingObject) {
      if (!_.isEqual(existingObject, obj)) {
        objectsToUpdate.push(obj)
      }
    } else {
      objectsToAdd.push(obj)
    }
  }

  const addObjectActions = objectsToAdd.map(object => ({
    action: 'addObject',
    indexName: process.env.ALGOLIA_INDEX_NAME,
    body: object
  }));

  const updateObjectActions = objectsToUpdate.map(object => ({
    action: 'updateObject',
    indexName: process.env.ALGOLIA_INDEX_NAME,
    body: object
  }));

  const batchActions = [...addObjectActions, ...updateObjectActions];

  // Upload new records only if the objects have been updated or they are new.
  // See https://www.algolia.com/doc/api-reference/api-methods/batch/?client=javascript
  await client.multipleBatch(batchActions).then(() => {
    console.log('Batch indexing operations completed successfully');
  }).catch(error => {
    console.error(`Error uploading records to Algolia: ${error.message}`);
  });
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