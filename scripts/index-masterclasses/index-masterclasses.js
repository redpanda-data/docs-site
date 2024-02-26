const { GraphQLClient, gql } = require('graphql-request');
const algoliasearch = require('algoliasearch');
const yaml = require('js-yaml');

const INVITE_LINK_BASE = 'https://play.instruqt.com/redpanda/invite/'
const VALID_CATEGORIES_URL = 'https://raw.githubusercontent.com/redpanda-data/docs/shared/modules/ROOT/partials/valid-categories.yml'
const ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID;
const ALGOLIA_ADMIN_API_KEY = process.env.ALGOLIA_ADMIN_API_KEY;
const ALGOLIA_INDEX_NAME = process.env.ALGOLIA_INDEX_NAME;
const INSTRUQT_API_KEY = process.env.INSTRUQT_API_KEY;

if (!ALGOLIA_APP_ID || !ALGOLIA_ADMIN_API_KEY || !ALGOLIA_INDEX_NAME) {
  console.error('Algolia configuration is missing. Set ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY, and ALGOLIA_INDEX_NAME environment variables.');
  process.exit(1);
}

const algoliaClient = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY);
const index = algoliaClient.initIndex(ALGOLIA_INDEX_NAME);

// Create some mappings between tags used in masterclasses and valid deployment types
const deploymentTypes = {
  Kubernetes: ['kubernetes', 'k8s'],
  Docker: ['docker'],
  Linux: ['linux', 'unix'],
  'Redpanda Cloud': ['redpanda cloud', 'cloud', 'serverless']
};

const unixTimestamp = Math.floor(Date.now() / 1000)

const GET_TRACKS_QUERY = gql`
  query {
    tracks(organizationSlug: "redpanda") {
      id
      slug
      title
      permalink
      icon
      challenges {
        title
        permalink
        type
      }
      trackTags {
        value
      }
      teaser
    }
  }
`;

const CREATE_INVITE_MUTATION = gql`
  mutation CreateInvite($trackId: String!) {
    createTrackInvite(invite: {publicTitle: "Invite from Redpanda docs", title: "Invite from Redpanda docs", trackIDs: [$trackId], allowAnonymous: true}) {
      id
      title
    }
  }
`;

const client = new GraphQLClient('https://play.instruqt.com/graphql', {
  headers: {
    authorization: `Bearer ${INSTRUQT_API_KEY}`,
  },
});

async function fetchTracks() {
  try {
    const data = await client.request(GET_TRACKS_QUERY);
    return data.tracks;
  } catch (error) {
    console.error('Error fetching tracks:', error);
    return [];
  }
}

async function fetchValidCategories() {
  const fetch = (await import('node-fetch')).default;
  const url = VALID_CATEGORIES_URL;
  try {
    const response = await fetch(url);
    const text = await response.text();
    const data = yaml.load(text);
    return data['page-valid-categories'];
  } catch (error) {
    console.error('Error fetching valid categories:', error);
    return [];
  }
}

function determineDeploymentType(track, deploymentTypes) {
  let deploymentType = '';

  for (const tag of track.trackTags) {
    for (const [type, keywords] of Object.entries(deploymentTypes)) {
      if (keywords.includes(tag.value.toLowerCase())) {
        deploymentType = type;
        break;
      }
    }
  }

  if (!deploymentType) {
    const contentToCheck = `${track.title.toLowerCase()} ${track.teaser.toLowerCase()}`;
    for (const [type, keywords] of Object.entries(deploymentTypes)) {
      if (keywords.some(keyword => contentToCheck.includes(keyword))) {
        deploymentType = type;
        break;
      }
    }
  }

  return deploymentType;
}

async function createInvitesForTracks(tracks, existingTrackIds) {
  return Promise.all(tracks.map(async (track) => {
    // Skip if the track is already in Algolia
    if (existingTrackIds.has(track.id)) {
      return null;
    }
    const inviteData = await client.request(CREATE_INVITE_MUTATION, { trackId: track.id });
    return {
      ...track,
      objectID: INVITE_LINK_BASE + inviteData.createTrackInvite.id
    };
  })).then(results => results.filter(track => track));
}

function formatForAlgolia(tracks, validCategoriesData) {
  return tracks.map(track => {
    let adjustedTrackTags = new Set();

    track.trackTags.forEach(tag => {
      const tagValue = tag.value.toLowerCase();
      validCategoriesData.forEach(categoryInfo => {
        const categoryLower = categoryInfo.category.toLowerCase();

        // Check if tag matches a main category or any related terms of a category
        if (categoryLower === tagValue || (categoryInfo.related && categoryInfo.related.map(r => r.toLowerCase()).includes(tagValue))) {
          adjustedTrackTags.add(categoryInfo.category);
        }

        // Check if tag matches any subcategories or related terms of subcategories
        if (categoryInfo.subcategories) {
          categoryInfo.subcategories.forEach(subcat => {
            const subcatLower = subcat.category.toLowerCase();
            if (subcatLower === tagValue || (subcat.related && subcat.related.map(r => r.toLowerCase()).includes(tagValue))) {
              adjustedTrackTags.add(categoryInfo.category);
              adjustedTrackTags.add(subcat.category);
            }
          });
        }
      });
    });

    // Check for valid categories in title and teaser
    const titleLower = track.title.toLowerCase();
    const teaserLower = track.teaser.toLowerCase();

    validCategoriesData.forEach(categoryInfo => {
      const categoryLower = categoryInfo.category.toLowerCase();
      if (titleLower.includes(categoryLower) || teaserLower.includes(categoryLower)) {
        adjustedTrackTags.add(categoryInfo.category);
      }
    });

    const deploymentType = determineDeploymentType(track, deploymentTypes);

    return {
      objectID: track.objectID,
      title: track.title,
      id: track.id,
      image: track.icon,
      intro: track.teaser,
      slug: track.slug,
      deployment: deploymentType,
      titles: track.challenges.map(ch => ({ t: ch.title })),
      interactive: true,
      unixTimestamp: unixTimestamp,
      type: 'Lab',
      _tags: ['labs'],
      categories: [...adjustedTrackTags]
    };
  });
}

async function uploadToAlgolia(records) {
  if (records.length === 0) {
    console.log('No new Instruqt tracks to upload to Algolia');return;
  }
  try {
    await index.saveObjects(records);
    console.log('Instruqt tracks uploaded to Algolia');
  } catch (error) {
    console.error('Error uploading Instruqt tracks to Algolia:', error);
  }
}

async function fetchExistingRecordsFromAlgolia(index) {
  const existingTrackIds = new Set();
  try {
    await index.browseObjects({
      query: '', // Empty query fetches all records
      tagFilters: 'labs',
      batch: (batch) => {
        batch.forEach(hit => {
          existingTrackIds.add(hit.id);
        });
      },
    });
    return existingTrackIds;
  } catch (error) {
    console.error('Error fetching existing records from Algolia:', error);
    return new Set();
  }
}

async function main() {
  const tracks = await fetchTracks();
  const validCategories = await fetchValidCategories();
  const existingTrackIds = await fetchExistingRecordsFromAlgolia(index);
  const tracksWithInvites = await createInvitesForTracks(tracks, existingTrackIds);
  const algoliaRecords = formatForAlgolia(tracksWithInvites.filter(track => track), validCategories);
  await uploadToAlgolia(algoliaRecords);
}

main();
