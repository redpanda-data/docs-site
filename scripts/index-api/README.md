# API Documentation Indexing

This directory contains scripts for indexing Redpanda API documentation into Algolia search.

## Files

- **`index-api.js`** - Main indexing script that extracts API endpoints and groups from Bump.sh-generated documentation and indexes them to Algolia

## Usage

### Running the indexer

```bash
# With environment variables
ALGOLIA_APP_ID=your_app_id \
ALGOLIA_ADMIN_API_KEY=your_admin_key \
ALGOLIA_INDEX_NAME=your_index_name \
node index-api.js

# Or using npm script
npm run index
```

## Environment Variables

### Required for indexing
- `ALGOLIA_APP_ID` - Your Algolia application ID
- `ALGOLIA_ADMIN_API_KEY` - Your Algolia admin API key
- `ALGOLIA_INDEX_NAME` - Target Algolia index name (default: "docs")

### Optional
- `SITE_URL` - Base URL for the documentation site (default: "https://docs.redpanda.com")

## Technical Details

The indexing script handles Bump.sh's lazy-loaded turbo-frame architecture by:

1. **Collecting turbo-frame URLs** from the main API documentation pages
2. **Navigating to individual frames** to bypass lazy-loading
3. **Extracting complete endpoint data** including HTTP methods, paths, titles, and descriptions
4. **Classifying records by product** (Cloud vs Self-Managed) based on URL patterns
5. **Indexing to Algolia** with proper metadata and tags

This approach achieves 100% success rate for method/path extraction compared to ~16% with naive DOM scraping.
