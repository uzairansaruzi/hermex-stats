import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          ACCESS_TEAM_DOMAIN: 'hermex-test.cloudflareaccess.com',
          ACCESS_AUD: 'test-dashboard-aud',
        },
      },
    })],
    test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/apply-migrations.ts'] },
  };
});
