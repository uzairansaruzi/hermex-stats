import { hasAccess, type AccessEnv } from './access';
import { parseReport } from './contract';
import { renderDashboard } from './dashboard';
import { storeReport } from './store';

export interface Env extends AccessEnv {
  DB: D1Database;
}

const maxBodyBytes = 8 * 1024;

function empty(status: number) {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

/** The parsed body, `null` when it is not UTF-8 JSON, or `tooLarge` (checked before parsing). */
async function readJson(request: Request): Promise<{ tooLarge: true } | { tooLarge: false; body: unknown }> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > maxBodyBytes) return { tooLarge: true };
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (reader) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBodyBytes) { await reader.cancel(); return { tooLarge: true }; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return { tooLarge: false, body: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) };
  } catch {
    return { tooLarge: false, body: null };
  }
}

async function acceptReport(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return empty(415);
  const read = await readJson(request);
  if (read.tooLarge) return empty(413);
  const report = parseReport(read.body);
  if (!report) return empty(400);
  // Day only, and only Cloudflare's country code: never the connecting address or a finer time.
  const country = request.cf?.country;
  await storeReport(env.DB, report, new Date().toISOString().slice(0, 10), typeof country === 'string' && /^[A-Z0-9]{2}$/.test(country) ? country : null);
  return empty(204);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/v1/report') return request.method === 'POST' ? acceptReport(request, env) : empty(405);
    // Everything else is the owner's: refuse it unless Access vouches for the request.
    if (!await hasAccess(request, env)) return empty(403);
    if (url.pathname === '/' && request.method === 'GET') return renderDashboard(env.DB, url);
    return empty(404);
  },
} satisfies ExportedHandler<Env>;
