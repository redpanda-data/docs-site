export default async (request, context) => {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname.endsWith('/null') || pathname.endsWith('/null/')) {
    // Remove the "/null" part from the URL
    let newPathname = pathname.replace(/\/null\/?$/, '/');

    // Ensure the URL ends with a "/" for local tests
    if (!newPathname.endsWith('/')) {
      newPathname += '/';
    }

    // Construct the new URL without "/null"
    const newUrl = `${url.origin}${newPathname}${url.search}`;

    return Response.redirect(newUrl, 301);
  }

  return context.next();
};

// This configures the Edge Function to trigger on paths ending with "/null"
export const config = { path: "*/null" };
