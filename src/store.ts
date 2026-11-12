import { features, type Report } from './contract';

/** The report's row, flattened to one column per field, plus the two fields the collector adds. */
function row(report: Report, receivedDay: string, country: string | null): Record<string, string | number | null> {
  const bit = (value: boolean) => (value ? 1 : 0);
  return {
    received_day: receivedDay,
    country,
    v: report.v,
    week: report.week,
    channel: report.channel,
    app_version: report.app_version,
    os_version: report.os_version,
    device_model: report.device_model,
    language: report.language,
    region: report.region,
    install_day: report.install_day,
    days_active: report.days_active,
    first_report_of_month: bit(report.first_report_of_month),
    servers_hermes: report.servers.hermes,
    servers_webui: report.servers.webui,
    server_versions: JSON.stringify(report.servers.versions),
    completed_responses: report.completed_responses,
    ...Object.fromEntries(features.map(name => [`feature_${name}`, bit(report.features[name])])),
    setting_push_enabled: bit(report.settings.push_enabled),
    setting_app_lock: bit(report.settings.app_lock),
    ...Object.fromEntries((['tip', 'star'] as const).flatMap(card => (['shown', 'dismissed', 'link_opened'] as const)
      .map(field => [`card_${card}_${field}`, bit(report.cards[card][field])]))),
  };
}

/** Stores one accepted report. `country` is Cloudflare's two-character code for the request, when it has one. */
export async function storeReport(db: D1Database, report: Report, receivedDay: string, country: string | null): Promise<void> {
  const fields = row(report, receivedDay, country);
  const columns = Object.keys(fields);
  await db.prepare(`INSERT INTO reports (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .bind(...Object.values(fields))
    .run();
}
