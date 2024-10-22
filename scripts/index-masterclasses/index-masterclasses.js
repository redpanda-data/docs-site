const { GraphQLClient, gql } = require('graphql-request');
const algoliasearch = require('algoliasearch');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const _ = require('lodash');

async function main() {
  const INVITE_LINK_BASE = 'https://play.instruqt.com/redpanda/invite/';
  const VALID_CATEGORIES_URL = 'modules/ROOT/partials/valid-categories.yml';
  const GRAPHQL_API_URL = 'https://play.instruqt.com/graphql'
  const GITHUB_OWNER = 'redpanda-data';
  const ATTACHMENTS_PATH = '../../home/modules/ROOT/attachments'
  const INSTRUQT_LABS_JSON_FILE = 'instruqt-labs.json'
  const ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID;
  const ALGOLIA_ADMIN_API_KEY = process.env.ALGOLIA_ADMIN_API_KEY;
  const ALGOLIA_INDEX_NAME = process.env.ALGOLIA_INDEX_NAME;
  const INSTRUQT_API_KEY = process.env.INSTRUQT_API_KEY;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  if (!ALGOLIA_APP_ID || !ALGOLIA_ADMIN_API_KEY || !ALGOLIA_INDEX_NAME) {
    console.error('Algolia configuration is missing. Set ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY, and ALGOLIA_INDEX_NAME environment variables.');
    process.exit(1);
  }

  async function loadOctokit() {
    const { Octokit } = await import('@octokit/rest');
    return new Octokit({
      auth: GITHUB_TOKEN,
    });
  }

  const octokit = await loadOctokit();

  const algoliaClient = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY);
  const index = algoliaClient.initIndex(ALGOLIA_INDEX_NAME);

  const deploymentTypes = {
    Kubernetes: ['kubernetes', 'k8s'],
    Docker: ['docker'],
    Linux: ['linux', 'unix'],
    'Redpanda Cloud': ['redpanda cloud', 'cloud', 'serverless']
  };

  const unixTimestamp = Math.floor(Date.now() / 1000);

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
      createTrackInvite(invite: {publicTitle: "Invite from Redpanda docs", title: "Invite from Redpanda docs", trackIDs: [$trackId], allowAnonymous: false, playLimit: 5}) {
        id
        title
      }
    }
  `;

  const client = new GraphQLClient(GRAPHQL_API_URL, {
    headers: {
      authorization: `Bearer ${INSTRUQT_API_KEY}`,
    },
  });

  async function fetchTracks() {
    try {
      const data = await client.request(GET_TRACKS_QUERY);
      const filteredTracks = data.tracks.filter(track => !track.private && !track.maintenance);
      return filteredTracks;
    } catch (error) {
      console.error('Error fetching tracks:', error);
      return [];
    }
  }

  async function getTrackIdsFromRepo() {
    const trackIds = new Set();
    try {
      const { data: repoContents } = await octokit.repos.getContent({
        owner: GITHUB_OWNER,
        repo: 'instruqt-course',
        path: '',
      });

      for (const item of repoContents) {
        if (item.type === 'dir') {
          const { data: trackYml } = await octokit.repos.getContent({
            owner: GITHUB_OWNER,
            repo: 'instruqt-course',
            path: `${item.path}/track.yml`,
          });

          const trackContent = Buffer.from(trackYml.content, 'base64').toString('utf8');
          const trackData = yaml.load(trackContent);

          if (trackData && trackData.id) {
            trackIds.add(trackData.id);
          }
        }
      }
    } catch (error) {
      console.error('Error fetching track IDs from GitHub:', error);
    }
    return trackIds;
  }

  async function filterTracksByRepo(tracks, validTrackIds) {
    return tracks.filter(track => validTrackIds.has(track.id));
  }

  async function fetchValidCategories() {
    try {
      const { data: fileContent } = await octokit.rest.repos.getContent({
        owner: GITHUB_OWNER,
        repo: 'docs',
        path: VALID_CATEGORIES_URL,
        ref: 'shared',
      });
      const content = Buffer.from(fileContent.content, 'base64').toString('utf8');
      const data = yaml.load(content);
      return data['page-valid-categories'];
    } catch (error) {
      console.error('Error fetching valid categories from GitHub:', error);
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

  async function createInvitesForTracks(tracks, existingTracks, existingObjectsMap) {
    return Promise.all(tracks.map(async (track) => {
      if (existingTracks.has(track.id)) {
        const existingObject = existingObjectsMap.get(track.id);
        return {
          objectID: existingObject.objectID,
          ...track
        };
      } else {
        // Create a new invite and return the track with the new objectID
        const inviteData = await client.request(CREATE_INVITE_MUTATION, { trackId: track.id });
        return {
          ...track,
          objectID: INVITE_LINK_BASE + inviteData.createTrackInvite.id
        };
      }
    })).then(results => results.filter(track => track));
  }

  function formatForAlgolia(tracks, validCategoriesData) {
    return tracks.map(track => {
      let adjustedTrackTags = new Set();

      track.trackTags.forEach(tag => {
        const tagValue = tag.value.toLowerCase().trim();
        validCategoriesData.forEach(categoryInfo => {
          const categoryLower = categoryInfo.category.toLowerCase().trim();

          if (categoryLower === tagValue || (categoryInfo.related && categoryInfo.related.map(r => r.toLowerCase()).includes(tagValue))) {
            adjustedTrackTags.add(categoryInfo.category);
          }

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

      const titleLower = track.title.toLowerCase().trim();
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

  async function fetchExistingRecordsFromAlgolia(index) {
    const existingObjects = [];
    try {
      await index.browseObjects({
        query: '',
        tagFilters: 'labs',
        batch: batch => {
          for (const obj of batch) {
            if (obj.id && obj.interactive){
              existingObjects.push(...batch);
            }
          }
        },
      });
    } catch (error) {
      console.error('Error fetching existing records from Algolia:', error);
    }
    return existingObjects;
  }

  function saveRecordsToFile(records, outputDir, outputFileName) {
    const outputFile = path.join(outputDir, outputFileName);

    try {
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      fs.writeFileSync(outputFile, JSON.stringify(records, null, 2));
      console.log(`Algolia records saved to ${outputFile}`);
    } catch (error) {
      console.error(`Error saving Algolia records to file: ${error.message}`);
    }
  }

  const tracks = await fetchTracks();
  const validTrackIds = await getTrackIdsFromRepo();
  const filteredTracks = await filterTracksByRepo(tracks, validTrackIds);
  const validCategories = await fetchValidCategories();
  const existingObjects = await fetchExistingRecordsFromAlgolia(index);
  const existingObjectsMap = new Map(existingObjects.map(obj => [obj.id, obj]));
  const tracksWithInvites = await createInvitesForTracks(filteredTracks, new Set(existingObjectsMap.keys()), existingObjectsMap);
  const algoliaRecords = formatForAlgolia(tracksWithInvites.filter(track => track), validCategories);

  let objectsToUpdate = [];
  let objectsToAdd = [];
  // Initialize objectsToDelete with the keys from the existingObjectsMap
  let objectsToDelete = [...existingObjectsMap.keys()];
  for (const obj of algoliaRecords) {
    const existingObject = existingObjectsMap.get(obj.id);
    if (existingObject) {
      if (!_.isEqual(existingObject, obj)) {
        objectsToUpdate.push(obj);
      }
      // Remove from objectsToDelete if it exists in existingObjectsMap and is handled
      objectsToDelete.splice(objectsToDelete.indexOf(obj.id), 1);
    } else {
      objectsToAdd.push(obj);
    }
  }

  const combinedRecords = [...existingObjectsMap.values(), ...algoliaRecords];
  // Sort combinedRecords alphabetically by title
  combinedRecords.sort((a, b) => {
    const titleA = a.title.toLowerCase();
    const titleB = b.title.toLowerCase();
    if (titleA < titleB) {
      return -1;
    }
    if (titleA > titleB) {
      return 1;
    }
    return 0;
  });
  saveRecordsToFile(combinedRecords, path.resolve(__dirname, ATTACHMENTS_PATH), INSTRUQT_LABS_JSON_FILE);

  if (objectsToUpdate.length > 0 || objectsToAdd.length > 0) {
    try {
      const batchActions = [
        ...objectsToAdd.map(object => ({ action: 'addObject', body: object })),
        ...objectsToUpdate.map(object => ({ action: 'updateObject', body: object }))
      ];

      await index.batch(batchActions);
      console.log('Batch operations completed successfully');
    } catch (error) {
      console.error(`Error uploading records to Algolia: ${error.message}`);
    }
  } else {
    console.log('No changes detected in the records.');
  }

  if (objectsToDelete.length > 0) {
    try {
      await index.deleteObjects(objectsToDelete);
      console.log(`Deleted ${objectsToDelete.length} outdated records`);
    } catch (error) {
      console.error(`Error deleting records from Algolia: ${error.message}`);
    }
  }
}

main();
