import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent-friendly docs checks require network calls and can take a while
    testTimeout: 120000, // 2 minutes
    hookTimeout: 30000,
  },
});
