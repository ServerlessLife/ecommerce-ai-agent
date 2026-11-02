/**
 * report.ts — renders the test's markdown report results/<test>/report.md from
 * the CSVs the other scripts wrote. NO calculation here: every number is read
 * from the pre-aggregated CSVs; this script only formats markdown. No AWS
 * calls — local files only, so it also works after the stacks are destroyed.
 *
 * Sources:
 *   cost      results/<test>/comparison.csv (analyze.ts WITHOUT --platform) —
 *             otherwise the per-platform results/<test>/<platform>/analysis.csv
 *             files. Neither present -> run analyze.ts.
 *   speed     results/<test>/speed.csv (analyze.ts — written in both its
 *             modes): per platform the `first`/`followup` percentile rows and
 *             the sequential `turn<N>` rows. Missing -> run analyze.ts.
 *   bill      results/<test>/<platform>/bill/bill.csv (bill.ts, Cost Explorer).
 *             OPTIONAL — the bill posts ~24-72 h after the run; platforms
 *             without one are reported as "not posted yet". The bill-vs-
 *             estimate comparison only appears where bill rows exist.
 *
 * Sections: summary (with the cost-vs-LambdaEvent (Lambda Event Function) ratio, e.g. "3.4X"), speed split
 * into first-question vs follow-ups and the sequential question numbers,
 * calculated cost, estimated vs billed (with per-usage-type bill breakdowns),
 * pricing model.
 *
 * Usage: npx tsx price-perfomance-test/report.ts --test test1
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PLATFORMS, readOutput, stackNameFor } from './agent.js';

// ---------------------------------------------------------------------------
// Small formatting helpers (the only logic in this file)
// ---------------------------------------------------------------------------

const usd = (n: number): string => `$${n.toFixed(6)}`;
const usd8 = (n: number): string => `$${n.toFixed(8)}`;
const signedUsd = (n: number): string => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(6)}`;
const signedPct = (n: number): string => `${(n < 0 ? '' : '+') + n.toFixed(1)}%`;
const DASH = '—';

/** Markdown table cells must not carry raw pipes. */
const cell = (text: string): string => text.replace(/\|/g, '\\|');

/** Read a CSV file into rows of cells (first row = header). */
function readCsv(file: string): string[][] {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.split(','));
}

/** String cell -> finite number, or null (blank/invalid -> null). */
const toNum = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Milliseconds as seconds ("4.93") for the speed tables; DASH when absent. */
const sec = (ms: string | number | undefined): string => {
  const n = typeof ms === 'number' ? ms : toNum(ms === undefined ? undefined : String(ms));
  return n === null ? DASH : (n / 1000).toFixed(2);
};

/** The numeric cell as text, or an em-dash when the value is absent. */
const txt = (v: string | number | undefined): string => {
  const n = typeof v === 'number' ? v : toNum(v === undefined ? undefined : String(v));
  return n === null ? DASH : String(n);
};

/** Markdown table from headers + pre-formatted cell rows. */
function table(headers: string[], rows: string[][]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ];
}

/** Bold a cell's value when it equals the best (lowest) across the rows. */
function markBest(
  value: string | number,
  best: number | null,
  format: (n: number) => string,
): string {
  const n =
    typeof value === 'number' ? value : toNum(value === undefined ? undefined : String(value));
  if (n === null) return DASH;
  return best !== null && n === best ? `**${format(n)}**` : format(n);
}

// ---------------------------------------------------------------------------
// CSV readers
// ---------------------------------------------------------------------------

/** One pre-aggregated row of analysis.csv / comparison.csv (written by analyze.ts). */
type Analysis = Record<string, string | number>;

/** Columns report.ts consumes from analysis.csv / comparison.csv. */
const ANALYSIS_COLUMNS = [
  'platform',
  'requests',
  'ok',
  'errors',
  'sessions',
  'environments',
  'cost_usd',
  'cost_per_request_usd',
  'cost_per_session_usd',
  'details',
];

function parseAnalysisRows(file: string): Analysis[] {
  const rows = readCsv(file);
  const missing = ANALYSIS_COLUMNS.filter((c) => !rows[0].includes(c));
  if (missing.length > 0) {
    throw new Error(
      `${path.basename(file)}: columns ${missing.join(', ')} missing — was it written by analyze.ts?`,
    );
  }
  return rows.slice(1).map((line) => {
    const row: Analysis = {};
    for (const c of ANALYSIS_COLUMNS) row[c] = line[rows[0].indexOf(c)] ?? '';
    return row;
  });
}

/** Platforms with analysis results: comparison.csv preferred, else the per-platform analysis.csv files. */
function loadAnalysis(test: string): { rows: Map<string, Analysis>; source: string } {
  const dir = path.resolve(import.meta.dirname, 'results', test);
  const rows = new Map<string, Analysis>();
  let source = '';
  const comparison = path.join(dir, 'comparison.csv');
  if (existsSync(comparison)) {
    for (const row of parseAnalysisRows(comparison)) rows.set(String(row.platform), row);
    if (rows.size > 0) source = 'comparison.csv';
  }
  if (rows.size === 0) {
    for (const platform of PLATFORMS) {
      const file = path.join(dir, platform, 'analysis.csv');
      if (!existsSync(file)) continue;
      const parsed = parseAnalysisRows(file);
      if (parsed[0]) rows.set(platform, parsed[0]);
    }
    if (rows.size > 0) source = 'per-platform analysis.csv';
  }
  if (rows.size === 0) {
    throw new Error(
      `No analysis for ${test} — run analyze.ts first: npx tsx price-perfomance-test/analyze.ts --test ${test}`,
    );
  }
  return { rows, source };
}

/** One pre-aggregated speed row of speed.csv (written by analyze.ts): a
 * `first`/`followup` percentile row or a sequential `turn<N>` row. */
type SpeedRow = Record<string, string | number>;

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
  'median_total_ms',
];

/** The test's speed rows, grouped per platform — null when analyze.ts has not written speed.csv. */
function loadSpeed(test: string): Map<string, SpeedRow[]> | null {
  const file = path.resolve(import.meta.dirname, 'results', test, 'speed.csv');
  if (!existsSync(file)) return null;
  const rows = readCsv(file);
  const missing = SPEED_COLUMNS.filter((c) => !rows[0].includes(c));
  if (missing.length > 0) {
    throw new Error(
      `${path.basename(file)}: columns ${missing.join(', ')} missing — re-run analyze.ts (it now writes speed.csv).`,
    );
  }
  const byPlatform = new Map<string, SpeedRow[]>();
  for (const line of rows.slice(1)) {
    const row: SpeedRow = {};
    for (const c of SPEED_COLUMNS) row[c] = line[rows[0].indexOf(c)] ?? '';
    const p = String(row.platform);
    byPlatform.set(p, [...(byPlatform.get(p) ?? []), row]);
  }
  return byPlatform;
}

/** The platform's first/followup percentile row. */
const speedGroup = (rows: SpeedRow[], group: 'first' | 'followup'): SpeedRow | undefined =>
  rows.find((r) => String(r.group) === group);

/** The platform's sequential `turn<N>` rows, in question-number order. */
const speedTurns = (
  rows: SpeedRow[],
): { turn: number; sessions: number; medianMs: number | null }[] =>
  rows
    .filter((r) => String(r.group).startsWith('turn'))
    .map((r) => ({
      turn: Number(String(r.group).slice(4)),
      sessions: toNum(String(r.requests_n)) ?? 0,
      medianMs: toNum(String(r.median_total_ms)),
    }))
    .sort((a, b) => a.turn - b.turn);

// ---------------------------------------------------------------------------
// Bill rows (Cost Explorer totals per tag, written by bill.ts)
// ---------------------------------------------------------------------------

/** Bill usage-type aggregate: bill.csv rows share usage types across days. */
type BillType = { type: string; quantity: number; unit: string; cost: number };

type Bill = {
  tag: string;
  total: number;
  types: BillType[];
  /** Raw bill.csv data rows (day x usage type). */
  rowCount: number;
  /** Inclusive day window the rows cover (YYYY-MM-DD … YYYY-MM-DD). */
  window: string;
};

/** The platform's bill — null when bill.ts has not run or the bill has no rows yet. */
function loadBill(test: string, platform: string, tag: string): Bill | null {
  const file = path.resolve(import.meta.dirname, 'results', test, platform, 'bill', 'bill.csv');
  if (!existsSync(file)) return null;
  const rows = readCsv(file);
  const idx = (name: string) => rows[0].indexOf(name);
  const byType = new Map<string, BillType>();
  let total = 0;
  let rowCount = 0;
  let first = '';
  let last = '';
  for (const line of rows.slice(1)) {
    const cost = toNum(line[idx('cost_usd')]);
    if (cost === null) continue;
    rowCount += 1;
    total += cost;
    const type = line[idx('usage_type')] ?? '';
    const unit = line[idx('unit')] ?? '';
    const date = line[idx('data')] ?? '';
    if (date !== '') {
      if (first === '' || date < first) first = date;
      if (date > last) last = date;
    }
    const agg = byType.get(type) ?? { type, quantity: 0, unit, cost: 0 };
    agg.quantity += toNum(line[idx('quantity')]) ?? 0;
    agg.cost += cost;
    if (agg.unit === '' && unit !== '') agg.unit = unit;
    byType.set(type, agg);
  }
  if (rowCount === 0) return null; // header-only bill.csv — the bill has not posted yet
  const types = [...byType.values()].sort((a, b) => b.cost - a.cost);
  return {
    tag,
    total,
    types,
    rowCount,
    window: first === last || first === '' ? first || 'n/a' : `${first} … ${last}`,
  };
}

/** The platform's cost-experiment tag (CostTag stack output; falls back to the
 * documented derivation <test>-<platform> once the outputs file is gone). */
function tagFor(test: string, platform: string): string {
  try {
    return readOutput(test, stackNameFor(test, platform), 'CostTag');
  } catch {
    return `${test}-${platform}`;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The two first/follow-up speed tables — the report compares on p50 (median). */
const SPEED_HEADERS = [
  'platform',
  'requests',
  'ok',
  'errors',
  'first byte p50 (s)',
  'first answer char p50 (s)',
  'full answer p50 (s)',
];

function speedGroupTable(
  title: string,
  subtitle: string,
  entries: [string, SpeedRow | undefined][],
): string[] {
  const md: string[] = [`## ${title}`, '', subtitle, ''];
  const p50s = entries
    .map(([, r]) => toNum(String(r?.total_p50_ms ?? '')))
    .filter((n): n is number => n !== null);
  const best = p50s.length > 0 ? Math.min(...p50s) : null;
  md.push(
    ...table(
      SPEED_HEADERS,
      entries.map(([p, r]) => [
        p,
        txt(r?.requests_n),
        txt(r?.requests_ok),
        txt(r?.requests_errors),
        sec(r?.ttfb_p50_ms),
        sec(r?.first_char_p50_ms),
        markBest(r?.total_p50_ms ?? '', best, sec),
      ]),
    ),
  );
  md.push('');
  if (best !== null && p50s.length >= 2) {
    const winner = [...entries].sort(
      (a, b) =>
        (toNum(String(a[1]?.total_p50_ms ?? '')) ?? Infinity) -
        (toNum(String(b[1]?.total_p50_ms ?? '')) ?? Infinity),
    )[0][0];
    md.push(
      `Fastest ${title.toLowerCase().replace(/^speed — /, '')} (full answer p50): **${winner}**`,
      '',
    );
  }
  return md;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      test: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('Usage: npx tsx price-perfomance-test/report.ts --test <name>');
    return;
  }
  const test = values.test;
  if (!test) throw new Error('--test is required.');
  if (!/^[a-z0-9]+$/.test(test))
    throw new Error(`--test must be a lowercase [a-z0-9] label, got "${test}".`);

  const dir = path.resolve(import.meta.dirname, 'results', test);
  const { rows: analysis, source } = loadAnalysis(test);
  const speed = loadSpeed(test); // null until analyze.ts (re)runs — rendered as a "run analyze.ts" note

  // Platform order: PLATFORMS order first, anything unexpected after (sorted).
  const rank = (p: string): number => {
    const i = (PLATFORMS as readonly string[]).indexOf(p);
    return i === -1 ? PLATFORMS.length : i;
  };
  const platforms = [...new Set([...(PLATFORMS as readonly string[]), ...analysis.keys()])]
    .filter((p) => analysis.has(p) || (speed?.has(p) ?? false))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const missing = (PLATFORMS as readonly string[]).filter(
    (p) => !analysis.has(p) && !(speed?.has(p) ?? false),
  );

  // Bills for every platform we know about — the bill-comparison table also
  // covers platforms whose analysis is missing.
  const bills = new Map<string, Bill | null>();
  for (const p of new Set([...(PLATFORMS as readonly string[]), ...analysis.keys()])) {
    bills.set(p, loadBill(test, p, tagFor(test, p)));
  }

  // Cost helpers: the ratio column ("3.4X") — each platform's calculated cost
  // as a multiple of LambdaEvent's calculated cost. The baseline is FIXED to
  // lambdaevent: 1X is always lambdaevent, even when another platform is
  // cheaper (it then shows < 1X). No lambdaevent results -> all ratios DASH.
  const costOf = (p: string): number | null => {
    const a = analysis.get(p);
    return a ? toNum(String(a.cost_usd)) : null;
  };
  const hasLambdaEvent = costOf('lambdaevent') !== null;
  const ratio = (p: string): string => {
    if (!hasLambdaEvent) return DASH;
    const c = costOf(p);
    const b = costOf('lambdaevent');
    if (c === null || b === null || b === 0) return DASH;
    return `${(c / b).toFixed(1)}X`;
  };
  const ratioHeader = hasLambdaEvent ? 'cost vs lambdaevent' : null;
  const ratioNote = hasLambdaEvent
    ? "`cost vs lambdaevent` — calculated cost as a multiple of lambdaevent's (the fixed reference); **1X = lambdaevent**, even when another platform is cheaper (it then shows < 1X)."
    : null;

  // Best (lowest) values for the winner markers.
  const bestOf = (field: string): number | null => {
    const nums = platforms
      .map((p) => toNum(String(analysis.get(p)?.[field] ?? '')))
      .filter((n): n is number => n !== null);
    return nums.length > 0 ? Math.min(...nums) : null;
  };
  const bestCost = bestOf('cost_usd');
  const bestPerRequest = bestOf('cost_per_request_usd');
  const cheapest = platforms.find(
    (p) => toNum(String(analysis.get(p)?.cost_usd ?? '')) === bestCost,
  );

  const md: string[] = [];
  md.push(
    `# Price-performance report — ${test}`,
    '',
    `_Generated ${new Date().toISOString()} — cost: ${source} (analyze.ts), speed: speed.csv (analyze.ts), bills: bill/bill.csv (bill.ts, Cost Explorer)._`,
    '',
  );
  if (missing.length > 0) {
    md.push(
      `> Platforms without results: ${missing.join(', ')} — run send.ts + analyze.ts for them, then re-run this report.`,
      '',
    );
  }

  // Summary — traffic, calculated cost and the cost-vs-Lambda ratio. Traffic
  // counts come from the first/followup speed rows when speed.csv exists (the
  // sum of both groups = all requests), else from the analysis aggregates.
  const traffic = (
    p: string,
  ): { requests: string; ok: string; errors: string; sessions: string } => {
    const groupRows = speed?.get(p);
    if (groupRows !== undefined) {
      const sum = (field: string): number =>
        groupRows
          .filter((r) => ['first', 'followup'].includes(String(r.group)))
          .reduce((acc, r) => acc + (toNum(String(r[field])) ?? 0), 0);
      const firstRow = speedGroup(groupRows, 'first');
      return {
        requests: String(sum('requests_n')),
        ok: String(sum('requests_ok')),
        errors: String(sum('requests_errors')),
        sessions: txt(firstRow?.requests_n),
      };
    }
    const a = analysis.get(p);
    return {
      requests: a ? String(a.requests) : DASH,
      ok: a ? String(a.ok) : DASH,
      errors: a ? String(a.errors) : DASH,
      sessions: a ? String(a.sessions) : DASH,
    };
  };

  md.push('## Summary', '');
  md.push(
    ...table(
      [
        'platform',
        'requests',
        'ok',
        'errors',
        'sessions',
        'instances',
        'calculated cost',
        ...(ratioHeader !== null ? [ratioHeader] : []),
        'billed',
      ],
      platforms.map((p) => {
        const t = traffic(p);
        const bill = bills.get(p) ?? null;
        return [
          p,
          t.requests,
          t.ok,
          t.errors,
          t.sessions,
          txt(analysis.get(p)?.environments),
          markBest(analysis.get(p)?.cost_usd ?? '', bestCost, usd),
          ...(ratioHeader !== null ? [ratio(p)] : []),
          bill !== null ? usd(bill.total) : DASH,
        ];
      }),
    ),
  );
  md.push('');
  if (cheapest !== undefined) md.push(`Cheapest (calculated): **${cheapest}**.`, '');
  if (ratioNote !== null) md.push(ratioNote, '');
  md.push(
    'Bills post ~24-72 h after the run — see [Estimated vs billed](#estimated-vs-billed-cost-explorer).',
    '',
  );

  // Speed — first question of a session vs follow-up questions, straight from
  // speed.csv (analyze.ts did the per-request split and the percentiles).
  const speedEntries = (group: 'first' | 'followup'): [string, SpeedRow | undefined][] =>
    platforms.map((p) => [p, speed !== null ? speedGroup(speed.get(p) ?? [], group) : undefined]);
  if (speed !== null) {
    md.push(
      ...speedGroupTable(
        'Speed — first question of a session',
        'The earliest request of each session: session setup, cold environment/init and the first model turn are all included.',
        speedEntries('first'),
      ),
    );
    md.push(
      ...speedGroupTable(
        'Speed — follow-up questions (same session)',
        'Later requests reusing a session: history is already server-side and the setup is already paid.',
        speedEntries('followup'),
      ),
    );
    md.push(
      'How to read the speed tables:',
      '',
      '- **first byte** (`ttfb_p50_ms`) — POST sent → first response byte (the server accepted the request and started replying).',
      '- **first answer char** (`first_char_p50_ms`) — POST sent → first visible answer character (the model started producing the answer).',
      '- **full answer** (`total_p50_ms`) — POST sent → response complete.',
      '- **p50 (median)** — half of the requests were faster than this; the report compares platforms on p50. (p95 values remain available in `speed.csv` / `analysis.csv`.)',
      '- **first question of a session** — decided per `session_id`, not per wave: a shape reusing sessions across waves (e.g. the test3 shape) shows its follow-ups here, a `--new-session-each-request` shape shows none.',
      '',
    );
  } else {
    md.push(
      '## Speed',
      '',
      `No speed.csv for ${test} — re-run analyze.ts (it writes the speed detail report.ts renders):`,
      '',
      '```bash',
      `npx tsx price-perfomance-test/analyze.ts --test ${test}`,
      '```',
      '',
    );
  }

  // Sequential questions: full-answer median per question number (1st, 2nd,
  // 3rd … within a session) — how latency evolves as the conversation grows.
  // ALWAYS rendered: without session reuse the table is empty plus the reason,
  // so the chapter never silently disappears from the report.
  md.push('## Speed — sequential questions of a session', '');
  if (speed !== null) {
    const turnRows = platforms.map((p) => ({ p, turns: speedTurns(speed.get(p) ?? []) }));
    const hasMulti = turnRows.some(({ turns }) => turns.some((t) => t.turn >= 2));
    md.push(
      'Median full answer by question number WITHIN a session (1st = first question, ' +
        '2nd = first follow-up, …): how latency evolves as the conversation grows and the ' +
        'server-side history gets longer.',
      '',
    );
    // Column headers: numbered only when a sequence exists; without session
    // reuse a neutral placeholder replaces "question 1 (s)" — a numbered header
    // would imply a progression the test never had.
    const maxTurn = Math.max(1, ...turnRows.flatMap(({ turns }) => turns.map((t) => t.turn)));
    const headers = hasMulti
      ? ['platform', ...Array.from({ length: maxTurn }, (_, i) => `question ${i + 1} (s)`)]
      : ['platform', '(no data)'];
    md.push(
      ...table(
        headers,
        turnRows.map(({ p, turns }) => {
          const cells = hasMulti
            ? Array.from({ length: maxTurn }, (_, i) => {
                const t = turns.find((x) => x.turn === i + 1);
                return t === undefined || t.medianMs === null
                  ? DASH
                  : `${sec(t.medianMs!)} (${t.sessions})`;
              })
            : [DASH];
          return [p, ...cells];
        }),
      ),
    );
    md.push(
      '',
      'Each cell: median (sessions observed). A cell is only filled when at least one session ' +
        'had that question number — later numbers fill in only for shapes that reuse sessions.',
    );
    if (!hasMulti) {
      md.push(
        'All sessions in this test had a single question (every request used its own session, ' +
          'e.g. the `--new-session-each-request` shapes) — there is no sequence to compare. ' +
          'Session-reuse shapes (e.g. the test3 shape) fill this table.',
      );
    }
    md.push('');
  } else {
    md.push(
      `No speed.csv for ${test} — re-run analyze.ts (it writes the speed detail report.ts renders); ` +
        'session-reuse shapes fill this table.',
      '',
    );
  }

  // Calculated cost.
  md.push('## Calculated cost (published card rates)', '');
  md.push(
    ...table(
      [
        'platform',
        'cost',
        'per request',
        'per session',
        ...(ratioHeader !== null ? [ratioHeader] : []),
      ],
      platforms.map((p) => {
        const a = analysis.get(p);
        const sessionCost = a ? toNum(String(a.cost_per_session_usd)) : null;
        return [
          p,
          markBest(a?.cost_usd ?? '', bestCost, usd),
          markBest(a?.cost_per_request_usd ?? '', bestPerRequest, usd8),
          sessionCost !== null ? usd8(sessionCost) : DASH,
          ...(ratioHeader !== null ? [ratio(p)] : []),
        ];
      }),
    ),
  );
  md.push('');
  md.push('### Detail lines (from analyze.ts)', '');
  for (const p of platforms) {
    const details = String(analysis.get(p)?.details ?? '');
    if (details === '') continue;
    md.push(`- **${p}**`, ...details.split(' | ').map((part) => `  - ${part}`));
  }
  md.push('');

  // Estimated vs billed.
  md.push('## Estimated vs billed (Cost Explorer)', '');
  md.push(
    'The bill is the ACTUAL tagged spend (Cost Explorer, tag `cost-experiment=<test>-<platform>`, ' +
      'region us-east-1) and posts ~24-72 h after the run — re-run this report once bill.ts shows a non-zero total.',
    '',
  );
  const billPlatforms = [...bills.keys()]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .filter((p) => analysis.has(p) || bills.get(p));
  md.push(
    ...table(
      ['platform', 'estimated', 'billed', 'diff', 'diff %', 'bill window', 'status'],
      billPlatforms.map((p) => {
        const estimated = costOf(p);
        const bill = bills.get(p) ?? null;
        if (bill === null) {
          return [
            p,
            estimated !== null ? usd(estimated) : DASH,
            DASH,
            DASH,
            DASH,
            DASH,
            'bill not posted yet (24-72 h after the run)',
          ];
        }
        if (estimated === null) {
          return [
            p,
            DASH,
            usd(bill.total),
            DASH,
            DASH,
            bill.window,
            'no analysis — run analyze.ts',
          ];
        }
        const diff = bill.total - estimated;
        const pct = estimated > 0 ? (diff / estimated) * 100 : null;
        return [
          p,
          usd(estimated),
          usd(bill.total),
          signedUsd(diff),
          pct === null ? DASH : signedPct(pct),
          bill.window,
          pct !== null && Math.abs(pct) <= 5 ? 'within 5%' : 'off — check the breakdown below',
        ];
      }),
    ),
  );
  md.push('');

  // Bill breakdowns (only where a bill exists).
  md.push('### Bill breakdown (usage types)', '');
  const withBills = billPlatforms.filter((p) => bills.get(p));
  if (withBills.length === 0) {
    md.push('_No bill rows yet for any platform._', '');
  }
  for (const p of withBills) {
    const bill = bills.get(p)!;
    md.push(`#### ${p} — tag \`${bill.tag}\` (${bill.rowCount} CE rows, ${bill.window})`, '');
    md.push(
      ...table(
        ['usage_type', 'quantity', 'unit', 'cost'],
        [
          ...bill.types.map((t) => [
            t.type,
            String(t.quantity),
            t.unit === '' ? DASH : t.unit,
            usd(t.cost),
          ]),
          ['**total**', DASH, DASH, `**${usd(bill.total)}**`],
        ],
      ),
    );
    md.push('');
  }

  // Pricing model footnote.
  md.push('## Pricing model (keep in sync with analyze.ts)', '');
  md.push(
    '- lambdaevent: $0.20/1M requests + $0.0000133334/GB-s (1024 MB memory)',
    '- lambdaweb: $0.30/1M requests + $0.0000291572/vCPU-s + $0.0000038603/GB-s (peak × environment lifetime)',
    '- agentcorev1: $0.0895/vCPU-h + $0.00945/GB-h',
    '- agentcorev2: $0.1276/vCPU-h + $0.0169/GB-h',
    '',
    'Excluded as identical on every platform: model tokens, Titan embeddings, auth-token invocations, data transfer.',
    'The bill covers the same tagged resources — residual differences come from rounding, pricing-tier edges or untagged resources.',
    '',
  );

  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'report.md');
  writeFileSync(out, `${md.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);

  console.log(`Report (${platforms.length} platform(s), cost from ${source}) -> ${out}`);
  for (const p of platforms) {
    const t = traffic(p);
    const estimated = costOf(p);
    const bill = bills.get(p) ?? null;
    console.log(
      `  ${p}: requests ${t.requests} | estimated ${estimated !== null ? usd(estimated) : DASH} (${ratio(p)}) | ` +
        `billed ${bill !== null ? usd(bill.total) : DASH} (${bill !== null ? bill.window : 'not posted yet'})`,
    );
  }
}

main().catch((e) => {
  console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
