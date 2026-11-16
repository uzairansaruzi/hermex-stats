import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import source from '../src/index?raw';
import accessSource from '../src/access?raw';
import storeSource from '../src/store?raw';
// The example report from hermex#1659, verbatim.
import report from './example-report.json';

const team = env.ACCESS_TEAM_DOMAIN;
const audience = env.ACCESS_AUD;

function post(body: unknown, headers: Record<string, string> = {}, cf?: { country: string }) {
  const request = new Request('https://stats.test/v1/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    cf,
  });
  return worker.fetch(request, env);
}

const rows = async () => (await env.DB.prepare('SELECT * FROM reports').all<Record<string, unknown>>()).results;

// Access signs tokens with RS256; the test plays the team's certs endpoint.
const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const teamKey = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']) as CryptoKeyPair;
const otherKey = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']) as CryptoKeyPair;
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', teamKey.publicKey) as JsonWebKey), kid: 'team-key' };

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeJson = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));

async function token(claims: Record<string, unknown> = {}, key = teamKey.privateKey) {
  const unsigned = `${encodeJson({ alg: 'RS256', kid: 'team-key' })}.${encodeJson({
    iss: `https://${team}`, aud: [audience], exp: Date.now() / 1000 + 300, iat: Date.now() / 1000, ...claims,
  })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${encode(new Uint8Array(signature))}`;
}

function dashboard(jwt?: string, host = 'stats.test') {
  return worker.fetch(new Request(`https://${host}/`, { headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} }), env);
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM reports');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `https://${team}/cdn-cgi/access/certs`) return Response.json({ keys: [publicJwk] });
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); });

it('stores the example report with its arrival day and country', async () => {
  const response = await post(report, {}, { country: 'NZ' });
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
  const [row] = await rows();
  expect(row).toMatchObject({
    received_day: new Date().toISOString().slice(0, 10),
    country: 'NZ',
    week: '2026-W46',
    servers_hermes: 1,
    feature_workspace: 1,
    feature_tasks: 0,
    card_tip_shown: 1,
  });
  expect(JSON.parse(String(row?.server_versions))).toEqual(report.servers.versions);
});

it('rejects a report that does not match the contract exactly and stores nothing', async () => {
  const { region: _region, ...missing } = report;
  const invalid = [
    { ...report, device_id: 'abc' },
    missing,
    { ...report, days_active: '5' },
    { ...report, servers: { ...report.servers, versions: [{ kind: 'hermes', version: 'mac.tailnet.ts.net' }] } },
    { ...report, features: { ...report.features, extra: true } },
    { ...report, v: 2 },
    'not json',
  ];
  for (const body of invalid) expect((await post(body)).status).toBe(400);
  expect(await rows()).toEqual([]);
});

it('accepts format 2 only with each server\'s gateway, and format 1 only without', async () => {
  const withGateway = report.servers.versions.map((entry, index) => ({ ...entry, gateway: index ? 'unknown' : 'webapp' }));
  const v2 = { ...report, v: 2, servers: { ...report.servers, versions: withGateway } };
  expect((await post({ ...v2, servers: report.servers })).status).toBe(400);
  expect((await post({ ...report, servers: v2.servers })).status).toBe(400);
  expect((await post(v2)).status).toBe(204);
  const [row] = await rows();
  expect(JSON.parse(String(row?.server_versions))).toEqual(withGateway);
});

it('refuses a body over 8 KB', async () => {
  const response = await post({ ...report, padding: 'x'.repeat(8 * 1024) });
  expect(response.status).toBe(413);
  expect(await rows()).toEqual([]);
});

it('never stores or reads the connecting address', async () => {
  const address = '203.0.113.77';
  await post(report, { 'cf-connecting-ip': address, 'x-forwarded-for': address, 'x-real-ip': address, 'true-client-ip': address });
  expect(JSON.stringify(await rows())).not.toContain(address);
  const columns = (await env.DB.prepare("SELECT name FROM pragma_table_info('reports')").all<{ name: string }>()).results.map(column => column.name);
  expect(columns.filter(name => /(^|_)(ip|addr|address|host|hostname|user_agent)(_|$)/.test(name))).toEqual([]);
  for (const code of [source, accessSource, storeSource]) expect(code).not.toMatch(/connecting-ip|forwarded|real-ip|client-ip/i);
});

it('serves the dashboard only for a valid Access token', async () => {
  await post(report);
  const refused = [
    undefined,
    await token({}, otherKey.privateKey),
    await token({ exp: Date.now() / 1000 - 1 }),
    await token({ aud: ['another-application'] }),
    await token({ iss: 'https://another-team.cloudflareaccess.com' }),
  ];
  for (const jwt of refused) expect((await dashboard(jwt)).status).toBe(403);
  // Reaching the Worker by another hostname changes nothing without a token.
  expect((await dashboard(undefined, 'hermex-stats.example.workers.dev')).status).toBe(403);

  const response = await dashboard(await token());
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('2026-W46');
});
