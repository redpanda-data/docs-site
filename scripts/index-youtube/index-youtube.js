const axios = require('axios');
const algoliasearch = require('algoliasearch');

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
      return videos
        .filter(video => video.id && video.id.videoId)
        .map(video => ({
          objectID: `https://www.youtube.com/watch?v=${video.id.videoId}`,
          title: video.snippet.title,
          intro: video.snippet.description,
          publishedAt: video.snippet.publishedAt,
          image: video.snippet.thumbnails.high.url,
          type: 'Video',
          _tags: ['videos']
      }));
    } catch (error) {
        console.error('Error fetching YouTube videos:', error);
        return [];
    }
}

fetchYouTubeVideos().then(async (videos) => {
  try {
    const { objectIDs } = await index.saveObjects(videos);
    console.log(`Successfully indexed YouTube videos in Algolia with object IDs: ${objectIDs.join(', ')}`);
  } catch (error) {
    console.error('Error indexing URLs in Algolia:', error);
  }
}).catch(error => {
  console.error('Unhandled error:', error);
});

