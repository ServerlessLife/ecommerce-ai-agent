/**
 * logs-to-csv.ts — converts the downloaded CloudWatch logs (results/<test>/<platform>/logs/*.jsonl,
 * written by download-logs.ts) into a single CSV per platform: results/<test>/<platform>/logs/logs.csv
 *
 * Row layout per platform:
 *   lambdaevent: Lambda "REPORT" summary lines
 *     -> timestamp_utc,request_id,duration_ms,billed_duration_ms,init_duration_ms,memory_size_mb,max_memory_mb
 *   lambdaweb:   Lambda Web Adapter "platform.*" events
 *     -> timestamp_utc,event_type,environment_id,requests,duration_ms,cpu_ms,init_duration_ms,max_memory_mb
 *   agentcore:   AgentCore usage records (same format for v1 and v2)
 *     -> timestamp_utc,session_id,time_elapsed_seconds,vcpu_hours,memory_gb_hours
 *
 * Usage: npx tsx price-perfomance-test/logs-to-csv.ts --test test1 --platform lambdaweb
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

/** One downloaded CloudWatch event (the JSON line format download-logs.ts writes). */
type RawEvent = { timestamp: number; stream: string; message: string };

/** One CSV row: values contain no commas, so a plain join is safe. */
type Row = (string | number)[];

/** A platform's CSV spec: header line + how to turn raw events into rows. */
type PlatformSpec = {
  header: string;
  parse: (events: RawEvent[]) => Row[];
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const iso = (ms: number): string => new Date(ms).toISOString();

/** Number as string, or empty string for anything else (keeps CSV cells blank). */
const numTxt = (v: unknown): string => (typeof v === 'number' ? String(v) : '');

/** JSON.parse that returns undefined instead of throwing — log lines may be blank or corrupt. */
function parseJson<T>(line: string): T | undefined {
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Reading the raw log files
// ---------------------------------------------------------------------------

/** Read every *.jsonl file in `dir` into one list, sorted by timestamp. */
function readEvents(dir: string): RawEvent[] {
  const events: RawEvent[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    // One JSON object per line: {"timestamp": ms, "stream": "...", "message": "..."}.
    // Blank or corrupt lines are skipped (download-logs.ts may even write empty files).
    for (const line of readFileSync(path.join(dir, name), 'utf-8').split('\n')) {
      const ev = parseJson<RawEvent>(line);
      if (typeof ev?.timestamp !== 'number') continue;
      events.push({
        timestamp: ev.timestamp,
        stream: String(ev.stream ?? ''),
        message: String(ev.message ?? ''),
      });
    }
    console.log(`Read ${name}`);
  }
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

// ---------------------------------------------------------------------------
// Per-platform parsers (each maps one event to zero or one CSV row)
// ---------------------------------------------------------------------------

/**
 * Lambda's "REPORT RequestId: ... Duration: 123.45 ms  Billed Duration: 124 ms
 * Memory Size: 512 MB  Max Memory Used: 78 MB  Init Duration: 200.10 ms" summary.
 * Init Duration is only present for cold starts, hence the optional group.
 */
const REPORT_RE =
  /REPORT RequestId: (\S+).*?Duration: ([\d.]+) ms.*?Billed Duration: (\d+) ms.*?Memory Size: (\d+) MB.*?Max Memory Used: (\d+) MB(?:\s*Init Duration: ([\d.]+) ms)?/;

const lambdaEvent: PlatformSpec = {
  header:
    'timestamp_utc,request_id,duration_ms,billed_duration_ms,init_duration_ms,memory_size_mb,max_memory_mb',
  parse: (events) =>
    events.flatMap((e) => {
      const m = e.message.match(REPORT_RE);
      if (!m) return [];
      return [[iso(e.timestamp), m[1], m[2], m[3], m[6] ?? '', m[4], m[5]]];
    }),
};

/** Message shape of Lambda Web Adapter platform.* events. */
type WebEvent = {
  type?: string;
  record?: { instanceId?: string; metrics?: Record<string, number> };
};

const lambdaWeb: PlatformSpec = {
  header:
    'timestamp_utc,event_type,environment_id,requests,duration_ms,cpu_ms,init_duration_ms,max_memory_mb',
  parse: (events) =>
    events.flatMap((e) => {
      const ev = parseJson<WebEvent>(e.message);
      const type = ev?.type ?? '';
      if (!type.startsWith('platform.')) return [];
      const m = ev?.record?.metrics ?? {};
      return [
        [
          iso(e.timestamp),
          type,
          // Fall back to the log stream name when the record has no instance id.
          ev?.record?.instanceId ?? e.stream,
          numTxt(m.requests ?? m.totalRequests),
          // totalDurationMs is the invoke duration; init events report it as the init duration.
          numTxt(type === 'platform.invokeReport' ? m.totalDurationMs : undefined),
          numTxt(m.cpuTimeMs ?? m.totalCpuTimeMs),
          numTxt(type === 'platform.initReport' ? m.totalDurationMs : undefined),
          numTxt(m.maxMemoryUsageMb),
        ],
      ];
    }),
};

/**
 * Message shape of AgentCore usage records. The JSON payload has attributes and
 * metrics at its top level, but accept an optional OTel-style `record` wrapper.
 */
type AgentCoreEvent = {
  attributes?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  record?: { attributes?: Record<string, unknown>; metrics?: Record<string, unknown> };
};

const agentCore: PlatformSpec = {
  header: 'timestamp_utc,session_id,time_elapsed_seconds,vcpu_hours,memory_gb_hours',
  parse: (events) =>
    events.flatMap((e) => {
      const rec = parseJson<AgentCoreEvent>(e.message);
      const a = rec?.attributes ?? rec?.record?.attributes;
      if (!a) return [];
      const m = rec?.metrics ?? rec?.record?.metrics ?? {};
      return [
        [
          iso(e.timestamp),
          String(a['session.id'] ?? ''),
          numTxt(a.time_elapsed_seconds),
          numTxt(m['agent.runtime.vcpu.hours.used']),
          numTxt(m['agent.runtime.memory.gb_hours.used']),
        ],
      ];
    }),
};

// ---------------------------------------------------------------------------
// CLI + writing the CSV
// ---------------------------------------------------------------------------

const PLATFORMS: Record<string, PlatformSpec> = {
  lambdaevent: lambdaEvent,
  lambdaweb: lambdaWeb,
  agentcorev1: agentCore,
  agentcorev2: agentCore,
};

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
      `Usage: npx tsx price-perfomance-test/logs-to-csv.ts --test <name> --platform ${Object.keys(PLATFORMS).join('|')}`,
    );
    return;
  }
  const { test, platform } = values;
  if (!test || !platform) throw new Error('--test and --platform are required.');

  const spec = PLATFORMS[platform];
  if (!spec)
    throw new Error(
      `Unknown platform "${platform}". Choose one of: ${Object.keys(PLATFORMS).join(', ')}`,
    );

  const dir = path.resolve(import.meta.dirname, 'results', test, platform, 'logs');
  if (!existsSync(dir)) throw new Error(`No ${dir} — run download-logs.ts first.`);

  const events = readEvents(dir);
  const rows = spec.parse(events);

  const out = path.join(dir, 'logs.csv');
  writeFileSync(out, `${[spec.header, ...rows.map((r) => r.join(','))].join('\n')}\n`);

  console.log(`${rows.length} cost/usage rows -> ${out}`);
  console.log(
    `Next step: npx tsx price-perfomance-test/analyze.ts --test ${test}` +
      (rows.length ? '' : ' (warning: 0 rows!)'),
  );
}

main().catch((e) => {
  console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
