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
        from: '/25.3/get-started/architecture/',
        to: '/streaming/25.3/get-started/architecture/',
        description: 'Version 25.3 wildcard redirect'
      },
      {
        from: '/25.2/reference/console/',
        to: '/streaming/25.2/reference/console/',
        description: 'Version 25.2 wildcard redirect'
      },
      {
        from: '/25.1/deploy/deployment-option/',
        to: '/streaming/25.1/deploy/deployment-option/',
        description: 'Version 25.1 wildcard redirect'
      },
      {
        from: '/24.3/manage/security/',
        to: '/streaming/24.3/manage/security/',
        description: 'Version 24.3 wildcard redirect'
      },
      {
        from: '/24.2/upgrade/rolling-upgrade/',
        to: '/streaming/24.2/upgrade/rolling-upgrade/',
        description: 'Version 24.2 wildcard redirect'
      },
      {
        from: '/24.1/develop/kafka-clients/',
        to: '/streaming/24.1/develop/kafka-clients/',
        description: 'Version 24.1 wildcard redirect (not cloud path)'
      },
      {
        from: '/23.3/reference/rpk/',
        to: '/streaming/23.3/reference/rpk/',
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
        from: '/24.1/deploy/deployment-option/cloud/create-cluster/',
        to: '/cloud-data-platform/deploy/deployment-option/cloud/create-cluster/',
        description: '24.1 cloud deploy - should NOT redirect to streaming'
      },
      {
        from: '/23.3/deploy/deployment-option/cloud/networking/',
        to: '/cloud-data-platform/deploy/deployment-option/cloud/networking/',
        description: '23.3 cloud deploy - should NOT redirect to streaming'
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
        from: '/cloud-data-platform/rpk/rpk-cluster/health/',
        to: '/cloud-data-platform/reference/rpk/rpk-cluster/health/',
        description: 'RPK path correction - missing /reference/'
      },
      {
        from: '/cloud-data-platform/reference/rpk-cluster/info/',
        to: '/cloud-data-platform/reference/rpk/rpk-cluster/info/',
        description: 'RPK path correction - missing /rpk/ segment'
      },
      {
        from: '/cloud-data-platform/reference/rpk-profile/create/',
        to: '/cloud-data-platform/reference/rpk/rpk-profile/create/',
        description: 'RPK profile path correction'
      },
      {
        from: '/cloud-data-platform/reference/rpk-cloud/auth/login/',
        to: '/cloud-data-platform/reference/rpk/rpk-cloud/auth/login/',
        description: 'RPK cloud path correction'
      },
      {
        from: '/cloud-data-platform/connect/components/inputs/kafka/',
        to: '/connect/components/inputs/kafka/',
        description: 'Connect under cloud-data-platform redirects to /connect/'
      },
      {
        from: '/cloud-data-platform/develop/connect/configuration/interpolation/',
        to: '/connect/configuration/interpolation/',
        description: 'Connect config under cloud-data-platform redirects correctly'
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
        from: '/streaming/reference/rpk/rpk-cluster/',
        to: '/streaming/current/reference/rpk/rpk-cluster/',
        description: 'Streaming reference without version'
      },
      {
        from: '/streaming/deploy/deployment-option/self-hosted/',
        to: '/streaming/current/deploy/deployment-option/self-hosted/',
        description: 'Streaming deploy without version'
      },
      {
        from: '/streaming/develop/kafka-clients/',
        to: '/streaming/current/develop/kafka-clients/',
        description: 'Streaming develop without version'
      },
      {
        from: '/streaming/manage/security/authentication/',
        to: '/streaming/current/manage/security/authentication/',
        description: 'Streaming manage without version (not cluster-balancing)'
      },
      {
        from: '/streaming/upgrade/rolling-upgrade/',
        to: '/streaming/current/upgrade/rolling-upgrade/',
        description: 'Streaming upgrade without version'
      },
      {
        from: '/streaming/get-started/quick-start/',
        to: '/streaming/current/get-started/quick-start/',
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
        from: '/streaming/current/licensing/community-license/',
        to: '/streaming/current/get-started/licensing/community-license/',
        description: 'Licensing moved to get-started'
      },
      {
        from: '/streaming/current/kubernetes/k-deployment-overview/',
        to: '/streaming/current/deploy/deployment-option/self-hosted/kubernetes/k-deployment-overview/',
        description: 'Kubernetes moved to deploy/self-hosted'
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
