/**
 * send.ts — fires the load test's questions at the agent and appends one row
 * per request to results/<test>/<platform>/performance/performance.csv. The
 * test shape comes 100% from parameters (nothing hardcoded):
 *
 *   --requests N                 questions per wave = distinct sessions (required)
 *   --parallel N                 requests fired concurrently (default = requests)
 *   --waves N                    wave repetitions (default 1); total = requests x waves
 *   --gap-seconds N              pause after each batch/wave completes (default 0)
 *   --new-session-each-request   every request uses a NEW session (default: the
 *                                same session per slot across waves)
 *
 * Parallel requests always fire with a built-in stagger: the SECOND request
 * starts 600 ms after the first, every further request trails the previous
 * one by 50 ms (slot i starts 600 + (i−1)*50 ms late). The stagger spreads
 * arrivals so the LambdaWeb platform REUSES the same warm instance instead
 * of scaling out: requests arriving in the same instant spawn a new instance
 * each (10 at once → 8 instances in the measured runs), and every instance
 * bills its full lifetime, ~400 s drain tail included.
 *   --test <name>     label only: stack prefix, results folder, session prefix
 *   --platform ...               lambdaevent|lambdaweb|agentcorev1|agentcorev2
 *
 * CSV columns: timestamp_start_utc,timestamp_end_utc,session_id,wave,ok,error,
 * ttfb_ms,first_char_ms,total_ms,tool_calls. test/platform are the folder path;
 * bill.ts reads timestamp_start_utc positionally — keep it column 0. A CSV with
 * a different header is NOT append-compatible — archive old results first.
 *
 * total_ms covers the agent invoke only — the JWT is minted once per batch,
 * before the clock starts (old CSV rows included the mint; don't mix eras).
 *
 * Every invocation also appends one JSONL line to
 * results/<test>/<platform>/transcripts/<session_id>.jsonl — the full request
 * (url, headers, body) and response (status, metrics, events, answer text) of
 * that session's turn. A session reused across waves appends one line per
 * wave (each carries its `wave` number).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { InvokeResult } from './agent.js';
import { agentUrl, fetchToken, invoke, PLATFORMS, turnBody } from './agent.js';

const HEADER =
  'timestamp_start_utc,timestamp_end_utc,session_id,wave,ok,error,ttfb_ms,first_char_ms,total_ms,tool_calls';

/** Stagger inside a parallel batch (ms): the first request fires immediately,
 * the SECOND waits 600 ms (the first instance gets a head start), and every
 * further request trails the previous one by 50 ms — slot i fires at
 * 600 + (i−1)*50 ms. Keeps arrivals spread so LambdaWeb reuses one warm
 * instance instead of scaling out. */
const staggerMs = (i: number): number => (i <= 0 ? 0 : 600 + (i - 1) * 50);

const clean = (text: string): string => text.replace(/[,;"\n\r]/g, ' ').slice(0, 180);
const seconds = (ms: number | null | undefined): string =>
  typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '-';
const wait = (s: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, s * 1000));

function loadQuestions(): string[] {
  const file = path.resolve(import.meta.dirname, 'questions.json');
  if (!existsSync(file))
    throw new Error(`Missing ${file} — run npx tsx price-perfomance-test/gen-questions.ts first.`);
  return JSON.parse(readFileSync(file, 'utf-8')) as string[];
}

/** One request: invoke the agent, append its CSV row as soon as it finishes
 * and append the full request/response pair to the session's transcript file
 * (one <session>.jsonl per session — reused sessions accumulate one line per
 * wave). The bearer token is logged as-is: the toy per-test JWT with a 1 h
 * TTL, minted by the caller before the clock starts. */
async function sendOne(
  url: string,
  dir: string,
  transcripts: string,
  session: string,
  question: string,
  wave: number,
  index: number,
  token: string,
): Promise<void> {
  const start = Date.now();
  const body = turnBody(session, question);
  let result: InvokeResult | null = null;
  let caught = '';
  try {
    result = await invoke(url, token, session, body);
  } catch (e) {
    caught = e instanceof Error ? e.message : String(e);
  }
  const end = Date.now();
  const error = clean(result?.error || caught || (result?.ok ? '' : 'run did not finish'));
  const ok = result?.ok && error === '';
  appendFileSync(
    path.join(dir, 'performance.csv'),
    `${[
      new Date(start).toISOString(),
      new Date(end).toISOString(),
      session,
      wave,
      ok ? 1 : 0,
      error,
      result ? result.ttfbMs : '',
      result && result.firstCharMs !== null ? result.firstCharMs : '',
      end - start,
      result ? result.toolCalls : '',
    ].join(',')}\n`,
  );
  appendFileSync(
    path.join(transcripts, `${session}.jsonl`),
    `${JSON.stringify({
      timestamp: new Date(start).toISOString(),
      wave,
      index,
      ok,
      request: {
        url,
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-amzn-bedrock-agentcore-runtime-session-id': session,
        },
        body,
      },
      response: result
        ? {
            status: result.status,
            ok: result.ok,
            error: result.error,
            ttfbMs: result.ttfbMs,
            firstCharMs: result.firstCharMs,
            wallMs: result.wallMs,
            toolCalls: result.toolCalls,
            chars: result.chars,
            text: result.text,
            events: result.events,
          }
        : { error: caught || 'no response (invoke threw before returning)' },
    })}\n`,
  );
  console.log(
    `[${index}] wave ${wave} ${session} ${ok ? 'ok' : `ERROR: ${error}`} total ${seconds(end - start)} ttfb ${seconds(result?.ttfbMs)}`,
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      test: { type: 'string' },
      platform: { type: 'string' },
      requests: { type: 'string' },
      parallel: { type: 'string' },
      waves: { type: 'string' },
      'gap-seconds': { type: 'string' },
      'new-session-each-request': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: npx tsx price-perfomance-test/send.ts --test <name> --platform <platform> --requests N [--parallel N] [--waves N] [--gap-seconds N] [--new-session-each-request]',
    );
    return;
  }
  const num = (v: string | undefined, name: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      console.error(`ERROR: --${name} must be a number >= 0 (got "${v}").`);
      process.exit(1);
    }
    return n;
  };

  const test = values.test ?? '';
  const platform = values.platform ?? '';
  if (!/^[a-z0-9]+$/.test(test)) {
    console.error(
      `ERROR: --test is required (a lowercase alphanumeric label, e.g. proba). Got "${test}".`,
    );
    process.exit(1);
  }
  if (!PLATFORMS.includes(platform as never)) {
    console.error(`ERROR: --platform is required (${PLATFORMS.join('|')})`);
    process.exit(1);
  }
  const requests = num(values.requests, 'requests');
  if (requests === undefined || requests < 1) {
    console.error('ERROR: --requests N is required (>= 1).');
    process.exit(1);
  }
  const waves = num(values.waves, 'waves') ?? 1;
  if (waves < 1) {
    console.error('ERROR: --waves must be >= 1.');
    process.exit(1);
  }
  const parallel = Math.max(1, num(values.parallel, 'parallel') ?? requests); // the batch builder caps it at requests
  const gap = num(values['gap-seconds'], 'gap-seconds') ?? 0;
  const newSessionEachRequest = values['new-session-each-request'] === true;

  const questions = loadQuestions();
  const total = requests * waves;
  if (total > questions.length) {
    throw new Error(
      `questions.json has ${questions.length} questions but the shape needs ${total} (${requests} x ${waves}) — run npx tsx price-perfomance-test/gen-questions.ts.`,
    );
  }

  const url = agentUrl(test, platform);
  const dir = path.resolve(import.meta.dirname, 'results', test, platform, 'performance');
  mkdirSync(dir, { recursive: true });
  const transcripts = path.resolve(import.meta.dirname, 'results', test, platform, 'transcripts');
  mkdirSync(transcripts, { recursive: true });
  const csv = path.join(dir, 'performance.csv');
  if (!existsSync(csv)) writeFileSync(csv, `${HEADER}\n`);
  const runStamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

  console.log(`Sending ${test} -> ${platform}`);
  console.log(
    `Shape: ${total} requests (${requests} x ${waves} waves, ${parallel} in parallel, gap ${gap}s, stagger 600ms then 50ms, ${newSessionEachRequest ? 'NEW session per request' : 'same session per slot'})`,
  );
  console.log(`URL: ${url}`);
  console.log(`CSV: ${csv}`);
  console.log(`Transcripts: ${transcripts}`);

  for (let wave = 1; wave <= waves; wave++) {
    for (let start = 0; start < requests; start += parallel) {
      const batch: number[] = Array.from(
        { length: Math.min(parallel, requests - start) },
        (_, i: number) => start + i,
      );
      if (parallel > 1)
        console.log(`Wave ${wave}/${waves}: firing ${batch.length} requests in parallel...`);
      // One JWT per batch, minted before the requests' clock starts.
      const token = await fetchToken(test);
      await Promise.all(
        batch.map((slot, i) => {
          const suffix = newSessionEachRequest ? `-w${wave}` : '';
          const session = `loadtest-${test}-${platform}-${runStamp}-${slot + 1}${suffix}`;
          const question = questions[(wave - 1) * requests + slot];
          const fire = async (): Promise<void> => {
            if (i > 0) await wait(staggerMs(i) / 1000);
            await sendOne(
              url,
              dir,
              transcripts,
              session,
              question,
              wave,
              (wave - 1) * requests + slot + 1,
              token,
            );
          };
          return fire();
        }),
      );
      if (gap > 0) {
        console.log(`Waiting ${gap}s...`);
        await wait(gap);
      }
    }
  }
  console.log(`Done: ${total} rows in ${csv}`);
  console.log(
    `Next: npx tsx price-perfomance-test/download-logs.ts --test ${test} --platform ${platform}`,
  );
}

main().catch((e) => {
  console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
