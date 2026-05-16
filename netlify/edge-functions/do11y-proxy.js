/**
 * Edge function to proxy do11y analytics requests to Axiom.
 * Keeps the Axiom API token server-side for security.
 */
export default async (request, context) => {
  // Only allow POST requests
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const AXIOM_TOKEN = Deno.env.get('AXIOM_DO11Y_TOKEN');
  const AXIOM_DATASET = Deno.env.get('AXIOM_DO11Y_DATASET') || 'redpanda-docs-analytics';

  if (!AXIOM_TOKEN) {
    console.error('AXIOM_DO11Y_TOKEN environment variable not configured');
    return new Response('Axiom token not configured', { status: 500 });
  }

  try {
    const body = await request.json();

    const response = await fetch(
      `https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/ingest`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${AXIOM_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      console.error(`Axiom API error: ${response.status} ${response.statusText}`);
    }

    return new Response(null, {
      status: response.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  } catch (error) {
    console.error('do11y proxy error:', error);
    return new Response('Proxy error', { status: 500 });
  }
};

export const config = {
  path: '/api/do11y',
};
