const { GraphQLClient, gql } = require('graphql-request');
const algoliasearch = require('algoliasearch');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const _ = require('lodash');

async function main() {
  const INVITE_LINK_BASE = 'https://play.instruqt.com/redpanda/invite/';
  const VALID_CATEGORIES_URL = 'modules/ROOT/partials/valid-categories.yml';
  const GRAPHQL_API_URL = 'https://play.instruqt.com/graphql';
  const GITHUB_OWNER = 'redpanda-data';
  const ATTACHMENTS_PATH = '../../home/modules/ROOT/attachments';
  const INSTRUQT_LABS_JSON_FILE = 'instruqt-labs.json';
  const ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID;
  const ALGOLIA_ADMIN_API_KEY = process.env.ALGOLIA_ADMIN_API_KEY;
  const ALGOLIA_INDEX_NAME = process.env.ALGOLIA_INDEX_NAME;
  const INSTRUQT_API_KEY = process.env.INSTRUQT_API_KEY;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  const requiredAlgoliaVars = [
    'ALGOLIA_APP_ID',
    'ALGOLIA_ADMIN_API_KEY',
    'ALGOLIA_INDEX_NAME'
  ];
  const missingAlgoliaVars = requiredAlgoliaVars.filter(
    (name) => !process.env[name]
  );
  if (missingAlgoliaVars.length > 0) {
    console.error(`Missing Algolia configuration. The following environment variables are required but not set: ${missingAlgoliaVars.join(', ')}`);
    process.exit(1);
  }

  async function loadOctokit() {
    const { Octokit } = await import('@octokit/rest');
    return new Octokit({ auth: GITHUB_TOKEN });
  }
  const octokit = await loadOctokit();

  const algoliaClient = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY);
  const index = algoliaClient.initIndex(ALGOLIA_INDEX_NAME);

  const deploymentTypes = {
    Kubernetes: ['kubernetes', 'k8s'],
    Docker: ['docker'],
    Linux: ['linux', 'unix'],
    'Redpanda Cloud': ['redpanda cloud', 'cloud', 'serverless'],
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
        challenges { title permalink type }
        trackTags { value }
        teaser
      }
    }
  `;

  const CREATE_INVITE_MUTATION = gql`
    mutation CreateInvite($trackId: String!) {
      createTrackInvite(invite: {
        publicTitle: "Invite from Redpanda docs",
        title: "Invite from Redpanda docs",
        trackIDs: [$trackId],
        allowAnonymous: false,
        playLimit: 5
      }) {
        id
      }
    }
  `;

  const client = new GraphQLClient(GRAPHQL_API_URL, {
    headers: { authorization: `Bearer ${INSTRUQT_API_KEY}` },
  });

  async function fetchTracks() {
    try {
      const data = await client.request(GET_TRACKS_QUERY);
      return data.tracks.filter(t => !t.private && !t.maintenance);
    } catch (e) {
      console.error('Error fetching tracks:', e);
      return [];
    }
  }

  async function getTrackIdsFromRepo() {
    const trackIds = new Set();
    try {
      const { data: repoContents } = await octokit.repos.getContent({
        owner: GITHUB_OWNER, repo: 'instruqt-course', path: '',
      });
      for (const item of repoContents) {
        if (item.type === 'dir') {
          const { data: trackYml } = await octokit.repos.getContent({
            owner: GITHUB_OWNER, repo: 'instruqt-course', path: `${item.path}/track.yml`,
          });
          const content = Buffer.from(trackYml.content, 'base64').toString('utf8');
          const trackData = yaml.load(content);
          if (trackData && trackData.id) trackIds.add(trackData.id);
        }
      }
    } catch (e) {
      console.error('Error fetching track IDs from GitHub:', e);
    }
    return trackIds;
  }

  async function fetchValidCategories() {
    try {
      const { data: fileContent } = await octokit.rest.repos.getContent({
        owner: GITHUB_OWNER, repo: 'docs', path: VALID_CATEGORIES_URL, ref: 'shared',
      });
      const content = Buffer.from(fileContent.content, 'base64').toString('utf8');
      const data = yaml.load(content);
      return data['page-valid-categories'];
    } catch (e) {
      console.error('Error fetching valid categories:', e);
      return [];
    }
  }

  function determineDeploymentType(track) {
    let deploymentType = '';
    for (const tag of track.trackTags) {
      for (const [type, keywords] of Object.entries(deploymentTypes)) {
        if (keywords.includes(tag.value.toLowerCase())) { deploymentType = type; break; }
      }
      if (deploymentType) break;
    }
    if (!deploymentType) {
      const content = `${track.title.toLowerCase()} ${track.teaser.toLowerCase()}`;
      for (const [type, keywords] of Object.entries(deploymentTypes)) {
        if (keywords.some(k => content.includes(k))) { deploymentType = type; break; }
      }
    }
    return deploymentType;
  }

  async function fetchExistingRecordsFromAlgolia() {
    const existing = [];
    try {
      await index.browseObjects({
        query: '',
        tagFilters: 'labs',
        batch: (batch) => {
          for (const obj of batch) {
            if (obj.id && obj.interactive) existing.push(obj);
          }
        },
      });
    } catch (e) {
      console.error('Error fetching existing Algolia records:', e);
    }
    return existing;
  }

  function chooseNewest(list) {
    if (!list || list.length === 0) return null;
    return [...list].sort((a, b) => (b.unixTimestamp || 0) - (a.unixTimestamp || 0))[0];
  }

  function computeDuplicateDeletes(existing) {
    const byId = new Map();
    for (const o of existing) {
      if (!byId.has(o.id)) byId.set(o.id, []);
      byId.get(o.id).push(o);
    }
    const toDelete = [];
    for (const [id, list] of byId.entries()) {
      if (list.length <= 1) continue;
      const keep = chooseNewest(list);
      for (const o of list) if (o.objectID !== keep.objectID) toDelete.push(o.objectID);
    }
    return { toDelete, byId };
  }

  async function createInvitesForTracks(tracks, existingIds, existingById) {
    return Promise.all(tracks.map(async (track) => {
      let objectID;
      if (existingIds.has(track.id)) {
        const existing = chooseNewest(existingById.get(track.id) || []);
        if (!existing || !existing.objectID) {
          // No valid objectID, create new invite
          const inviteData = await client.request(CREATE_INVITE_MUTATION, { trackId: track.id });
          objectID = INVITE_LINK_BASE + inviteData.createTrackInvite.id;
        } else {
          objectID = existing.objectID;
        }
      } else {
        // New track: create one invite
        const inviteData = await client.request(CREATE_INVITE_MUTATION, { trackId: track.id });
        objectID = INVITE_LINK_BASE + inviteData.createTrackInvite.id;
      }
      return { ...track, objectID };
    }));
  }

  function formatForAlgolia(tracks, validCategoriesData) {
    return tracks.map((track) => {
      const adjusted = new Set();

      track.trackTags.forEach((tag) => {
        const tagValue = tag.value.toLowerCase().trim();
        validCategoriesData.forEach((ci) => {
          const cat = ci.category.toLowerCase().trim();
          if (cat === tagValue || (ci.related && ci.related.map(r => r.toLowerCase()).includes(tagValue))) {
            adjusted.add(ci.category);
          }
          if (ci.subcategories) {
            ci.subcategories.forEach((sub) => {
              const subLower = sub.category.toLowerCase();
              if (subLower === tagValue || (sub.related && sub.related.map(r => r.toLowerCase()).includes(tagValue))) {
                adjusted.add(ci.category);
                adjusted.add(sub.category);
              }
            });
          }
        });
      });

      const titleLower = track.title.toLowerCase();
      const teaserLower = track.teaser.toLowerCase();
      validCategoriesData.forEach((ci) => {
        const cat = ci.category.toLowerCase();
        if (titleLower.includes(cat) || teaserLower.includes(cat)) adjusted.add(ci.category);
      });

      const deploymentType = determineDeploymentType(track);

      return {
        objectID: track.objectID,
        id: track.id,
        title: track.title,
        image: track.icon,
        intro: track.teaser,
        slug: track.slug,
        deployment: deploymentType,
        titles: track.challenges.map(ch => ({ t: ch.title })),
        interactive: true,
        unixTimestamp,
        type: 'Lab',
        _tags: ['Labs'],
        categories: [...adjusted],
      };
    });
  }

  function saveRecordsToFile(records, outputDir, fileName) {
    const outputFile = path.join(outputDir, fileName);
    try {
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(outputFile, JSON.stringify(records, null, 2));
      console.log(`Saved Algolia records to ${outputFile}`);
    } catch (e) {
      console.error('Error saving JSON:', e);
    }
  }

  // ------------------- MAIN FLOW -------------------

  const tracks = await fetchTracks();
  const validTrackIds = await getTrackIdsFromRepo();
  const filteredTracks = tracks.filter(t => validTrackIds.has(t.id));
  const validCategories = await fetchValidCategories();
  const existingObjects = await fetchExistingRecordsFromAlgolia();

  // Remove duplicates from Algolia first
  const { toDelete, byId: existingById } = computeDuplicateDeletes(existingObjects);
  const existingIds = new Set(existingById.keys());

  const tracksWithInvites = await createInvitesForTracks(filteredTracks, existingIds, existingById);
  const algoliaRecords = formatForAlgolia(tracksWithInvites, validCategories);

  const objectsToAdd = algoliaRecords.filter(r => !existingIds.has(r.id));
  const objectsToUpdate = algoliaRecords.filter(r => {
  const existing = chooseNewest(existingById.get(r.id) || []);
  if (!existing) return false;
  // Exclude unixTimestamp from comparison
  const cloneExisting = { ...existing };
  const cloneNew = { ...r };
  delete cloneExisting.unixTimestamp;
  delete cloneNew.unixTimestamp;
  return !_.isEqual(cloneExisting, cloneNew);
  });

  const combinedRecords = [...existingObjects, ...algoliaRecords]
    .reduce((map, obj) => {
      if (!map.has(obj.id) || (obj.unixTimestamp || 0) > (map.get(obj.id).unixTimestamp || 0))
        map.set(obj.id, obj);
      return map;
    }, new Map());
  const finalRecords = [...combinedRecords.values()].sort((a, b) =>
    (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })
  );

  saveRecordsToFile(finalRecords, path.resolve(__dirname, ATTACHMENTS_PATH), INSTRUQT_LABS_JSON_FILE);

  try {
    if (objectsToAdd.length || objectsToUpdate.length) {
      const batch = [
        ...objectsToAdd.map(body => ({ action: 'addObject', body })),
        ...objectsToUpdate.map(body => ({ action: 'updateObject', body })),
      ];
      await index.batch(batch);
      console.log(`Added ${objectsToAdd.length}, updated ${objectsToUpdate.length}`);
    } else {
      console.log('No adds or updates required.');
    }
  } catch (e) {
    console.error('Error uploading to Algolia:', e);
  }

  if (toDelete.length) {
    try {
      await index.deleteObjects(toDelete);
      console.log(`Deleted ${toDelete.length} duplicate/stale records.`);
    } catch (e) {
      console.error('Error deleting from Algolia:', e);
    }
  } else {
    console.log('No duplicates to delete.');
  }
}

main();
