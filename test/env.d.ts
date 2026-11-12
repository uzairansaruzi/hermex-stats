import type { D1Migration } from 'cloudflare:test';
import type { Env as StatsEnv } from '../src/index';

declare global {
  namespace Cloudflare {
    interface Env extends StatsEnv { TEST_MIGRATIONS: D1Migration[] }
  }
}
