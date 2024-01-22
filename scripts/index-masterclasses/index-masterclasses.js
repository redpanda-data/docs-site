const { GraphQLClient, gql } = require('graphql-request');
const algoliasearch = require('algoliasearch');

const INVITE_LINK_BASE = 'https://play.instruqt.com/redpanda/invite/'
const ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID;
const ALGOLIA_ADMIN_API_KEY = process.env.ALGOLIA_ADMIN_API_KEY;
const ALGOLIA_INDEX_NAME = process.env.ALGOLIA_INDEX_NAME;
const INSTRUQT_API_KEY = process.env.INSTRUQT_API_KEY;

if (!ALGOLIA_APP_ID || !ALGOLIA_ADMIN_API_KEY || !ALGOLIA_INDEX_NAME) {
  console.error('Algolia configuration is missing. Set ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY, and ALGOLIA_INDEX_NAME environment variables.');
  process.exit(1);
}

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
    createTrackInvite(invite: {publicTitle: "New invites from docs", title: "New invites from docs", trackIDs: [$trackId], allowAnonymous: true}) {
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

async function createInvitesForTracks(tracks) {
  return Promise.all(tracks.map(async (track) => {
    const inviteData = await client.request(CREATE_INVITE_MUTATION, { trackId: track.id });
    return {
      ...track,
      objectID: INVITE_LINK_BASE + inviteData.createTrackInvite.id
    };
  }));
}

function formatForAlgolia(tracks) {
  return tracks.map(track => ({
    objectID: track.objectID,
    title: track.title,
    id: track.id,
    image: track.icon,
    description: track.teaser,
    slug: track.slug,
    challenges: track.challenges.map(ch => ({ title: ch.title, type: ch.type })),
    trackTags: track.trackTags.map(tag => ({ value: tag.value }))
  }));
}

const algoliaClient = algoliasearch('YOUR_ALGOLIA_APP_ID', 'YOUR_ALGOLIA_API_KEY');
const index = algoliaClient.initIndex('your_index_name');

async function uploadToAlgolia(records) {
  try {
    await index.saveObjects(records);
    console.log('Instruqt tracks uploaded to Algolia');
  } catch (error) {
    console.error('Error uploading Instruqt tracks to Algolia:', error);
  }
}

async function main() {
  const tracks = await fetchTracks();
  const tracksWithInvites = await createInvitesForTracks(tracks);
  const algoliaRecords = formatForAlgolia(tracksWithInvites);
  console.log(algoliaRecords)
  //await uploadToAlgolia(algoliaRecords);
}

main();
