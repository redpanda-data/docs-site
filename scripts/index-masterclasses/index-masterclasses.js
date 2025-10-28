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

  const requiredAlgoliaVars = ['ALGOLIA_APP_ID','ALGOLIA_ADMIN_API_KEY','ALGOLIA_INDEX_NAME'];
  const missingAlgoliaVars = requiredAlgoliaVars.filter(name => !process.env[name]);
  if (missingAlgoliaVars.length > 0) {
    console.error(`Missing Algolia configuration. Set: ${missingAlgoliaVars.join(', ')}`);
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

  // Fetch EVERYTHING. No tag/interactive filters (we want to see dupes).
  async function fetchExistingRecordsFromAlgolia() {
    const existing = [];
    try {
      await index.browseObjects({
        query: '',
        batch: (batch) => {
          for (const obj of batch) {
            if (obj && obj.id) existing.push(obj);
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

  // Identify duplicates by business `id`; keep newest; delete others by objectID
  function computeDuplicateDeletes(existing) {
    const byId = new Map();
    for (const o of existing) {
      if (!byId.has(o.id)) byId.set(o.id, []);
      byId.get(o.id).push(o);
    }
    const toDelete = [];
    for (const list of byId.values()) {
      if (list.length <= 1) continue;
      const keep = chooseNewest(list);
      for (const o of list) {
        if (o.objectID && o.objectID !== keep.objectID) toDelete.push(o.objectID);
      }
    }
    return { toDelete: [...new Set(toDelete)], byId };
  }

  // IMPORTANT RULE: If a record exists for this id, DO NOT create a new invite/record.
  async function createInvitesForTracks(tracks, existingIds, existingById) {
    return Promise.all(tracks.map(async (track) => {
      if (existingIds.has(track.id)) {
        // Reuse the newest existing objectID (no new invite)
        const existing = chooseNewest(existingById.get(track.id) || []);
        if (!existing?.objectID) {
          console.warn(`Track ${track.id} exists but has no objectID; skipping re-index to avoid new record.`);
          return { ...track, objectID: undefined }; // will be filtered out later
        }
        return { ...track, objectID: existing.objectID };
      }
      // New track: create one invite
      const inviteData = await client.request(CREATE_INVITE_MUTATION, { trackId: track.id });
      return { ...track, objectID: INVITE_LINK_BASE + inviteData.createTrackInvite.id };
    }));
  }

  function normalizeForCompare(obj) {
    // shallow clone and drop volatile fields
    const clone = { ...obj };
    delete clone.unixTimestamp;
    // normalize array orderings to avoid false diffs
    if (Array.isArray(clone.titles)) {
      clone.titles = [...clone.titles].sort((a, b) => (a.t || '').localeCompare(b.t || ''));
    }
    if (Array.isArray(clone.categories)) {
      clone.categories = [...clone.categories].sort((a, b) => a.localeCompare(b));
    }
    if (Array.isArray(clone._tags)) {
      clone._tags = [...clone._tags].sort((a, b) => a.localeCompare(b));
    }
    return clone;
  }

  function formatForAlgolia(tracks, validCategoriesData) {
    return tracks
      .filter(track => !!track.objectID) // skip those we intentionally refused to recreate
      .map((track) => {
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
          objectID: track.objectID,        // keeping invite URL as objectID
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
      let shouldWrite = true;
      if (fs.existsSync(outputFile)) {
        const existingRaw = fs.readFileSync(outputFile, 'utf8');
        let existingRecords;
        try {
          existingRecords = JSON.parse(existingRaw);
        } catch {
          existingRecords = [];
        }
        // Normalize both arrays by removing unixTimestamp
        const normalize = arr => arr.map(o => {
          const { unixTimestamp, ...rest } = o;
          return rest;
        });
        if (_.isEqual(normalize(existingRecords), normalize(records))) {
          shouldWrite = false;
        }
      }
      if (shouldWrite) {
        fs.writeFileSync(outputFile, JSON.stringify(records, null, 2));
        console.log(`Saved Algolia records to ${outputFile}`);
      } else {
        console.log(`No content changes for ${outputFile}; not updated (only unixTimestamp changed).`);
      }
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

  // 1) Pre-clean duplicates already in Algolia
  const { toDelete, byId: existingById } = computeDuplicateDeletes(existingObjects);
  const existingIds = new Set(existingById.keys());

  // 2) Ensure we never create new for already-existing ids
  const tracksWithInvites = await createInvitesForTracks(filteredTracks, existingIds, existingById);

  // 3) Build records (skip any with undefined objectID to honor "no new for existing ids")
  const algoliaRecords = formatForAlgolia(tracksWithInvites, validCategories);

  // 4) Plan adds/updates
  const objectsToAdd = algoliaRecords.filter(r => !existingIds.has(r.id)); // truly new ids
  const objectsToUpdate = algoliaRecords.filter(r => {
    const existing = chooseNewest(existingById.get(r.id) || []);
    if (!existing) return false;
    const a = normalizeForCompare(existing);
    const b = normalizeForCompare(r);
    return !_.isEqual(a, b);
  });

  // 5) Write a deduped artifact by `id` (keep newest among existing+new)
  const byIdArtifact = new Map();
  for (const o of existingObjects) {
    const cur = byIdArtifact.get(o.id);
    if (!cur || (o.unixTimestamp || 0) > (cur.unixTimestamp || 0)) byIdArtifact.set(o.id, o);
  }
  for (const o of algoliaRecords) {
    const cur = byIdArtifact.get(o.id);
    if (!cur || (o.unixTimestamp || 0) > (cur.unixTimestamp || 0)) byIdArtifact.set(o.id, o);
  }
  const finalRecords = [...byIdArtifact.values()].sort((a, b) =>
    (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })
  );
  saveRecordsToFile(finalRecords, path.resolve(__dirname, ATTACHMENTS_PATH), INSTRUQT_LABS_JSON_FILE);

  // 6) Apply adds/updates
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

  // 7) Delete duplicates discovered in step 1
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
