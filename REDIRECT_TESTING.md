# Redirect Testing Documentation

## Overview

This document describes the automated redirect testing infrastructure added to validate the redirect rules in `netlify.toml`.

## Background

Following a comprehensive review of the redirect-rules PR (which added 218 lines of redirects to fix 404s from component restructuring), automated testing was identified as a critical gap. While manual testing caught the redirect ordering issue, automated tests prevent future regressions and validate redirect behavior in CI.

## Review Findings Summary

### Already Fixed

1. **Critical Ordering Issue** - Versioned wildcards (`/24.1/*`) are correctly placed AFTER cloud-specific rules (lines 726-759 come after 672-720), ensuring cloud paths like `/24.1/get-started/quick-start-cloud/` redirect to cloud-data-platform, not streaming.

2. **Two-Hop Redirects** - Explicit single-hop rules for cluster-balancing and fips-compliance already exist at lines 374-382, preventing redirect chains.

3. **Force Flag** - Verified that Antora does not generate files at redirect source paths, so `force = true` is not needed.

### Implemented

4. **Automated Testing** - Comprehensive test suite covering all 7 redirect categories with 50+ test cases.

## Test Suite

### Location
- `tests/redirects.test.ts` - Main test suite
- Runs via vitest (already in devDependencies)

### Test Categories

The test suite validates 7 categories of redirects:

1. **Versioned Path Wildcards** (7 tests)
   - Verifies `/25.3/*`, `/24.1/*`, etc. redirect to `/streaming/{version}/:splat`
   - Example: `/25.3/get-started/architecture/` → `/streaming/25.3/get-started/architecture/`

2. **Cloud-Specific Override Rules** (6 tests)
   - **Critical**: Ensures cloud paths are NOT caught by versioned wildcards
   - Example: `/24.1/get-started/quick-start-cloud/` → `/cloud-data-platform/...` (NOT `/streaming/24.1/...`)

3. **Two-Hop Prevention** (2 tests)
   - Verifies cluster-balancing and fips-compliance use single-hop redirects
   - Ensures redirect count = 1 (not 2)

4. **Connect Component Restructure** (6 tests)
   - Verifies `/connect/inputs/*` → `/connect/components/inputs/*`
   - Covers inputs, outputs, processors, caches, buffers, about page

5. **Cloud-Data-Platform Path Fixes** (7 tests)
   - RPK path corrections: `/cloud-data-platform/rpk/*` → `/cloud-data-platform/reference/rpk/*`
   - Connect path drops: `/cloud-data-platform/connect/*` → `/connect/*`

6. **Streaming Version-less Paths** (6 tests)
   - Verifies `/streaming/reference/*` → `/streaming/current/reference/*`
   - Covers reference, deploy, develop, manage, upgrade, get-started

7. **Streaming Current Restructured Paths** (4 tests)
   - Licensing → get-started/licensing
   - Kubernetes → deploy/.../kubernetes
   - Cluster-balancing → cluster-maintenance/...
   - FIPS → security/...

### Test Assertions

Each test verifies:
1. Final status code is 200
2. Final URL matches expected destination
3. Redirect chain is single-hop (≤2 including Netlify internal redirects)
4. Response time < 2 seconds

### Running Tests

```bash
# Local testing against deploy preview
DEPLOY_URL=<netlify-preview-url> npm run test:redirects

# Verbose output
DEPLOY_URL=<netlify-preview-url> npm run test:redirects:verbose

# Production testing (default)
npm run test:redirects
```

## CI Integration

### Workflow: `.github/workflows/afdocs-checks.yml`

The redirect tests run as a separate job for clear visibility in PR checks:

**Two separate jobs:**
1. **Agent-Friendly Docs** - validates agent-friendly documentation standards
2. **Redirect Tests** - validates redirect rules in netlify.toml

**Trigger**: On pull request (opened, synchronize, reopened) when relevant files change:
- netlify.toml (redirect rules)
- .adoc or .md files (documentation content)
- antora-playbook.yml files (build configuration)
- workflow file itself

**Each job:**
1. Waits for Netlify deploy preview
2. Runs its test suite
3. Posts results to GitHub Actions summary
4. Fails the check if tests fail (no `continue-on-error`)

**Benefits:**
- Redirect tests show as a separate PR check (clear visibility)
- Failures are immediately obvious in PR status
- Each test suite can be run/debugged independently

### Example CI Output

```markdown
## Documentation Checks Results

**Deploy URL:** https://deploy-preview-123--redpanda-documentation.netlify.app

### Agent-Friendly Docs Checks
PASS: All afdocs checks passed!

### Redirect Tests
PASS: All redirect tests passed!

**All documentation checks passed!**
```

## Redirect Rules Reference

### Key Sections in netlify.toml

- **Lines 355-397**: Streaming paths without version (with two-hop prevention)
- **Lines 399-435**: Version root redirects
- **Lines 469-490**: Streaming current restructured paths
- **Lines 575-644**: Cloud-data-platform path fixes
- **Lines 672-720**: Cloud-specific redirects (MUST come before versioned wildcards)
- **Lines 722-759**: Versioned path wildcards (MUST come after cloud-specific rules)
- **Lines 786-838**: Connect component restructure

### Critical Ordering

Netlify processes redirects top-to-bottom with first-match-wins behavior. The order MUST be:

1. Specific rules (e.g., `/24.1/get-started/quick-start-cloud/`)
2. Wildcard rules (e.g., `/24.1/*`)

This ensures specific paths don't get caught by broader wildcards.

## Trailing Slash Convention

**Current Pattern** (intentional):
- `from` paths: Usually NO trailing slash
- `to` paths: Usually WITH trailing slash

**Rationale**: Netlify treats `/path` and `/path/` as different URLs. The current pattern matches how URLs appear in the wild (e.g., from external links, search engines) and ensures consistent destination URLs.

**No action needed** unless Slack #docs-redpanda-404 reports suggest otherwise.

## Maintenance

### Adding New Redirects

When adding new redirects to `netlify.toml`:

1. **Check ordering**: Ensure specific rules come before wildcards
2. **Add test case**: Update `tests/redirects.test.ts` with test for new redirect
3. **Run tests**: Verify locally against deploy preview
4. **Monitor**: Watch #docs-redpanda-404 after merge

### Test Failures

If redirect tests fail in CI:

1. Check deploy preview URL (shown in GitHub Actions summary)
2. Manually test failing URLs in browser
3. Check browser network tab for redirect chain
4. Verify redirect rule order in `netlify.toml`
5. Run locally: `DEPLOY_URL=<preview-url> npm run test:redirects:verbose`

## Future Enhancements

Potential improvements:

1. **Response time monitoring**: Track redirect performance over time
2. **Dead link detection**: Crawl site for broken internal links
3. **Redirect chain analysis**: Identify multi-hop redirects automatically
4. **404 monitoring**: Automated Slack #docs-redpanda-404 analysis
5. **Trailing slash audit**: Automated consistency checking

## References

- Original PR review: Comprehensive docs standards review identifying ordering issue
- Netlify redirect docs: https://docs.netlify.com/routing/redirects/
- Antora playbook: `antora-playbook.yml`
- CI workflow: `.github/workflows/afdocs-checks.yml`
