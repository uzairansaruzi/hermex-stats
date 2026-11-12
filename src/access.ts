// Verifies the Cloudflare Access token on every dashboard request, so a request that skips
// Access (another hostname, a forged header) is refused by the Worker itself.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

export interface AccessEnv {
  /** The Zero Trust team domain, such as `example.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Audience (AUD) tag of the dashboard's Access application. */
  ACCESS_AUD: string;
}

interface Jwk extends JsonWebKey { kid?: string }

// The team's signing keys, cached per isolate. A token signed by an unknown key refetches once,
// which picks up Access key rotation.
let cachedKeys: { domain: string; keys: Map<string, CryptoKey> } | undefined;

async function signingKeys(domain: string, refresh: boolean): Promise<Map<string, CryptoKey>> {
  if (!refresh && cachedKeys?.domain === domain) return cachedKeys.keys;
  const response = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error('access_certs_unavailable');
  const { keys } = await response.json<{ keys: Jwk[] }>();
  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue;
    imported.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  cachedKeys = { domain, keys: imported };
  return imported;
}

function base64url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

function decodeJson(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(base64url(value)));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_token');
  return parsed as Record<string, unknown>;
}

/** True only for a request carrying a valid, unexpired Access token for the dashboard application. */
export async function hasAccess(request: Request, env: AccessEnv): Promise<boolean> {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  try {
    const [header = '', payload = '', signature = '', ...rest] = token.split('.');
    if (rest.length) return false;
    const { alg, kid } = decodeJson(header);
    if (alg !== 'RS256' || typeof kid !== 'string') return false;
    let key = (await signingKeys(env.ACCESS_TEAM_DOMAIN, false)).get(kid);
    key ??= (await signingKeys(env.ACCESS_TEAM_DOMAIN, true)).get(kid);
    if (!key) return false;
    const signed = new TextEncoder().encode(`${header}.${payload}`);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64url(signature), signed)) return false;

    const claims = decodeJson(payload);
    const now = Date.now() / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return claims.iss === `https://${env.ACCESS_TEAM_DOMAIN}`
      && audiences.includes(env.ACCESS_AUD)
      && typeof claims.exp === 'number' && claims.exp > now
      && (claims.nbf === undefined || (typeof claims.nbf === 'number' && claims.nbf <= now));
  } catch {
    return false;
  }
}
