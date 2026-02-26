## Summary

Fixes agent-friendly documentation (afdocs) issues to improve accessibility for AI agents and LLMs, and implements dynamic URL generation for llms.txt that works across production, preview, and local builds.

## Problem

The afdocs checker identified several issues:
- **Broken links**: API URLs returning 503 errors, Twitter/X returning 403, missing sitemap
- **Link resolution**: Only 87% of links resolved successfully
- **Environment-specific URLs**: Hardcoded `docs.redpanda.com` URLs prevented testing on deploy previews
- **Missing content**: No documentation for AI agents and Agentic Data Plane

## Solution

### 1. Fixed Broken Links
- Updated API URLs to match actual paths in `proxy-api-docs.js` edge function
- Removed dead Twitter/X link (always returns 403 to automated tools)
- Re-added sitemap.xml link after confirming it exists

### 2. Added Markdown Access Documentation
- Documented the indexify convention (all pages are `index.md`)
- Explained content negotiation with `Accept: text/markdown` headers
- Provided example URLs for accessing markdown content

### 3. Configured Markdown Content Negotiation
- Already had `serve-markdown` edge function for handling `Accept: text/markdown` headers
- Already had URL rewrites for `.md` URLs to support indexify convention
- No changes needed - existing implementation works correctly

### 4. Added AI Agent & Agentic Data Plane Documentation
- Comprehensive section covering:
  - Agentic Data Plane overview
  - Model Context Protocol (MCP)
  - AI Gateway
  - Building AI agents
  - Agent observability

### 5. Converted llms.txt to llms.adoc with Dynamic URLs

**Key Innovation**: Converted `llms.txt` to `llms.adoc` (AsciiDoc format) and created a new Antora extension to dynamically generate environment-aware URLs.

**How it works:**
1. Author `llms.adoc` with AsciiDoc syntax and `{site-url}` attribute
2. `replace-attributes-in-attachments` extension expands all attributes
3. `convert-llms-to-txt` extension:
   - Detects environment (production vs preview) using `PREVIEW` env var
   - Sets `site-url` attribute from `playbook.site.url` or `DEPLOY_PRIME_URL`
   - Converts AsciiDoc formatting to plain text
   - Generates `llms.txt` at site root
   - Generates `llms-full.txt` with all markdown content from latest versions

**Environment-aware URLs:**
- **Production**: `https://docs.redpanda.com`
- **PR previews**: `https://deploy-preview-NNN--redpanda-documentation.netlify.app`
- **Local builds**: `http://localhost:8000`

This enables CI/CD testing with afdocs on deploy previews before merging to production.

## Changes

### Modified Files
- `home/modules/ROOT/attachments/llms.adoc` - Converted from llms.txt to AsciiDoc format
- `antora-playbook.yml` - Added replace-attributes and convert-llms-to-txt configurations
- `local-antora-playbook.yml` - Same configuration for local testing
- `preview-antora-playbook.yml` - Same configuration for preview builds
- `netlify.toml` - Already had markdown support (no changes needed)

### Removed Files
- `home/modules/ROOT/attachments/llms.txt` - Replaced by llms.adoc

## Why llms.adoc is an Attachment

The `llms.adoc` file is added as an attachment (not a page) because:
1. **Not browsable documentation**: It's a machine-readable file for AI agents, not human-readable docs
2. **No HTML output needed**: We only need the plain text conversion (llms.txt), not an HTML page
3. **Attribute replacement**: Attachments can use the `replace-attributes-in-attachments` extension
4. **Site root placement**: Extension moves final output to site root (`/llms.txt` and `/llms-full.txt`)

## Testing

✅ **Local testing with netlify dev:**
- llms.txt: 7KB with correct URLs
- llms-full.txt: 12MB with 1,583 pages from latest versions
- Edge functions working correctly
- Markdown content negotiation working
- All formatting converted properly

✅ **Link resolution:**
- Improved from 87% to 100%
- All broken links fixed

✅ **afdocs results:**
```
Link resolution: 100%
Content accessible: ✓
Markdown support: ✓
```

## Dependencies

⚠️ **This PR depends on [docs-extensions-and-macros#173](https://github.com/redpanda-data/docs-extensions-and-macros/pull/173) being merged and published to npm.**

The extension provides:
- `convert-llms-to-txt` extension with environment detection
- Dynamic `site-url` attribute based on `PREVIEW` env var
- AsciiDoc to plain text conversion
- llms-full.txt generation with latest versions only

**Workflow:**
1. Merge and publish extensions PR #173 (version 4.15.0)
2. Update package.json in docs-site to use `^4.15.0`
3. Merge this PR
4. Deploy and test with afdocs on preview URL

## Related

- Extension PR: https://github.com/redpanda-data/docs-extensions-and-macros/pull/173
- afdocs tool: https://github.com/anthropics/afdocs
