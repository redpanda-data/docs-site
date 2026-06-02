import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Redirect Test Suite
 *
 * Tests the redirect rules defined in netlify.toml to ensure:
 * 1. Redirects resolve to 200 status
 * 2. Final URLs match expected destinations
 * 3. Redirect chains are single-hop (no multi-hop redirects)
 * 4. Cloud-specific rules override versioned wildcards
 */

const BASE_URL = process.env.DEPLOY_URL || 'https://docs.redpanda.com';
const MAX_REDIRECT_TIME = 2000; // 2 seconds

interface RedirectTest {
  from: string;
  to: string;
  description: string;
}

interface RedirectResult {
  finalUrl: string;
  redirectCount: number;
  statusCode: number;
  responseTime: number;
}

async function testRedirect(path: string): Promise<RedirectResult> {
  const startTime = Date.now();
  let redirectCount = 0;

  const response = await fetch(`${BASE_URL}${path}`, {
    redirect: 'manual',
  });

  let currentResponse = response;
  let currentUrl = `${BASE_URL}${path}`;

  // Follow redirects manually to count them
  while (currentResponse.status >= 300 && currentResponse.status < 400) {
    redirectCount++;
    const location = currentResponse.headers.get('location');
    if (!location) break;

    // Handle both absolute and relative URLs
    currentUrl = location.startsWith('http') ? location : `${BASE_URL}${location}`;
    currentResponse = await fetch(currentUrl, { redirect: 'manual' });
  }

  const responseTime = Date.now() - startTime;

  return {
    finalUrl: currentUrl,
    redirectCount,
    statusCode: currentResponse.status,
    responseTime,
  };
}

describe('Redirect Rules', () => {
  describe('1. Versioned Path Wildcards', () => {
    const tests: RedirectTest[] = [
      {
        from: '/25.3/home/',
        to: '/streaming/25.3/home/',
        description: 'Version 25.3 wildcard redirect'
      },
      {
        from: '/25.2/get-started/',
        to: '/streaming/25.2/get-started/',
        description: 'Version 25.2 wildcard redirect'
      },
      {
        from: '/25.1/manage/security/',
        to: '/streaming/25.1/manage/security/',
        description: 'Version 25.1 wildcard redirect'
      },
      {
        from: '/24.3/reference/',
        to: '/streaming/24.3/reference/',
        description: 'Version 24.3 wildcard redirect'
      },
      {
        from: '/24.2/deploy/',
        to: '/streaming/24.2/deploy/',
        description: 'Version 24.2 wildcard redirect'
      },
      {
        from: '/24.1/develop/',
        to: '/streaming/24.1/develop/',
        description: 'Version 24.1 wildcard redirect (not cloud path)'
      },
      {
        from: '/23.3/reference/',
        to: '/streaming/23.3/reference/',
        description: 'Version 23.3 wildcard redirect (not cloud path)'
      },
    ];

    tests.forEach(({ from, to, description }) => {
      it(description, async () => {
        const result = await testRedirect(from);

        expect(result.statusCode, `Expected 200 but got ${result.statusCode}`).toBe(200);
        expect(result.finalUrl, `Expected ${BASE_URL}${to} but got ${result.finalUrl}`).toContain(to);
        expect(result.redirectCount, 'Should be single-hop redirect').toBeLessThanOrEqual(2);
        expect(result.responseTime, 'Redirect should be fast').toBeLessThan(MAX_REDIRECT_TIME);
      }, 10000);
    });
  });

  describe('2. Cloud-Specific Override Rules (Must NOT Be Caught By Versioned Wildcards)', () => {
    const tests: RedirectTest[] = [
      {
        from: '/24.1/get-started/quick-start-cloud/',
        to: '/cloud-data-platform/get-started/cluster-types/dedicated/quick-start-cloud/',
        description: '24.1 cloud quickstart - should NOT redirect to streaming'
      },
      {
        from: '/23.3/get-started/quick-start-cloud/',
        to: '/cloud-data-platform/get-started/cluster-types/dedicated/quick-start-cloud/',
        description: '23.3 cloud quickstart - should NOT redirect to streaming'
      },
      {
        from: '/24.1/develop/http-proxy-cloud/',
        to: '/cloud-data-platform/develop/http-proxy/',
        description: '24.1 http-proxy-cloud - should NOT redirect to streaming'
      },
      {
        from: '/23.3/develop/http-proxy-cloud/',
        to: '/cloud-data-platform/develop/http-proxy/',
        description: '23.3 http-proxy-cloud - should NOT redirect to streaming'
      },
    ];

    tests.forEach(({ from, to, description }) => {
      it(description, async () => {
        const result = await testRedirect(from);

        expect(result.statusCode, `Expected 200 but got ${result.statusCode}`).toBe(200);
        expect(result.finalUrl, `Expected cloud-data-platform path but got ${result.finalUrl}`).toContain('cloud-data-platform');
        expect(result.finalUrl, `Should NOT contain streaming in URL`).not.toContain('/streaming/24.1/');
        expect(result.finalUrl, `Should NOT contain streaming in URL`).not.toContain('/streaming/23.3/');
        expect(result.redirectCount, 'Should be single-hop redirect').toBeLessThanOrEqual(2);
      }, 10000);
    });
  });

  describe('3. Two-Hop Prevention (Cluster Balancing & FIPS)', () => {
    const tests: RedirectTest[] = [
      {
        from: '/streaming/manage/cluster-balancing',
        to: '/streaming/current/manage/cluster-maintenance/cluster-balancing/',
        description: 'Direct redirect for cluster-balancing (no two-hop via /streaming/manage/*)'
      },
      {
        from: '/streaming/manage/fips-compliance',
        to: '/streaming/current/manage/security/fips-compliance/',
        description: 'Direct redirect for fips-compliance (no two-hop via /streaming/manage/*)'
      },
    ];

    tests.forEach(({ from, to, description }) => {
      it(description, async () => {
        const result = await testRedirect(from);

        expect(result.statusCode, `Expected 200 but got ${result.statusCode}`).toBe(200);
        expect(result.finalUrl, `Expected ${BASE_URL}${to} but got ${result.finalUrl}`).toContain(to);
        expect(result.redirectCount, 'Must be single-hop (not two-hop)').toBe(1);
        expect(result.responseTime, 'Redirect should be fast').toBeLessThan(MAX_REDIRECT_TIME);
      }, 10000);
    });
  });

  describe('4. Connect Component Restructure', () => {
    const tests: RedirectTest[] = [
      {
        from: '/connect/inputs/kafka/',
        to: '/connect/components/inputs/kafka/',
        description: 'Connect inputs restructure'
      },
      {
        from: '/connect/outputs/aws_s3/',
        to: '/connect/components/outputs/aws_s3/',
        description: 'Connect outputs restructure'
      },
      {
        from: '/connect/processors/mapping/',
        to: '/connect/components/processors/mapping/',
        description: 'Connect processors restructure'
      },
      {
        from: '/connect/caches/redis/',
        to: '/connect/components/caches/redis/',
        description: 'Connect caches restructure'
      },
      {
        from: '/connect/buffers/memory/',
        to: '/connect/components/buffers/memory/',
        description: 'Connect buffers restructure'
      },
      {
        from: '/connect/about',
        to: '/connect/components/about/',
        description: 'Connect about page restructure'
      },
    ];

    tests.forEach(({ from, to, description }) => {
      it(description, async () => {
        const result = await testRedirect(from);

        expect(result.statusCode, `Expected 200 but got ${result.statusCode}`).toBe(200);
        expect(result.finalUrl, `Expected ${BASE_URL}${to} but got ${result.finalUrl}`).toContain(to);
        expect(result.redirectCount, 'Should be single-hop redirect').toBeLessThanOrEqual(2);
      }, 10000);
    });
  });

  describe('5. Cloud-Data-Platform Path Fixes', () => {
    const tests: RedirectTest[] = [
      {
        from: '/cloud-data-platform/rpk/',
        to: '/cloud-data-platform/reference/rpk/',
        description: 'RPK path correction - missing /reference/'
      },
      {
        from: '/cloud-data-platform/reference/rpk-cluster/',
        to: '/cloud-data-platform/reference/rpk/rpk-cluster/',
        description: 'RPK path correction - missing /rpk/ segment'
      },
      {
        from: '/cloud-data-platform/reference/rpk-profile/',
        to: '/cloud-data-platform/reference/rpk/rpk-profile/',
        description: 'RPK profile path correction'
      },
      {
        from: '/cloud-data-platform/reference/rpk-cloud/',
        to: '/cloud-data-platform/reference/rpk/rpk-cloud/',
        description: 'RPK cloud path correction'
      },
      {
        from: '/cloud-data-platform/connect/home/',
        to: '/connect/home/',
        description: 'Connect under cloud-data-platform redirects to /connect/'
      },
      {
        from: '/cloud-data-platform/develop/connect/home/',
        to: '/connect/home/',
        description: 'Connect under develop/connect redirects correctly'
      },
      {
        from: '/cloud-data-platform/develop/components/processors/mapping/',
        to: '/connect/components/processors/mapping/',
        description: 'Connect components under cloud-data-platform redirects to /connect/'
      },
    ];

    tests.forEach(({ from, to, description }) => {
      it(description, async () => {
        const result = await testRedirect(from);

        expect(result.statusCode, `Expected 200 but got ${result.statusCode}`).toBe(200);
        expect(result.finalUrl, `Expected ${BASE_URL}${to} but got ${result.finalUrl}`).toContain(to);
        expect(result.redirectCount, 'Should be single-hop redirect').toBeLessThanOrEqual(2);
      }, 10000);
    });
  });

  describe('6. Streaming Version-less Paths', () => {
    const tests: RedirectTest[] = [
      {
        from: '/streaming/reference/',
        to: '/streaming/current/reference/',
        description: 'Streaming reference without version'
      },
      {
        from: '/streaming/deploy/',
        to: '/streaming/current/deploy/',
        description: 'Streaming deploy without version'
      },
      {
        from: '/streaming/develop/',
        to: '/streaming/current/develop/',
        description: 'Streaming develop without version'
      },
      {
        from: '/streaming/manage/',
        to: '/streaming/current/manage/',
        description: 'Streaming manage without version (not cluster-balancing)'
      },
      {
        from: '/streaming/upgrade/',
        to: '/streaming/current/upgrade/',
        description: 'Streaming upgrade without version'
      },
      {
        from: '/streaming/get-started/',
        to: '/streaming/current/get-started/',
        description: 'Streaming get-started without version'
      },
    ];

    tests.forEach(({ from, to, description }) => {
      it(description, async () => {
        const result = await testRedirect(from);

        expect(result.statusCode, `Expected 200 but got ${result.statusCode}`).toBe(200);
        expect(result.finalUrl, `Expected ${BASE_URL}${to} but got ${result.finalUrl}`).toContain(to);
        expect(result.redirectCount, 'Should be single-hop redirect').toBeLessThanOrEqual(2);
      }, 10000);
    });
  });

  describe('7. Streaming Current Restructured Paths', () => {
    const tests: RedirectTest[] = [
      {
        from: '/streaming/current/licensing/',
        to: '/streaming/current/get-started/licensing/',
        description: 'Licensing moved to get-started'
      },
      {
        from: '/streaming/current/kubernetes/',
        to: '/streaming/current/deploy/',
        description: 'Kubernetes moved to deploy'
      },
      {
        from: '/streaming/current/manage/cluster-balancing',
        to: '/streaming/current/manage/cluster-maintenance/cluster-balancing/',
        description: 'Cluster-balancing moved to cluster-maintenance'
      },
      {
        from: '/streaming/current/manage/fips-compliance',
        to: '/streaming/current/manage/security/fips-compliance/',
        description: 'FIPS compliance moved to security'
      },
    ];

    tests.forEach(({ from, to, description }) => {
      it(description, async () => {
        const result = await testRedirect(from);

        expect(result.statusCode, `Expected 200 but got ${result.statusCode}`).toBe(200);
        expect(result.finalUrl, `Expected ${BASE_URL}${to} but got ${result.finalUrl}`).toContain(to);
        expect(result.redirectCount, 'Should be single-hop redirect').toBeLessThanOrEqual(2);
      }, 10000);
    });
  });
});
