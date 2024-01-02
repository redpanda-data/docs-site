const axios = require('axios');
const algoliasearch = require('algoliasearch');
const _ = require('lodash');

const ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID;
const ALGOLIA_ADMIN_API_KEY = process.env.ALGOLIA_ADMIN_API_KEY;
const ALGOLIA_INDEX_NAME = process.env.ALGOLIA_INDEX_NAME;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const CHANNEL_ID = 'UCMrqRNX9Og3wFjuI-qMbKHw';
const API_URL = `https://www.googleapis.com/youtube/v3/search?key=${YOUTUBE_API_KEY}&channelId=${CHANNEL_ID}&part=snippet,id&order=date&maxResults=100`;

if (!ALGOLIA_APP_ID || !ALGOLIA_ADMIN_API_KEY || !ALGOLIA_INDEX_NAME) {
  console.error('Algolia configuration is missing. Set ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY, and ALGOLIA_INDEX_NAME environment variables.');
  process.exit(1);
}

const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY);
const index = client.initIndex(ALGOLIA_INDEX_NAME);

async function fetchYouTubeVideos() {
    try {
      const response = await axios.get(API_URL);
      const videos = response.data.items;
      // To sort by date, Algolia requires Unix timestamps
      const unixTimestamp = convertToUnixTimestamp(video.snippet.publishedAt);
      return videos
        .filter(video => video.id && video.id.videoId)
        .map(video => ({
          objectID: `https://www.youtube.com/watch?v=${video.id.videoId}`,
          title: video.snippet.title,
          intro: video.snippet.description,
          date: video.snippet.publishedAt,
          unixTimestamp: unixTimestamp,
          image: video.snippet.thumbnails.high.url,
          type: 'Video',
          _tags: ['videos']
      }));
    } catch (error) {
        console.error('Error fetching YouTube videos:', error);
        return [];
    }
}

function convertToUnixTimestamp(dateString) {
  try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) {
        console.log(`Invalid date in blog: ${dateString}`);
        return '';
      }
      return Math.floor(date.getTime() / 1000);
  } catch (error) {
      console.error(error.message);
      return '';
  }
}

fetchYouTubeVideos().then(async (videos) => {
  let existingObjectsMap = new Map()

  // Save objects in a local cache to query later.
  // Avoids sending multiple requests.
  // browseObjects does not affect analytics or usage limits.
  // See https://www.algolia.com/doc/api-reference/api-methods/browse/#about-this-method
  try {
    await index.browseObjects({
      query: '',
      tagFilters: 'videos',
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
  for (const obj of videos) {
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
}).catch(error => {
  console.error('Unhandled error:', error);
});

