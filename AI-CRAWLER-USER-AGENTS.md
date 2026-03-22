# AI Crawler User Agents - Verification Report

**Last Updated**: March 22, 2026
**Repository**: docs-site

## Purpose

This document tracks verified AI crawler user agents used in our `robots.txt` configuration to ensure we're welcoming legitimate AI crawlers while avoiding deprecated or questionable bots.

## Current Configuration

Our robots.txt (via `antora-playbook.yml`) explicitly allows the following AI crawlers:

### ✅ Verified and Active (March 2026)

#### OpenAI
- **GPTBot** - AI model training crawler
  - User-agent: `GPTBot`
  - Full string: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)`
  - Official docs: https://platform.openai.com/docs/gptbot
  - Purpose: Training AI models like GPT-4

- **ChatGPT-User** - Direct user request crawler
  - User-agent: `ChatGPT-User`
  - Full string: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot`
  - Official docs: https://platform.openai.com/docs/bots
  - Purpose: Fetches content when ChatGPT users request current information

#### Anthropic (Updated March 2026)
- **ClaudeBot** - AI model training crawler
  - User-agent: `ClaudeBot`
  - Purpose: Collects web content for AI model training
  - Official docs: https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler

- **Claude-User** - Direct user request crawler
  - User-agent: `Claude-User`
  - Purpose: Fetches web pages when a Claude user asks a question

- **Claude-SearchBot** - Search optimization crawler
  - User-agent: `Claude-SearchBot`
  - Purpose: Crawls the web to improve search result quality inside Claude

**Note**: Anthropic deprecated `Claude-Web` and `anthropic-ai` user agents in 2026, replacing them with the three-bot framework above.

#### Perplexity
- **PerplexityBot** - AI search indexing
  - User-agent: `PerplexityBot`
  - Full string: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)`
  - Official docs: https://docs.perplexity.ai/docs/resources/perplexity-crawlers
  - Purpose: General web crawling and indexing for AI search

**Note**: There's also a `Perplexity-User` agent for real-time browsing, but we only list PerplexityBot for general indexing.

#### Google
- **Google-Extended** - AI training data collection
  - User-agent: `Google-Extended`
  - Purpose: Improving Gemini Apps and Vertex AI generative APIs
  - Does NOT affect Google Search rankings
  - Official info: https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers

- **GoogleOther** - Generic research crawler
  - User-agent: `GoogleOther`
  - Purpose: Various product teams for R&D, one-off crawls
  - Variants: GoogleOther-Image, GoogleOther-Video
  - No effect on Google Search

#### Common Crawl
- **CCBot** - Open dataset crawler
  - User-agent: `CCBot`
  - Full string: `CCBot/2.0 (https://commoncrawl.org/faq/)`
  - Official docs: https://commoncrawl.org/ccbot
  - Purpose: Non-profit open web crawl dataset
  - Verification: Provides IP ranges at https://index.commoncrawl.org/ccbot.json

#### Meta
- **FacebookBot** - AI training data
  - User-agent: `FacebookBot`
  - Official docs: https://developers.facebook.com/docs/sharing/bot/
  - Purpose: Collects content for training machine learning models
  - Note: Distinct from `facebookexternalhit` (link previews) and `Meta-ExternalAgent`

## ❌ Removed User Agents

The following user agents were removed from our configuration during the March 2026 audit:

### Deprecated by Vendor
- **Claude-Web** - Deprecated by Anthropic, replaced by ClaudeBot
- **anthropic-ai** - Deprecated by Anthropic, replaced by ClaudeBot

### Duplicate/Incorrect
- **Perplexity** - Not a real user agent name; PerplexityBot is the correct name

### Questionable/Undocumented
- **cohere-ai** - No official Cohere documentation exists for this user agent
  - Sources describe it as "unconfirmed" and "undocumented"
  - Possibly used by Cohere's products but not officially documented

- **Omgilibot** - Commercial data scraper, not an AI company crawler
  - Owned by webz.io
  - Sells scraped data to LLMs rather than being an AI company's training crawler
  - Purpose doesn't align with our goal of supporting AI development

## Maintenance

### When to Update

1. **Quarterly Review** (January, April, July, October)
   - Check for new AI crawler announcements
   - Verify existing crawlers are still active
   - Review official documentation for changes

2. **When Adding New Crawlers**
   - Verify official documentation exists
   - Confirm the crawler is from a legitimate AI company
   - Check that it's for AI training/development, not commercial scraping
   - Add to both production (`antora-playbook.yml`) and local (`local-antora-playbook.yml` in docs-extensions-and-macros)

3. **Security Incidents**
   - If a crawler is found to be abusive or misrepresenting itself
   - Example: Perplexity was caught using stealth crawlers in 2025 (but PerplexityBot itself remains legitimate)

### Verification Checklist

Before adding a new user agent:
- [ ] Official documentation from the AI company exists
- [ ] User agent string is publicly documented
- [ ] Purpose is for AI training/development (not commercial data scraping)
- [ ] Company has a robots.txt policy page
- [ ] User agent respects robots.txt directives
- [ ] IP address verification available (optional but preferred)

## References

### Official Documentation
- **OpenAI**: https://platform.openai.com/docs/bots
- **Anthropic**: https://support.anthropic.com/en/articles/8896518
- **Perplexity**: https://docs.perplexity.ai/docs/resources/perplexity-crawlers
- **Google**: https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers
- **Common Crawl**: https://commoncrawl.org/ccbot
- **Meta**: https://developers.facebook.com/docs/sharing/bot/

### Industry Resources
- Dark Visitors (user agent directory): https://darkvisitors.com
- Cloudflare Bot Report 2025: https://blog.cloudflare.com/from-googlebot-to-gptbot-whos-crawling-your-site-in-2025/
- Anthropic's Three-Bot Framework: https://almcorp.com/blog/anthropic-claude-bots-robots-txt-strategy/

## Change Log

### March 22, 2026
- **Removed**: `Claude-Web`, `anthropic-ai` (deprecated by Anthropic)
- **Added**: `ClaudeBot`, `Claude-User`, `Claude-SearchBot` (Anthropic's new framework)
- **Removed**: `Perplexity` (duplicate/incorrect name)
- **Removed**: `cohere-ai` (undocumented)
- **Removed**: `Omgilibot` (commercial scraper, not AI development)
- **Verified**: All remaining user agents confirmed active with official documentation
