import { z } from 'zod';

// The wire contract lives in hermex#1659 ("The report"). Every object is strict:
// an unknown key, a missing key or an out-of-limit value rejects the whole report.

const flag = z.boolean();
const count = (max: number) => z.number().int().min(0).max(max);
const release = (parts: string) => z.string().regex(new RegExp(`^\\d+(?:\\.\\d+){${parts}}$`));

/** A real calendar day as `YYYY-MM-DD`. */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
});

const card = z.strictObject({ shown: flag, dismissed: flag, link_opened: flag });

const featureSchema = z.strictObject({
  workspace: flag, tasks: flag, skills: flag, memory: flag, insights: flag, kanban: flag,
  bots: flag, share_extension: flag, home_widget: flag, live_activity: flag, voice_input: flag, app_intents: flag,
});
export type Feature = keyof typeof featureSchema.shape;
export const features = Object.keys(featureSchema.shape) as Feature[];

const reportV1 = z.strictObject({
  v: z.literal(1),
  week: z.string().regex(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/),
  channel: z.enum(['appstore', 'testflight']),
  app_version: release('1,2'),
  os_version: release('1,2'),
  device_model: z.string().max(20).regex(/^[A-Za-z0-9]+(?:,[A-Za-z0-9]+)?$/),
  language: z.string().max(16).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/),
  region: z.string().regex(/^(?:[A-Z]{2}|\d{3})$/),
  install_day: day,
  days_active: count(7),
  first_report_of_month: flag,
  servers: z.strictObject({
    hermes: count(99),
    webui: count(99),
    versions: z.array(z.strictObject({
      kind: z.enum(['hermes', 'webui']),
      version: z.union([release('1,3'), z.enum(['other', 'unknown'])]),
    })).max(20),
  }),
  completed_responses: count(100_000),
  features: featureSchema,
  settings: z.strictObject({ push_enabled: flag, app_lock: flag }),
  cards: z.strictObject({ tip: card, star: card }),
});

/** Every format version still in use, chosen by `v`. A new version appends its schema here. */
const report = z.discriminatedUnion('v', [reportV1]);
export type Report = z.infer<typeof report>;

/** The parsed report, or null when it matches no supported version exactly. */
export function parseReport(body: unknown): Report | null {
  const result = report.safeParse(body);
  return result.success ? result.data : null;
}
