import { features } from './contract';

// The owner's private page: plain server-rendered tables with inline bars, scoped to the
// latest `?weeks=` report weeks (12 by default). Every count is "reports received"; nothing
// proves two reports came from different phones.

const groups = ['hermes', 'webui', 'mixed', 'none'] as const;
type Group = (typeof groups)[number];
const groupLabels: Record<Group, string> = { hermes: 'Hermes only', webui: 'webui only', mixed: 'Mixed', none: 'No server' };
const groupSql = `CASE WHEN servers_hermes > 0 AND servers_webui > 0 THEN 'mixed' WHEN servers_hermes > 0 THEN 'hermes'
  WHEN servers_webui > 0 THEN 'webui' ELSE 'none' END`;
const cards = ['tip', 'star'] as const;
const cardSteps = ['shown', 'dismissed', 'link_opened'] as const;
const settings = ['push_enabled', 'app_lock'] as const;

interface WeekRow { week: string; reports: number; first_of_month: number; responses: number; hermes: number; webui: number; mixed: number; none: number }
interface CohortRow { install_day: string; week: string; reports: number }
interface VersionRow { kind: string; version: string; reports: number }
interface CountRow { label: string; reports: number }
type GroupRow = { grp: Group; reports: number } & Record<string, number>;
type CardRow = Record<string, number>;

/** Monday of an ISO week (`2026-W46`), as a UTC date. */
function mondayOf(week: string): Date {
  const [year = 0, number = 0] = week.split('-W').map(Number);
  const january4 = new Date(Date.UTC(year, 0, 4));
  const firstMonday = january4.getTime() - ((january4.getUTCDay() + 6) % 7) * 86_400_000;
  return new Date(firstMonday + (number - 1) * 7 * 86_400_000);
}

/** The ISO week (`2026-W46`) containing a `YYYY-MM-DD` day. */
function weekOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const thursday = new Date(date.getTime() + (3 - ((date.getUTCDay() + 6) % 7)) * 86_400_000);
  const year = thursday.getUTCFullYear();
  const number = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000)) + 1;
  return `${year}-W${String(number).padStart(2, '0')}`;
}

const weeksBetween = (from: string, to: string) => Math.round((mondayOf(to).getTime() - mondayOf(from).getTime()) / (7 * 86_400_000));

function escape(value: string | number): string {
  return String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '–');
const bar = (value: number, max: number) => `<span class="bar" style="width:${max ? Math.round((value / max) * 240) : 0}px"></span>`;

function table(title: string, headers: string[], rows: (string | number)[][], note?: string): string {
  return `<section><h2>${escape(title)}</h2>${note ? `<p class="note">${escape(note)}</p>` : ''}<table>
<thead><tr>${headers.map(header => `<th>${escape(header)}</th>`).join('')}</tr></thead>
<tbody>${rows.map(cells => `<tr>${cells.map(cell => `<td>${typeof cell === 'number' ? escape(cell) : cell}</td>`).join('')}</tr>`).join('\n')}</tbody>
</table></section>`;
}

/** A counted list with a bar per row, largest first. */
function spread(title: string, rows: CountRow[]): string {
  const max = Math.max(0, ...rows.map(row => row.reports));
  return table(title, ['', 'Reports received', ''], rows.map(row => [escape(row.label), row.reports, bar(row.reports, max)]));
}

export async function renderDashboard(db: D1Database, url: URL): Promise<Response> {
  const requested = Number.parseInt(url.searchParams.get('weeks') ?? '', 10);
  const scope = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 520) : 12;
  const { results: scopeWeeks } = await db.prepare('SELECT DISTINCT week FROM reports ORDER BY week DESC LIMIT ?').bind(scope).all<{ week: string }>();
  const since = scopeWeeks.at(-1)?.week;
  if (!since) return page(scope, '<p>No reports received yet.</p>');

  const query = <T>(sql: string) => db.prepare(sql).bind(since).all<T>().then(result => result.results);
  const [weekly, cohorts, versions, gateways, appVersions, osVersions, serverCounts, byGroup, [cardTotals]] = await Promise.all([
    query<WeekRow>(`SELECT week, COUNT(*) AS reports, SUM(first_report_of_month) AS first_of_month, SUM(completed_responses) AS responses,
      ${groups.map(group => `SUM(${groupSql} = '${group}') AS ${group}`).join(', ')}
      FROM reports WHERE week >= ? GROUP BY week ORDER BY week DESC`),
    query<CohortRow>('SELECT install_day, week, COUNT(*) AS reports FROM reports WHERE week >= ? GROUP BY install_day, week'),
    query<VersionRow>(`SELECT json_extract(entry.value, '$.kind') AS kind, json_extract(entry.value, '$.version') AS version, COUNT(DISTINCT reports.id) AS reports
      FROM reports, json_each(reports.server_versions) AS entry WHERE week >= ? GROUP BY kind, version ORDER BY kind, reports DESC`),
    query<CountRow>(`SELECT COALESCE(json_extract(entry.value, '$.gateway'), 'not reported (format 1)') AS label, COUNT(DISTINCT reports.id) AS reports
      FROM reports, json_each(reports.server_versions) AS entry WHERE week >= ? AND json_extract(entry.value, '$.kind') = 'hermes'
      GROUP BY label ORDER BY reports DESC`),
    query<CountRow>(`SELECT channel || ' ' || app_version AS label, COUNT(*) AS reports FROM reports WHERE week >= ? GROUP BY label ORDER BY reports DESC`),
    query<CountRow>('SELECT os_version AS label, COUNT(*) AS reports FROM reports WHERE week >= ? GROUP BY label ORDER BY reports DESC'),
    query<CountRow>(`SELECT CASE WHEN servers_hermes + servers_webui >= 5 THEN '5 or more' ELSE CAST(servers_hermes + servers_webui AS TEXT) END AS label,
      COUNT(*) AS reports FROM reports WHERE week >= ? GROUP BY label ORDER BY label`),
    query<GroupRow>(`SELECT ${groupSql} AS grp, COUNT(*) AS reports,
      ${[...features.map(name => `feature_${name}`), ...settings.map(name => `setting_${name}`)].map(column => `SUM(${column}) AS ${column}`).join(', ')}
      FROM reports WHERE week >= ? GROUP BY grp`),
    query<CardRow>(`SELECT ${cards.flatMap(card => cardSteps.map(step => `SUM(card_${card}_${step}) AS card_${card}_${step}`)).join(', ')}
      FROM reports WHERE week >= ?`),
  ]);

  const sections: string[] = [];
  const maxWeekly = Math.max(0, ...weekly.map(row => row.reports));
  sections.push(table('Reports received per week', ['Week', 'Reports received', ''],
    weekly.map(row => [escape(row.week), row.reports, bar(row.reports, maxWeekly)])));

  const months = new Map<string, number>();
  for (const row of weekly) {
    const month = mondayOf(row.week).toISOString().slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + row.first_of_month);
  }
  sections.push(table('Reports received per month', ['Month', 'First reports of the month'], [...months].map(([month, reports]) => [escape(month), reports]),
    'Reports marked first of their month, grouped by the month of the report week\'s Monday. The oldest month in scope can be partial.'));

  const latest = scopeWeeks[0]?.week ?? since;
  const cohortCells = new Map<string, number[]>();
  for (const row of cohorts) {
    const cohort = weekOf(row.install_day);
    const offset = weeksBetween(cohort, row.week);
    if (offset < 0) continue;
    const cells = cohortCells.get(cohort) ?? [];
    cells[offset] = (cells[offset] ?? 0) + row.reports;
    cohortCells.set(cohort, cells);
  }
  const span = Math.min(Math.max(0, ...[...cohortCells.keys()].map(cohort => weeksBetween(cohort, latest))), scope - 1);
  sections.push(table('Retention by install week', ['Install week', ...Array.from({ length: span + 1 }, (_, week) => `+${week}`)],
    [...cohortCells].sort(([a], [b]) => (a < b ? 1 : -1)).map(([cohort, cells]) => [escape(cohort), ...Array.from({ length: span + 1 }, (_, week) => cells[week] ?? '')]),
    'Reports received for each install week, by weeks since install. Install day resets on reinstall.'));

  sections.push(table('Hermes and webui per week', ['Week', ...groups.map(group => groupLabels[group])],
    weekly.map(row => [escape(row.week), ...groups.map(group => `${row[group]} <span class="dim">${percent(row[group], row.reports)}</span>`)])));

  const kinds = [...new Set(versions.map(row => row.kind))];
  for (const kind of kinds) {
    sections.push(spread(`${kind === 'hermes' ? 'Hermes' : 'webui'} server versions`, versions.filter(row => row.kind === kind).map(row => ({ label: row.version, reports: row.reports }))));
  }

  if (gateways.length) sections.push(spread('Hermes server gateways', gateways));

  const groupTotals = new Map(byGroup.map(row => [row.grp, row]));
  const shownGroups = groups.filter(group => groupTotals.has(group));
  const usageRow = (label: string, column: string) => [escape(label), ...shownGroups.map(group => {
    const row = groupTotals.get(group);
    return row ? `${row[column] ?? 0} <span class="dim">${percent(row[column] ?? 0, row.reports)}</span>` : '';
  })];
  sections.push(table('Feature usage by server mix', ['Feature', ...shownGroups.map(group => `${groupLabels[group]} (${groupTotals.get(group)?.reports ?? 0})`)],
    [...features.map(name => usageRow(name, `feature_${name}`)), ...settings.map(name => usageRow(`setting: ${name}`, `setting_${name}`))],
    'Reports in which the feature was used that week (features) or the setting was on when the report was built (settings).'));

  sections.push(table('Card funnel', ['Card', 'Shown', 'Dismissed', 'Link opened'], cards.map(card => {
    const shown = cardTotals?.[`card_${card}_shown`] ?? 0;
    return [escape(card), shown, ...(['dismissed', 'link_opened'] as const).map(step => {
      const value = cardTotals?.[`card_${card}_${step}`] ?? 0;
      return `${value} <span class="dim">${percent(value, shown)}</span>`;
    })];
  })));

  sections.push(spread('App versions', appVersions), spread('iOS versions', osVersions));

  sections.push(table('Completed responses per week', ['Week', 'Total', 'Per report'],
    weekly.map(row => [escape(row.week), row.responses, row.reports ? Math.round(row.responses / row.reports) : 0])));
  sections.push(spread('Servers configured', serverCounts));

  return page(scope, `<p class="note">Latest ${scopeWeeks.length} report week${scopeWeeks.length === 1 ? '' : 's'} (${escape(since)} to ${escape(latest)}).
Every count is reports received: nothing proves two reports came from different phones.</p>${sections.join('\n')}`);
}

function page(scope: number, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hermex usage reports</title><style>
:root { color-scheme: light dark; font: 14px/1.4 -apple-system, system-ui, sans-serif; }
body { max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.05rem; margin: 2rem 0 .4rem; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: .25rem .6rem .25rem 0; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
td { white-space: nowrap; } .bar { display: inline-block; height: .7rem; background: #4f7cff; border-radius: 2px; }
.dim, .note { opacity: .6; } form { margin: 1rem 0; }
</style></head><body><h1>Hermex usage reports</h1>
<form><label>Report weeks <input name="weeks" type="number" min="1" max="520" value="${scope}"></label> <button>Show</button></form>
${body}</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
