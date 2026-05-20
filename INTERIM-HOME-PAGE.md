# Interim Home Page Configuration

**Status**: TEMPORARY - Data Platform is currently the home page instead of the dedicated home component.

## Current Configuration

The following changes were made to use data-platform as the home page:

### 1. Playbook Changes (`test-unified-nav.yml`)
```yaml
site:
  start_page: data-platform::index.adoc  # Changed from home::index.adoc

content:
  sources:
  - url: .
    branches: HEAD
    start_paths: [data-platform, self-managed]  # Removed 'home'
```

### 2. Redirect (`netlify.toml`)
```toml
[[redirects]]
from = "/home"
to = "/data-platform/"  # Changed from "/current/home"
status = 301
```

## Features Added to Data Platform

The data-platform page now includes:

1. **Ask AI Search Input** - Hero section with AI search input and suggestion chips
2. **NEW Badge for SQL** - Cloud BYOC stat shows "+ SQL" with NEW badge when SQL docs have `page-new` attribute
3. **Improved Hero** - More prominent call-to-action for AI assistance

## How to Revert to Original Home Page

When ready to restore the dedicated home component, make these changes:

### Step 1: Update Playbook
**File**: `test-unified-nav.yml` (or your production playbook)

```yaml
site:
  start_page: home::index.adoc  # Change back to home

content:
  sources:
  - url: .
    branches: HEAD
    start_paths: [home, data-platform, self-managed]  # Add 'home' back
```

### Step 2: Restore Redirect
**File**: `netlify.toml`

```toml
[[redirects]]
from = "/home"
to = "/current/home"  # Change back to home
status = 301
```

### Step 3: Rebuild
```bash
npx antora your-playbook.yml
```

## Why This Change?

Without the Agentic Data Plane component launched, the dedicated home page felt sparse. The data-platform page provides a better entry point showcasing:
- Cloud and Self-Managed options
- Ask AI search for immediate help
- Clear path to documentation
- NEW badge highlighting Cloud BYOC SQL feature

## When to Revert?

Revert when:
1. Agentic Data Plane launches and needs prominent placement
2. Home page gets redesigned with better content
3. Marketing/product decides original structure is better
