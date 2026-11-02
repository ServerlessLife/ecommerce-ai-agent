/**
 * bill.ts — downloads the test's ACTUAL bill: Cost Explorer filtered by the
 * cost-experiment=<test>-<platform> tag (the value printed in the stack's
 * CostTag output). Same-day costs take ~24-72 h to post.
 * Writes results/<test>/<platform>/bill/bill.csv (data,usage_type,quantity,unit,cost_usd)
 * and prints the total.
 *
 * Manual validation: open the Billing console's Cost Explorer (region
 * us-east-1 — see the client comment below), filter tag
 * cost-experiment=<tag>, "Unblended cost", Daily, group by Usage type.
 * The totals must match bill.csv; analyze.ts's ESTIMATED cost should land
 * close to this ACTUAL total once all days have posted.
 *
 * Usage: npx tsx price-perfomance-test/bill.ts --test test1 --platform lambdaweb [--start 2026-10-20 --end 2026-10-21]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { readOutput, stackNameFor } from './agent.js';

// The Cost Explorer API endpoint exists ONLY in us-east-1, regardless of the
// workload's region — the returned costs are still this stack's eu-west-1
// spend (filtered by tag below). Do not "fix" this region to eu-west-1; the
// call would fail with an unhandled parameter error.
// Manual validation: Billing console → Cost Explorer → filter tag
// cost-experiment=<tag>, metric "Unblended cost", granularity Daily,
// group by Usage type — the numbers must match bill.csv exactly.
// PREREQUISITE: the tag key `cost-experiment` must be an ACTIVATED
// cost-allocation tag (Billing → Cost allocation tags), otherwise CE returns
// no data at all (an empty, zero-total bill.csv is the symptom, not a bug).
const ce = new CostExplorerClient({ region: 'us-east-1' });

/** Test period from performance.csv: first and (last day + 1) as YYYY-MM-DD, for CE's inclusive-exclusive range. */
function datesFromCsv(test: string, platform: string): { start: string; end: string } {
  const file = path.resolve(
    import.meta.dirname,
    'results',
    test,
    platform,
    'performance',
    'performance.csv',
  );
  if (!existsSync(file)) throw new Error(`No ${file} — run send.ts first (or pass --start/--end).`);
  const rows = readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(1); // drop the header
  const dates = rows
    .map((l) => (l.split(',')[0] ?? '').slice(0, 10))
    .filter(Boolean)
    .sort();
  if (dates.length === 0) throw new Error('performance.csv has no rows.');
  const start = dates[0];
  // Cost Explorer's End is exclusive, so add one day to the last request date.
  const end = new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { start, end };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      test: { type: 'string' },
      platform: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: npx tsx price-perfomance-test/bill.ts --test <name> --platform <platform> [--start YYYY-MM-DD --end YYYY-MM-DD]',
    );
    return;
  }
  const { test, platform } = values;
  if (!test || !platform) throw new Error('--test and --platform are required.');

  const tag = readOutput(test, stackNameFor(test, platform), 'CostTag');
  const dates =
    values.start && values.end
      ? { start: values.start, end: values.end }
      : datesFromCsv(test, platform);
  console.log(
    `Bill for tag cost-experiment=${tag} from ${dates.start} to ${dates.end} (CE may take 24-72 h to post)...`,
  );

  // One row per day x usage type, grouped by USAGE_TYPE so unit costs stay visible.
  const res = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: dates.start, End: dates.end },
      Granularity: 'DAILY',
      Filter: { Tags: { Key: 'cost-experiment', Values: [tag] } },
      Metrics: ['UnblendedCost', 'UsageQuantity'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
    }),
  );

  const dir = path.resolve(import.meta.dirname, 'results', test, platform, 'bill');
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'bill.csv');

  const lines: string[] = ['data,usage_type,quantity,unit,cost_usd'];
  let total = 0;
  for (const day of res.ResultsByTime ?? []) {
    const date = (day.TimePeriod?.Start ?? '').slice(0, 10);
    for (const g of day.Groups ?? []) {
      const type = g.Keys?.[0] ?? '';
      const qty = Number(g.Metrics?.UsageQuantity?.Amount ?? 0);
      const unit = g.Metrics?.UsageQuantity?.Unit ?? '';
      const cost = Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
      total += cost;
      lines.push(`${date},${type},${qty},${unit},${cost.toFixed(6)}`);
    }
  }
  writeFileSync(out, `${lines.join('\n')}\n`);

  console.log(`${lines.length - 1} rows -> ${out}`);
  if (total === 0) {
    console.warn(
      'WARNING: zero total — the bill has not posted yet (wait 24-72 h) or there was no usage under the tag.',
    );
  } else {
    console.log(`TAG TOTAL: $${total.toFixed(6)}`);
  }
}

main().catch((e) => {
  console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
