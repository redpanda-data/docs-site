export default async (request, context) => {
  const url = new URL(request.url);
  const acceptHeader = request.headers.get('accept') || '';

  // Check if the request is asking for markdown or plain text
  const wantsMarkdown = acceptHeader.includes('text/markdown') ||
                        acceptHeader.includes('text/plain');

  if (!wantsMarkdown) {
    // Let the request continue normally for browsers
    return context.next();
  }

  // Map the URL path to the markdown file path
  let mdPath = url.pathname;

  // Ensure path ends with / for indexify URLs
  if (!mdPath.endsWith('/') && !mdPath.includes('.')) {
    mdPath += '/';
  }

  // For indexify URLs (ending with /), append index.md
  if (mdPath.endsWith('/')) {
    mdPath += 'index.md';
  } else if (mdPath.endsWith('.html')) {
    // For non-indexify URLs, replace .html with .md
    mdPath = mdPath.replace(/\.html$/, '.md');
  } else {
    // If no extension, assume it's an indexify URL
    mdPath += '/index.md';
  }

  try {
    // Try to fetch the markdown file directly
    const mdUrl = new URL(mdPath, url.origin);
    const mdResponse = await fetch(mdUrl.toString());

    if (mdResponse.ok) {
      // Serve the markdown with the correct content-type
      const mdContent = await mdResponse.text();
      return new Response(mdContent, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'X-Content-Source': 'markdown'
        }
      });
    }

    // If markdown file doesn't exist, fall back to HTML
    return context.next();

  } catch (error) {
    console.error('Error serving markdown:', error);
    // Fall back to HTML on error
    return context.next();
  }
};

// Configure the edge function to run on all documentation paths
export const config = {
  path: [
    "/*"
  ]
};
