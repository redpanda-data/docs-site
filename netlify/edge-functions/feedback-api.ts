export default async (request: Request) => {
  // Only allow POST requests
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { path, feedback } = await request.json();

    // Validate input
    if (!path || !feedback) {
      return new Response(JSON.stringify({
        error: 'Missing required fields: path and feedback'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate feedback length
    if (feedback.length < 10) {
      return new Response(JSON.stringify({
        error: 'Feedback must be at least 10 characters'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (feedback.length > 5000) {
      return new Response(JSON.stringify({
        error: 'Feedback must be less than 5000 characters'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get additional context
    const referer = request.headers.get('referer') || 'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';
    const timestamp = new Date().toISOString();

    // Submit to Netlify Forms
    // This mimics a form submission so it appears in your Netlify Forms dashboard
    // Uses 'api-feedback' form which doesn't require reCAPTCHA (registered in docs/_/api-feedback-registration.html)
    const formParams = new URLSearchParams();
    formParams.append('form-name', 'api-feedback');
    formParams.append('page-path', path);
    formParams.append('feedback', feedback);
    formParams.append('referer', referer);
    formParams.append('user-agent', userAgent);
    formParams.append('timestamp', timestamp);

    // Submit to the form page where Netlify Forms are processed
    const siteUrl = new URL(request.url).origin;
    const formUrl = `${siteUrl}/home/_attachments/api-feedback-registration.html`;

    console.log('Submitting to Netlify Forms:', formUrl);
    console.log('Form data:', formParams.toString());

    const formResponse = await fetch(formUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formParams.toString()
    });

    console.log('Netlify Forms response status:', formResponse.status);
    const responseText = await formResponse.text();
    console.log('Netlify Forms response:', responseText.substring(0, 200));

    if (!formResponse.ok) {
      console.error('Netlify Forms submission failed:', responseText);
      throw new Error('Failed to submit to Netlify Forms');
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Feedback submitted successfully'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });

  } catch (error) {
    console.error('Feedback API error:', error);
    return new Response(JSON.stringify({
      error: 'Internal server error',
      message: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};

// Handle CORS preflight
export const onRequestOptions = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
};

export const config = {
  path: '/api/feedback'
};
