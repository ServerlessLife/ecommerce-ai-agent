/**
 * analyze.ts — reads performance.csv (speed) and logs.csv (usage/cost) for a test+platform,
 * prints the result, and writes results/<test>/<platform>/analysis.csv.
 * Without --platform: scans the platforms that have results for the test, prints the
 * comparison, and writes results/<test>/comparison.csv.
 * In BOTH modes it also writes results/<test>/speed.csv — the latency detail
 * (first question of a session vs follow-ups vs the sequential question
 * numbers) that report.ts renders. All latency/cost CALCULATION lives here;
 * report.ts only formats the CSVs into markdown.
 *
 * Costs (published eu-west-1 / EU (Ireland) Arm prices, verified against the
 * AWS Price List API: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/):
 *   lambdaevent: $0.20 per 1M requests + $0.0000133334 per GB-s (fixed 1024 MB)
 *   lambdaweb:   $0.30 per 1M requests + $0.0000291572 per vCPU-s + $0.0000038603 per GB-s (peak x environment lifetime)
 *   agentcorev1: $0.0895 per vCPU-h + $0.00945 per GB-h
 *   agentcorev2: $0.1276 per vCPU-h + $0.0169 per GB-h
 * Excluded for everyone (identical): model tokens, Titan embeddings, data transfer.
 *
 * Usage: npx tsx price-perfomance-test/analyze.ts --test test1 [--platform lambdaweb]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PLATFORMS } from './agent.js';

/**
 * Official AWS Price List rates for THIS deployment's region: eu-west-1
 * (EU (Ireland)), Arm/Graviton architecture. Do NOT copy numbers from the
 * marketing pages without checking the region — they default to us-east-1,
 * which is cheaper (e.g. lambdaweb us-east-1 $0.0000276944/vCPU-s vs
 * eu-west-1 $0.0000291572/vCPU-s).
 *
 * Manual validation — query the AWS Price List API regional files (each command
 * prints the exact usage types these rates came from; jq required):
 *
 *   Lambda (20261016182359 = price-list publication used on 2026-10-21):
 *     curl -s https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/20261016182359/eu-west-1/index.json \
 *       | jq -r '.products as $p | .terms.OnDemand | to_entries[] | .value as $t |
 *                $p[.key] as $prod | $t | to_entries[] | .value.priceDimensions | to_entries[] |
 *                select($prod.attributes.usagetype | test("ARM$")) |
 *                [$prod.attributes.usagetype, .value.pricePerUnit.USD] | @tsv' | sort -u
 *
 *   AgentCore Runtime (20261019233318 = publication used on 2026-10-21):
 *     curl -s https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockAgentCore/20261019233318/eu-west-1/index.json \
 *       | jq -r '.products as $p | .terms.OnDemand | to_entries[] | .value as $t |
 *                $p[.key] as $prod | $t | to_entries[] | .value.priceDimensions | to_entries[] |
 *                select($prod.attributes.usagetype | test("Runtime:Consumption")) |
 *                [$prod.attributes.usagetype, .value.pricePerUnit.USD] | @tsv' | sort -u
 *
 * Verified rates (2026-10-21) and their Price List usage types:
 *   lambdaevent: "EU-Request-ARM"                     $0.0000002/req      (= $0.20/1M)
 *                "EU-Lambda-GB-Second-ARM" Tier 1     $0.0000133334/GB-s
 *                (Tier 2 $0.0000120001 only above 7.5B GB-s/month, Tier 3
 *                $0.0000106667 above 18.75B — a test run never gets there)
 *   lambdaweb:   "EU-Lambda-Web-Request-ARM"          $0.0000003/req      (= $0.30/1M)
 *                "EU-Lambda-Web-vCPU-Second-ARM"      $0.0000291572/vCPU-s
 *                "EU-Lambda-Web-Memory-GB-Second-ARM" $0.0000038603/GB-s
 *   agentcorev1: "EU-Runtime:Consumption-based:vCPU"   $0.0895/vCPU-h
 *                "EU-Runtime:Consumption-based:Memory" $0.00945/GB-h
 *   agentcorev2: "EU-Runtime:Consumption-based:vCPU-v2"  $0.1276/vCPU-h
 *                "EU-Runtime:Consumption-based:Memory-v2" $0.0169/GB-h
 *
 * Cross-check option: bill.ts reports the ACTUAL tagged spend (Cost Explorer);
 * after 24-72 h it should closely match these estimates.
 */
const RATES = {
  lambdaevent: { request: 0.2 / 1e6, gbS: 0.0000133334, memoryGb: 1.0 },
  lambdaweb: { request: 0.3 / 1e6, vcpuS: 0.0000291572, gbS: 0.0000038603 },
  agentcorev1: { vcpuH: 0.0895, gbH: 0.00945 },
  agentcorev2: { vcpuH: 0.1276, gbH: 0.0169 },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const usd = (n: number): string => `$${n.toFixed(6)}`;

/** NaN/Infinity anywhere means a calculation failed — throw instead of writing it to the output. */
const requireFinite = (what: string, value: number): number => {
  if (!Number.isFinite(value))
    throw new Error(`${what} is ${value} — refusing to continue with a non-finite number.`);
  return value;
};

/** Read a CSV file into rows of cells (first row = header). */
function readCsv(file: string): string[][] {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.split(','));
}

/** All data values of one column by header name; undefined entries if the column is missing. */
function column(rows: string[][], name: string): (string | undefined)[] {
  const idx = rows[0].indexOf(name);
  return rows.slice(1).map((r) => (idx >= 0 ? r[idx] : undefined));
}

/** Parse strings to finite, non-negative numbers (blank/invalid cells are dropped). */
const toNums = (vals: (string | undefined)[]): number[] =>
  vals.map(Number).filter((n) => Number.isFinite(n) && n >= 0);

/** Simple percentile: the value at index floor(p * n) of the sorted list (not interpolated). */
const percentile = (vals: number[], p: number): number => {
  if (vals.length === 0) return NaN;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

const mean = (vals: number[]): number =>
  vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;

// ---------------------------------------------------------------------------
// Performance (speed) analysis
// ---------------------------------------------------------------------------

/** Aggregated speed numbers from one platform's performance.csv. */
type PerfStats = {
  requests: number;
  ok: number;
  errors: number;
  ttfb: number[];
  firstChar: number[];
  total: number[];
  sessions: Set<string>;
  /** Timestamp (ms) of the last response — used to measure the lambdaweb idle tail. */
  lastEnd: number;
};

/** One per-request row of performance.csv (written by send.ts). */
type PerfRow = {
  session: string;
  /** Request start (ms epoch) — defines which request was a session's FIRST question. */
  start: number;
  /** Response end (ms epoch) — MAX over requests measures the lambdaweb idle tail. */
  end: number;
  ok: boolean;
  ttfb: number | null;
  firstChar: number | null;
  total: number | null;
};

/** The platform's per-request rows, or null when send.ts produced no performance.csv. */
function readPerfRows(test: string, platform: string): PerfRow[] | null {
  const file = path.resolve(
    import.meta.dirname,
    'results',
    test,
    platform,
    'performance',
    'performance.csv',
  );
  if (!existsSync(file)) return null;
  const rows = readCsv(file);
  if (rows.length === 0) return null; // empty file — send.ts wrote nothing yet
  const idx = (name: string) => rows[0].indexOf(name);
  const startCol = idx('timestamp_start_utc');
  const endCol = idx('timestamp_end_utc');
  const sessionCol = idx('session_id');
  if (startCol < 0 || endCol < 0 || sessionCol < 0) {
    throw new Error(
      `${path.basename(file)}: columns timestamp_start_utc / timestamp_end_utc / session_id missing — was it written by send.ts?`,
    );
  }
  const out: PerfRow[] = [];
  for (const [n, line] of rows.slice(1).entries()) {
    const start = Date.parse(line[startCol] ?? '');
    if (!Number.isFinite(start)) {
      throw new Error(
        `${path.basename(file)}: unparseable timestamp "${line[startCol]}" (line ${n + 2}).`,
      );
    }
    const end = Date.parse(line[endCol] ?? '');
    out.push({
      session: line[sessionCol] ?? '',
      start,
      end: Number.isFinite(end) ? end : start,
      ok: line[idx('ok')] === '1',
      ttfb: toNums([line[idx('ttfb_ms')]])[0] ?? null,
      firstChar: toNums([line[idx('first_char_ms')]])[0] ?? null,
      total: toNums([line[idx('total_ms')]])[0] ?? null,
    });
  }
  return out;
}

/** Latency values of one field, dropping absent (-1 / blank) cells. */
const latency = (rows: PerfRow[], field: 'ttfb' | 'firstChar' | 'total'): number[] =>
  rows.map((r) => r[field]).filter((n): n is number => n !== null && n >= 0);

const statsOf = (rows: PerfRow[]): PerfStats => ({
  requests: rows.length,
  ok: rows.filter((r) => r.ok).length,
  errors: rows.filter((r) => !r.ok).length,
  ttfb: latency(rows, 'ttfb'),
  firstChar: latency(rows, 'firstChar'),
  total: latency(rows, 'total'),
  sessions: new Set(rows.map((r) => r.session)),
  lastEnd: 0,
});

/** Split a platform's requests: the FIRST question of each session (earliest
 * start) vs the FOLLOW-UP questions (same session reused). Works for both
 * shapes — `--new-session-each-request` (every request is a first question)
 * and session-reuse shapes (wave 1 = first, later waves = follow-ups). */
function splitFirstFollowUp(rows: PerfRow[]): { first: PerfRow[]; followUp: PerfRow[] } {
  const minStart = new Map<string, number>();
  for (const r of rows) {
    const cur = minStart.get(r.session);
    if (cur === undefined || r.start < cur) minStart.set(r.session, r.start);
  }
  const taken = new Set<string>(); // sessions whose first-question row is already chosen
  const first: PerfRow[] = [];
  const followUp: PerfRow[] = [];
  for (const r of rows) {
    if (!taken.has(r.session) && r.start === minStart.get(r.session)) {
      first.push(r);
      taken.add(r.session);
    } else {
      followUp.push(r);
    }
  }
  return { first, followUp };
}

/** Per-question-number latency across a platform's sessions: median full answer
 * of all sessions' 1st / 2nd / 3rd … question (earliest start = question 1,
 * ties broken by CSV order), plus how many sessions had that question. */
function sequentialTurns(
  rows: PerfRow[],
): { turn: number; sessions: number; medianMs: number | null }[] {
  const bySession = new Map<string, PerfRow[]>();
  for (const r of rows) {
    const list = bySession.get(r.session) ?? [];
    list.push(r);
    bySession.set(r.session, list);
  }
  const byTurn = new Map<number, number[]>();
  for (const list of bySession.values()) {
    const ordered = [...list].sort((a, b) => a.start - b.start);
    for (const [i, row] of ordered.entries()) {
      if (row.total === null || row.total < 0) continue;
      const vals = byTurn.get(i + 1) ?? [];
      vals.push(row.total);
      byTurn.set(i + 1, vals);
    }
  }
  return [...byTurn.keys()]
    .sort((a, b) => a - b)
    .map((turn) => {
      const vals = byTurn.get(turn)!;
      const median = percentile(vals, 0.5);
      return {
        turn,
        sessions: vals.length,
        medianMs: Number.isFinite(median) ? median : null,
      };
    });
}

// ---------------------------------------------------------------------------
// speed.csv — the latency detail report.ts renders (all calculation lives here)
// ---------------------------------------------------------------------------

/** Fixed CSV column order for speed.csv. Cell convention per column group:
 * `_n`, `_ok`, `_errors` are integers; the ms columns are rounded integers
 * ("" when the group has no values — e.g. follow-ups under a
 * `--new-session-each-request` shape). */
const SPEED_COLUMNS = [
  'platform',
  'group',
  'requests_n',
  'requests_ok',
  'requests_errors',
  'ttfb_p50_ms',
  'ttfb_p95_ms',
  'first_char_p50_ms',
  'first_char_p95_ms',
  'total_p50_ms',
  'total_p95_ms',
];

/** Round a percentile to an integer ms cell — "" when the group has no values
 * (percentile of an empty list is NaN). */
const roundMs = (vals: number[], p: number): number | '' => {
  const v = percentile(vals, p);
  return Number.isFinite(v) ? Math.round(v) : '';
};

/** One speed.csv row per platform x group. */
function speedRowsFor(platform: string, rows: PerfRow[]): Analysis[] {
  const { first, followUp } = splitFirstFollowUp(rows);
  const groups: [string, PerfStats][] = [
    ['first', statsOf(first)],
    ['followup', statsOf(followUp)],
  ];
  const out: Analysis[] = groups.map(([group, s]) => ({
    platform,
    group,
    requests_n: s.requests,
    requests_ok: s.ok,
    requests_errors: s.errors,
    ttfb_p50_ms: roundMs(s.ttfb, 0.5),
    ttfb_p95_ms: roundMs(s.ttfb, 0.95),
    first_char_p50_ms: roundMs(s.firstChar, 0.5),
    first_char_p95_ms: roundMs(s.firstChar, 0.95),
    total_p50_ms: roundMs(s.total, 0.5),
    total_p95_ms: roundMs(s.total, 0.95),
  }));
  // Sequential question numbers (question 1, 2, …) as one row per turn.
  for (const t of sequentialTurns(rows)) {
    out.push({
      platform,
      group: `turn${t.turn}`,
      requests_n: t.sessions,
      median_total_ms: t.medianMs === null ? '' : Math.round(t.medianMs),
    } as Analysis);
  }
  return out;
}

/** Write the whole test's speed detail: one row per platform x group.
 * Group values: `first` / `followup` (percentile columns) and `turn<N>`
 * (requests_n = sessions observed, median_total_ms = median full answer).
 * MERGES with an existing speed.csv: rows of platforms NOT in this run are
 * kept — analyze.ts --platform runs one platform at a time, and each run must
 * not wipe the other platforms' rows (the report renders all of them). */
function writeSpeed(test: string, rows: Analysis[]): void {
  const columns = [...SPEED_COLUMNS, 'median_total_ms'];
  const file = path.resolve(import.meta.dirname, 'results', test, 'speed.csv');
  const done = new Set(rows.map((r) => String(r.platform)));
  const kept: Analysis[] = [];
  if (existsSync(file)) {
    for (const line of readCsv(file).slice(1)) {
      if (done.has(line[0])) continue; // this run recomputed the platform — drop its old rows
      const old: Analysis = {};
      columns.forEach((c, i) => {
        old[c] = line[i] ?? '';
      });
      kept.push(old);
    }
  }
  const dir = path.resolve(import.meta.dirname, 'results', test);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    `${[
      columns.join(','),
      ...[...kept, ...rows].map((r) => columns.map((c) => String(r[c] ?? '')).join(',')),
    ].join('\n')}\n`,
  );
}

/** Read results/<test>/<platform>/performance/performance.csv; null if the file is absent. */
function analyzePerformance(test: string, platform: string): PerfStats | null {
  const rows = readPerfRows(test, platform);
  if (rows === null) return null;
  return { ...statsOf(rows), lastEnd: Math.max(...rows.map((r) => r.end), 0) };
}

// ---------------------------------------------------------------------------
// Cost analysis (per platform, from logs.csv written by logs-to-csv.ts)
// ---------------------------------------------------------------------------

/** Cost estimate plus the human-readable breakdown lines printed to the console.
 * `environments` is the LambdaWeb instance count; other platforms leave it blank. */
type CostAnalysis = {
  cost: number;
  details: string[];
  aliveAfter: number;
  environments: number | '';
};

function analyzeCost(test: string, platform: string, perf: PerfStats): CostAnalysis {
  const file = path.resolve(import.meta.dirname, 'results', test, platform, 'logs', 'logs.csv');
  if (!existsSync(file)) {
    throw new Error(
      `logs.csv missing for ${test}/${platform} — run download-logs + logs-to-csv first (${file}).`,
    );
  }
  const rows = readCsv(file);
  const details: string[] = [];

  if (platform === 'lambdaevent') {
    // Lambda bills the *billed* duration at the function's fixed memory size.
    const billedMs = toNums(column(rows, 'billed_duration_ms'));
    const gbS = (billedMs.reduce((a, b) => a + b, 0) / 1000) * RATES.lambdaevent.memoryGb;
    const cost = requireFinite(
      `${test}/${platform} cost`,
      gbS * RATES.lambdaevent.gbS + perf.requests * RATES.lambdaevent.request,
    );
    details.push(
      `${billedMs.length} invocations; billed ${gbS.toFixed(2)} GB-s; requests ${usd(perf.requests * RATES.lambdaevent.request)} + compute ${usd(gbS * RATES.lambdaevent.gbS)}`,
    );
    return { cost, details, aliveAfter: 0, environments: '' };
  }

  if (platform === 'lambdaweb') {
    // Each environment (warm instance) is billed at its peak memory for its whole
    // lifetime (first init report -> last event), plus vCPU time and requests.
    const idx = (name: string) => rows[0].indexOf(name);
    type Env = { start: number; end: number; requests: number; cpuMs: number; peakMb: number };
    const envs = new Map<string, Env>();
    // rows[0] is the CSV header — treating it as data would create a bogus
    // environment whose NaN timestamps poison every total below.
    for (const [n, row] of rows.slice(1).entries()) {
      const ts = Date.parse(row[0]);
      if (!Number.isFinite(ts)) {
        throw new Error(
          `${test}/${platform}: unparseable timestamp "${row[0]}" in ${path.basename(file)} (line ${n + 2}).`,
        );
      }
      const type = row[idx('event_type')];
      const env = row[idx('environment_id')];
      if (!env) continue;
      const a = envs.get(env) ?? { start: ts, end: ts, requests: 0, cpuMs: 0, peakMb: 0 };
      a.end = Math.max(a.end, ts);
      a.peakMb = Math.max(a.peakMb, Number(row[idx('max_memory_mb')]) || 0);
      if (type === 'platform.initReport') a.start = ts; // the environment's life begins at init
      if (type === 'platform.invokeReport') {
        a.end = ts;
        a.requests += Number(row[idx('requests')]) || 0;
        a.cpuMs += Number(row[idx('cpu_ms')]) || 0;
      }
      envs.set(env, a);
    }
    let cpuS = 0,
      memoryGbS = 0,
      lifeS = 0,
      requests = 0,
      aliveAfter = 0;
    for (const a of envs.values()) {
      const life = (a.end - a.start) / 1000;
      requests += a.requests;
      cpuS += a.cpuMs / 1000;
      memoryGbS += (a.peakMb / 1024) * life;
      lifeS += life;
      // Idle time the environment stayed warm after the test's last response.
      if (perf.lastEnd && a.end > perf.lastEnd)
        aliveAfter = Math.max(aliveAfter, (a.end - perf.lastEnd) / 1000);
    }
    const costRequest = requests * RATES.lambdaweb.request;
    const costCpu = cpuS * RATES.lambdaweb.vcpuS;
    const costMem = memoryGbS * RATES.lambdaweb.gbS;
    details.push(
      `${envs.size} environments; total life ${lifeS.toFixed(0)} s; requests ${requests} (${usd(costRequest)}); cpu ${cpuS.toFixed(1)} s (${usd(costCpu)}); memory ${memoryGbS.toFixed(2)} GB-s (${usd(costMem)})`,
    );
    // Cost of the idle tail, priced at the highest peak memory across environments.
    const maxPeakGb = Math.max(...[...envs.values()].map((a) => a.peakMb), 0) / 1024;
    details.push(
      `alive after last response: ${aliveAfter.toFixed(0)} s — tail cost ${usd(aliveAfter * maxPeakGb * RATES.lambdaweb.gbS)}`,
    );
    return {
      cost: requireFinite(`${test}/${platform} cost`, costRequest + costCpu + costMem),
      details,
      aliveAfter,
      environments: envs.size,
    };
  }

  // AgentCore (v1 and v2): usage records already aggregate vCPU-hours and GB-hours.
  const vcpuH = toNums(column(rows, 'vcpu_hours')).reduce((a, b) => a + b, 0);
  const gbH = toNums(column(rows, 'memory_gb_hours')).reduce((a, b) => a + b, 0);
  const rate = platform === 'agentcorev1' ? RATES.agentcorev1 : RATES.agentcorev2;
  const cost = requireFinite(`${test}/${platform} cost`, vcpuH * rate.vcpuH + gbH * rate.gbH);
  details.push(
    `${perf.sessions.size} sessions; vCPU ${vcpuH.toFixed(6)} h (${usd(vcpuH * rate.vcpuH)}); memory ${gbH.toFixed(4)} GB-h (${usd(gbH * rate.gbH)}); 120 s idle tail per session included`,
  );
  return { cost, details, aliveAfter: 0, environments: '' };
}

// ---------------------------------------------------------------------------
// Output rows (analysis.csv / comparison.csv)
// ---------------------------------------------------------------------------

type Analysis = Record<string, string | number>;

/** Fixed CSV column order for analysis.csv and comparison.csv. */
const COLUMNS = [
  'test',
  'platform',
  'requests',
  'ok',
  'errors',
  'sessions',
  'environments',
  'ttfb_p50_ms',
  'ttfb_p95_ms',
  'ttfb_media_ms',
  'first_char_p50_ms',
  'first_char_p95_ms',
  'total_p50_ms',
  'total_p95_ms',
  'total_media_ms',
  'cost_usd',
  'cost_per_request_usd',
  'cost_per_session_usd',
  'details',
];

function buildRow(
  test: string,
  platform: string,
  perf: PerfStats,
  cost: number,
  details: string[],
  environments: number | '',
): Analysis {
  const row: Analysis = {
    test,
    platform,
    requests: perf.requests,
    ok: perf.ok,
    errors: perf.errors,
    sessions: perf.sessions.size,
    environments,
    ttfb_p50_ms: Math.round(percentile(perf.ttfb, 0.5)),
    ttfb_p95_ms: Math.round(percentile(perf.ttfb, 0.95)),
    ttfb_media_ms: Math.round(mean(perf.ttfb)),
    first_char_p50_ms: Math.round(percentile(perf.firstChar, 0.5)),
    first_char_p95_ms: Math.round(percentile(perf.firstChar, 0.95)),
    total_p50_ms: Math.round(percentile(perf.total, 0.5)),
    total_p95_ms: Math.round(percentile(perf.total, 0.95)),
    total_media_ms: Math.round(mean(perf.total)),
    cost_usd: cost.toFixed(6),
    cost_per_request_usd: (cost / Math.max(1, perf.requests)).toFixed(8),
    cost_per_session_usd: (cost / Math.max(1, perf.sessions.size)).toFixed(8),
    details: details.join(' | '),
  };
  // Fail loudly instead of writing "NaN" into the CSV.
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(
        `${test}/${platform}: statistic "${key}" is ${value} — refusing to write NaN to the CSV.`,
      );
    }
  }
  return row;
}

/** Write analysis rows as CSV in the fixed column order. */
function writeAnalysis(file: string, rows: Analysis[]): void {
  writeFileSync(
    file,
    `${[
      COLUMNS.join(','),
      ...rows.map((r) => COLUMNS.map((c) => String(r[c] ?? '')).join(',')),
    ].join('\n')}\n`,
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      test: { type: 'string' },
      platform: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      `Usage: npx tsx price-perfomance-test/analyze.ts --test <name> [--platform ${PLATFORMS.join('|')}]`,
    );
    return;
  }
  const test = values.test;
  if (!test) throw new Error('--test is required.');

  const onlyPlatform = values.platform;
  // Without --platform: analyze every platform that has run results for this test.
  const targets = onlyPlatform
    ? [onlyPlatform]
    : PLATFORMS.filter((p) =>
        existsSync(
          path.resolve(import.meta.dirname, 'results', test, p, 'performance', 'performance.csv'),
        ),
      );
  if (targets.length === 0) {
    throw new Error(`No results for ${test} under results/${test}/<platform>/performance/.`);
  }

  const analyses: Analysis[] = [];
  const speedRows: Analysis[] = [];
  for (const platform of targets) {
    console.log(`=== ${test} / ${platform} ===`);
    const perf = analyzePerformance(test, platform);
    if (!perf) {
      console.log('  performance.csv missing — skipping.');
      continue;
    }
    // Speed detail for report.ts — computed here, rendered there.
    speedRows.push(...speedRowsFor(platform, readPerfRows(test, platform)!));
    const usage = analyzeCost(test, platform, perf);
    // Build (and validate) the row first — any NaN statistic throws here, before
    // anything is printed or written.
    const analysis = buildRow(test, platform, perf, usage.cost, usage.details, usage.environments);
    for (const d of usage.details) console.log(`  ${d}`);
    console.log(`  requests ${analysis.requests} (ok ${analysis.ok}, errors ${analysis.errors})`);
    console.log(
      `  total p50 ${analysis.total_p50_ms} ms | p95 ${analysis.total_p95_ms} ms` +
        ` | ttfb p50 ${analysis.ttfb_p50_ms} ms`,
    );
    console.log(
      `  ESTIMATED COST: ${usd(usage.cost)} (per request ${usd(usage.cost / Math.max(1, perf.requests))})`,
    );

    analyses.push(analysis);
    if (onlyPlatform) {
      const dir = path.resolve(import.meta.dirname, 'results', test, platform);
      mkdirSync(dir, { recursive: true });
      writeAnalysis(path.join(dir, 'analysis.csv'), [analysis]);
    }
  }

  // Comparison file: multiple platforms analyzed, or an explicit scan with --platform omitted.
  if (analyses.length > 1 || !onlyPlatform) {
    const dir = path.resolve(import.meta.dirname, 'results', test);
    mkdirSync(dir, { recursive: true });
    writeAnalysis(path.join(dir, 'comparison.csv'), analyses);
    console.log(
      `Comparison of ${analyses.length} platform(s) -> ${path.join(dir, 'comparison.csv')}`,
    );
  }

  // Speed detail (first vs follow-ups vs sequential question numbers) — written
  // in BOTH modes so report.ts always has the pre-aggregated data.
  if (speedRows.length > 0) {
    const dir = path.resolve(import.meta.dirname, 'results', test);
    writeSpeed(test, speedRows);
    console.log(`Speed detail (${speedRows.length} rows) -> ${path.join(dir, 'speed.csv')}`);
  }
}

main().catch((e) => {
  console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
