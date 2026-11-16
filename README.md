# Hermex stats

The collector for [Hermex](https://github.com/uzairansaruzi/hermex)'s optional weekly usage reports: one Cloudflare Worker and one D1 database. Implements [hermex#1660](https://github.com/uzairansaruzi/hermex/issues/1660); every decision and the wire contract live in [hermex#1659](https://github.com/uzairansaruzi/hermex/issues/1659).

Usage reports are off in the app until the user allows them. Before that, the app's preview is a labelled example: real device, language, region, install day and server values, with sample weekly counts. Once reports are on, the preview is the report for the week in progress, built by the same code that sends it. This service is separate from the push relay ([hermex-push](https://github.com/uzairansaruzi/hermex-push)) so a report can never be joined to a device token.

## What is stored

One row per accepted report, kept forever. A row holds every field of the report, exactly as the contract allows them, plus two fields the collector adds:

- **Arrival day**: the UTC day the report arrived. Day only, never the time.
- **Country**: Cloudflare's two-character country code for the request (`request.cf.country`).

## What is never stored

- The IP address. The Worker never reads the connecting-address headers, and the table has no column that could hold one.
- Message text, server addresses, credentials, file names, account or device identifiers. The contract has no field for them, and a report with any field outside it is rejected whole.
- Logs. Workers logs, traces, observability and Logpush are off (`wrangler.jsonc`), so Cloudflare keeps no per-request record for this Worker either.

Cloudflare itself sees the connecting address in order to route the request and apply the rate limiting rule. Requests that rule blocks appear in the zone's Security Events with their address, as on any Cloudflare zone; accepted reports do not.

Nothing is published. The only public route is the one that accepts reports; everything else requires Cloudflare Access.

## Routes

| Method | Route | Who | Result |
| --- | --- | --- | --- |
| POST | `/v1/report` | Anyone | `204` stored; `400` not exactly a supported report; `413` over 8 KB (refused before parsing); `415` not `application/json`. No body in any reply. |
| GET | `/` | Access only | The dashboard. `?weeks=N` scopes it to the latest N report weeks (default 12). |

Every route except `POST /v1/report` checks the Cloudflare Access token itself (`Cf-Access-Jwt-Assertion`): RS256 signature against the team's public keys, issuer, the dashboard application's audience, and expiry. A request without a valid token is refused with `403`, whatever hostname it arrived on.

[`src/contract.ts`](src/contract.ts) holds one validator per supported format version, chosen by `v`. Version 1 is the only one today. A later version that adds fields adds nullable columns in a new migration; old rows are never rewritten.

## Dashboard

One server-rendered page of plain tables with inline bars: reports received per week and month, retention by install week, Hermes versus webui, server versions and Hermes server gateways, feature usage grouped by Hermes-only, webui-only and mixed phones, the tip and star card funnel, app and iOS versions, completed responses per week, and server counts. Every count is labelled "reports received": nothing proves two reports came from different phones.

## Run locally

Requires Node 22 or newer (CI uses Node 24).

```sh
npm ci
npm run check
npm run deploy:dry-run
```

Tests run in Cloudflare's Workers runtime with a local D1 database and the migrations applied. Access tokens are signed with keys generated per run; no Cloudflare credentials are needed.

## Deploy a copy

The checklist below is the owner's. A self-hosted copy follows the same steps with its own account ID, hostname and Access application.

1. **Repository.** Create the public `uzairansaruzi/hermex-stats` repository and push this one to it.
2. **Wrangler.** Run `npx wrangler login`, then `npm ci`.
3. **D1.** Run `npx wrangler d1 create hermex-stats`. Copy the printed `database_id` into `wrangler.jsonc`, replacing the zeros.
4. **Hostname.** The Worker serves only its custom domain (`workers_dev` and preview URLs are off), so every report passes the zone's rate limiting rule. `wrangler.jsonc` uses `hermex-stats.uzairansar.com`, which needs `uzairansar.com` to be a zone on this account. If it is not, pick a hostname on a zone that is and change `routes`. The first deploy creates the DNS record.
5. **Cloudflare Access** (Zero Trust → Access → Applications). The Zero Trust Free plan covers up to 50 users; confirm the account is enrolled on it.
   1. Add a **self-hosted** application named `Hermex stats dashboard` for `hermex-stats.uzairansar.com` with no path, so it covers the whole hostname. Policy: **Allow**, include your own email. Copy its **Application Audience (AUD) tag**.
   2. Add a second self-hosted application named `Hermex stats reports` for `hermex-stats.uzairansar.com` with path `v1/report`. Policy: **Bypass**, include **Everyone**. Phones post here without signing in.
   3. In `wrangler.jsonc`, set `ACCESS_TEAM_DOMAIN` to your team domain (`<team>.cloudflareaccess.com`, from Zero Trust → Settings → Custom Pages) and `ACCESS_AUD` to the dashboard application's AUD tag. Both are public values. With either empty, the dashboard refuses every request.
6. **Rate limiting** (the `uzairansar.com` zone → Security → WAF → Rate limiting rules → Create rule). Name `Hermex stats reports`. Expression: `(http.host eq "hermex-stats.uzairansar.com" and http.request.uri.path eq "/v1/report")`. Counting by IP (the only choice on the Free plan), 10 requests per 10 seconds, action **Block** for 10 seconds. A phone sends one report a week and never retries, so this only stops floods.
7. **Logging off.** Leave `observability` and `logpush` disabled in `wrangler.jsonc`. After deploying, confirm in Workers & Pages → `hermex-stats` → Settings → Observability that Workers Logs and Traces are off, that no Logpush job targets this Worker, and never run `wrangler tail` against it.
8. **Deploy.** Run `npm run check` and `npm run deploy:dry-run`, then `npm run deploy`. The script checks again, applies the D1 migrations to the remote database, and deploys.
9. **Smoke.** Post a test report in a week no phone will send, and confirm it lands:

   ```sh
   node -e 'const r = require("./test/example-report.json"); r.week = "2000-W01"; console.log(JSON.stringify(r))' |
     curl -si https://hermex-stats.uzairansar.com/v1/report -H 'content-type: application/json' --data-binary @-
   ```

   Expect `HTTP/2 204`. Open `https://hermex-stats.uzairansar.com/?weeks=520` in a browser, sign in through Access, and find `2000-W01`. Then delete the test row:

   ```sh
   npx wrangler d1 execute hermex-stats --remote --command "DELETE FROM reports WHERE week = '2000-W01'"
   ```

10. **Hand the URL to the app.** Record `https://hermex-stats.uzairansar.com/v1/report` on [hermex#1659](https://github.com/uzairansaruzi/hermex/issues/1659); the app builds it in as a fixed address.

## License

MIT
