# Cost tests — runbook (price-perfomance-test/)

Compare the four platforms — **Lambda Event Function (LambdaEvent),
Lambda Web Function (LambdaWeb), AgentCore V1, AgentCore V2** — on **speed
and price** with three fixed test shapes,
executed manually with five simple scripts. Design:
[`../docs/plan/cost-tests-plan.md`](../docs/plan/cost-tests-plan.md).

## Prerequisites (once)

1. `aws sso login` (default profile)
2. `npx tsx price-perfomance-test/gen-questions.ts` —
   `price-perfomance-test/questions.json` must hold ≥ 200 questions (test3
   consumes 200).
3. The `cost-experiment` tag must be an **activated cost-allocation tag**
   (`aws ce list-cost-allocation-tags --region us-east-1` → `Status: Active`).
4. **Quiet window** while a test runs — no other traffic.

## Deployment

There is NO separate test infrastructure: the deploy commands below deploy
the SAME demo stacks under the environment-prefixed name
(`-c environment=test1` → `Test1SampleSharedStack`,
`Test1SampleAgentLambdaWebStack` …), each carrying the derived
`cost-experiment` billing tag (`test1-lambdaweb`, `test1-agentcorev1`, …).
The shared stack is prefixed TOO: **every environment deploys its OWN data**
(`sample-products-test1` table, `sample-conversations-test1` sessions bucket
prefix) **and its own auth leg**, so no demo table is ever touched. The widget
stack is not synthesized.

**Seeding — REQUIRED after EVERY environment deploy** (the environment's
products table starts empty; the agent's `search_products` tool needs the
embedded catalog before the first request):

```bash
AWS_REGION=eu-west-1 npx tsx scripts/seed.ts --environment test1
```

`npm run deploy:test -- test1` (repo root) chains all three post-deploy
steps — deploy, seed, endpoint re-tag — in one command (see TEST 1 below).

The `--environment` value must match the deploy's `-c environment=…` — the
script reads the table name from that environment's OWN outputs file
`infra/cdk-outputs-<environment>.json`, which the deploy just wrote. Every
environment gets its own file, so coexisting environments never overwrite
each other's outputs.

**AgentCore extra step (after EVERY AgentCore V1/V2 deploy)** — re-tag the
service-created DEFAULT endpoint child (it never inherits tags; usage
records attribute to it). ONE command tags BOTH runtimes (V1 + V2):

```bash
# repo root:
npx tsx price-perfomance-test/tag-endpoints.ts --test test1
```

(Equivalent with your test's label, e.g. `--test test2`. It reads the runtime
ids and tag values from `infra/cdk-outputs-<test>.json` — run it after the
deploy.)

### `send.ts` parameters (the test shape is NOT hardcoded)

`--test` is only a LABEL (stack prefix, results folder, session-id prefix) —
the traffic shape comes entirely from parameters:

```
--requests N                 questions per wave = distinct sessions (required)
--parallel N                 requests fired concurrently (default = requests)
--waves N                    wave repetitions (default 1); total = requests x waves
--gap-seconds N              pause after each batch/wave completes (default 0)
--new-session-each-request   every request uses a NEW session (default: the
                             same session per slot across waves)

Parallel requests always fire with a built-in stagger: the SECOND request
starts **600 ms** after the first, and every further request trails the
previous one by **50 ms** (request i starts 600 + (i−1)×50 ms late).

Why: when many requests arrive in the same instant, the LambdaWeb platform
scales OUT instead of queueing — 10 simultaneous requests spawned 8 instances
in the measured runs, and every spawned instance is billed for its whole
lifetime, including the ~400 s drain tail after its last request. The
stagger spreads the arrivals so the scheduler routes the follow-up requests
to the **same, still-warm instance** rather than spawning fresh ones —
fewer instances, less billed instance time.
```

The commands in the three test sections below are the recommended
equivalents of the original test1/test2/test3 shapes — any other
requests/parallel/waves/gap combination runs the same way.

## TEST 1 — sparse single-shot traffic

**Shape:** 20 questions, ONE question every 10 minutes (600 s, sent after
the previous completes), a NEW session each time, strictly sequential.
~3.5 hours wall time. **Start before ~20:30 UTC** — the run must not cross
midnight UTC or the tag's usage splits across two billing days.

**1. Deploy ALL stacks of the test in ONE command (`--all` = the shared stack
(own tables + auth) + the four platform stacks, deployed sequentially in
dependency order; the widget stack is not synthesized when `environment` is
set) — and seed + re-tag with the SAME command, from the repo root:**

```bash
# deploy + seed + re-tag the DEFAULT endpoints, one command:
npm run deploy:test -- test1
```

Equivalent manual steps (each environment's deploy writes its OWN outputs
file `infra/cdk-outputs-<environment>.json` — coexisting environments never
overwrite each other):

```bash
cd infra
AWS_REGION=eu-west-1 npx cdk deploy --all -c environment=test1 \
  --require-approval never --outputs-file cdk-outputs-test1.json
cd ..

# 2. seed the environment's OWN (empty) products table — required after
#    every deploy of this environment:
AWS_REGION=eu-west-1 npx tsx scripts/seed.ts --environment test1

# 3. re-tag the AgentCore DEFAULT endpoints (service-created, never inherits
#    tags; usage records attribute to it) — one command, both runtimes:
npx tsx price-perfomance-test/tag-endpoints.ts --test test1
```

(Or one platform at a time — same command with the single stack name:
`npx cdk deploy Test1SampleAgentLambdaWebStack -c environment=test1 …`. If
you deploy platform by platform, seed once after the FIRST deploy.)

**3–7. Send, download, transform, analyze, bill (per platform):**

```bash
# 3. send the load — one question every 10 min, new session each
#    (run one platform's send to completion before the next)
npx tsx price-perfomance-test/send.ts --test test1 --platform lambdaevent \
  --requests 20 --parallel 1 --gap-seconds 600 --new-session-each-request
npx tsx price-perfomance-test/send.ts --test test1 --platform lambdaweb \
  --requests 20 --parallel 1 --gap-seconds 600 --new-session-each-request
npx tsx price-perfomance-test/send.ts --test test1 --platform agentcorev1 \
  --requests 20 --parallel 1 --gap-seconds 600 --new-session-each-request
npx tsx price-perfomance-test/send.ts --test test1 --platform agentcorev2 \
  --requests 20 --parallel 1 --gap-seconds 600 --new-session-each-request

# 4. download the window's logs (grace default 60 min covers AgentCore
#    telemetry lag + the LambdaWeb drain tail; groups come from the stack
#    outputs in infra/cdk-outputs-<test>.json)
npx tsx price-perfomance-test/download-logs.ts --test test1 --platform lambdaevent
npx tsx price-perfomance-test/download-logs.ts --test test1 --platform lambdaweb
npx tsx price-perfomance-test/download-logs.ts --test test1 --platform agentcorev1
npx tsx price-perfomance-test/download-logs.ts --test test1 --platform agentcorev2

# 5. transform the logs into the cost/usage CSV
npx tsx price-perfomance-test/logs-to-csv.ts --test test1 --platform lambdaevent
npx tsx price-perfomance-test/logs-to-csv.ts --test test1 --platform lambdaweb
npx tsx price-perfomance-test/logs-to-csv.ts --test test1 --platform agentcorev1
npx tsx price-perfomance-test/logs-to-csv.ts --test test1 --platform agentcorev2

# 6. analyze — speed + cost (writes analysis.csv, prints the summary)
npx tsx price-perfomance-test/analyze.ts --test test1 --platform lambdaevent
npx tsx price-perfomance-test/analyze.ts --test test1 --platform lambdaweb
npx tsx price-perfomance-test/analyze.ts --test test1 --platform agentcorev1
npx tsx price-perfomance-test/analyze.ts --test test1 --platform agentcorev2

# 7. after the day's bill posts (~24-72 h): download the bill for the tag
npx tsx price-perfomance-test/bill.ts --test test1 --platform lambdaevent
npx tsx price-perfomance-test/bill.ts --test test1 --platform lambdaweb
npx tsx price-perfomance-test/bill.ts --test test1 --platform agentcorev1
npx tsx price-perfomance-test/bill.ts --test test1 --platform agentcorev2
```

What it proves: with one request per 10 minutes every LambdaWeb request pays
a full environment lifetime (init + request + drain tail), while LambdaEvent
pays only per-invocation billed duration and AgentCore pays the session
microVM for its ~2-min idle tail.

## TEST 2 — burst traffic

**Shape:** 10 questions in parallel, 10 different sessions, ONCE. ~1 min.
The parallel requests fire with the built-in stagger: **600 ms** after the
first request, then **50 ms** between consecutive launches.

**1. Deploy ALL stacks of the test in ONE command (deploy + seed + re-tag):**

```bash
npm run deploy:test -- test2
```

(Equivalent manual steps: see the TEST 1 block above — `cd infra`, the
`cdk deploy --all` command with `-c environment=test2`, `cd ..`, then
`seed.ts --environment test2` and `tag-endpoints.ts --test test2`.)

(Or one platform at a time — same command with the single stack name:
`npx cdk deploy Test2SampleAgentLambdaWebStack -c environment=test2 …`. If
you deploy platform by platform, seed once after the FIRST deploy.)

**3–7. Send, download, transform, analyze, bill (per platform):**

```bash
# 3. send — 10 parallel requests, one wave
#    (run one platform's send to completion before the next)
npx tsx price-perfomance-test/send.ts --test test2 --platform lambdaevent \
  --requests 10 --parallel 10
npx tsx price-perfomance-test/send.ts --test test2 --platform lambdaweb \
  --requests 10 --parallel 10
npx tsx price-perfomance-test/send.ts --test test2 --platform agentcorev1 \
  --requests 10 --parallel 10
npx tsx price-perfomance-test/send.ts --test test2 --platform agentcorev2 \
  --requests 10 --parallel 10

# 4. download the window's logs
npx tsx price-perfomance-test/download-logs.ts --test test2 --platform lambdaevent
npx tsx price-perfomance-test/download-logs.ts --test test2 --platform lambdaweb
npx tsx price-perfomance-test/download-logs.ts --test test2 --platform agentcorev1
npx tsx price-perfomance-test/download-logs.ts --test test2 --platform agentcorev2

# 5. transform the logs into the cost/usage CSV
npx tsx price-perfomance-test/logs-to-csv.ts --test test2 --platform lambdaevent
npx tsx price-perfomance-test/logs-to-csv.ts --test test2 --platform lambdaweb
npx tsx price-perfomance-test/logs-to-csv.ts --test test2 --platform agentcorev1
npx tsx price-perfomance-test/logs-to-csv.ts --test test2 --platform agentcorev2

# 6. analyze — speed + cost
npx tsx price-perfomance-test/analyze.ts --test test2 --platform lambdaevent
npx tsx price-perfomance-test/analyze.ts --test test2 --platform lambdaweb
npx tsx price-perfomance-test/analyze.ts --test test2 --platform agentcorev1
npx tsx price-perfomance-test/analyze.ts --test test2 --platform agentcorev2

# 7. after the day's bill posts (~24-72 h): download the bill for the tag
npx tsx price-perfomance-test/bill.ts --test test2 --platform lambdaevent
npx tsx price-perfomance-test/bill.ts --test test2 --platform lambdaweb
npx tsx price-perfomance-test/bill.ts --test test2 --platform agentcorev1
npx tsx price-perfomance-test/bill.ts --test test2 --platform agentcorev2
```

What it proves: a 10-request burst lands on few warm LambdaWeb environments —
the drain tail is amortized and LambdaWeb comes out CHEAPER than LambdaEvent
(per-invocation init × 10).

## TEST 3 — sustained conversation

**Shape:** 20 sessions in parallel per wave, the SAME session per slot across
waves (server-side history carries over), next wave 60 s after the previous
completes. 10 waves × 20 = 200 requests, ~11 min. The parallel requests fire
with the built-in stagger: **600 ms** after the first request of the wave,
then **50 ms** between consecutive launches.

**1. Deploy ALL stacks of the test in ONE command (deploy + seed + re-tag):**

```bash
npm run deploy:test -- test3
```

(Equivalent manual steps: see the TEST 1 block above — `cd infra`, the
`cdk deploy --all` command with `-c environment=test3`, `cd ..`, then
`seed.ts --environment test3` and `tag-endpoints.ts --test test3`.)

(Or one platform at a time — same command with the single stack name:
`npx cdk deploy Test3SampleAgentLambdaWebStack -c environment=test3 …`. If
you deploy platform by platform, seed once after the FIRST deploy.)

**3–7. Send, download, transform, analyze, bill (per platform):**

```bash
# 3. send — 10 waves × 20 parallel requests, same session per slot
#    (run one platform's send to completion before the next)
npx tsx price-perfomance-test/send.ts --test test3 --platform lambdaevent \
  --requests 20 --parallel 20 --waves 10 --gap-seconds 60
npx tsx price-perfomance-test/send.ts --test test3 --platform lambdaweb \
  --requests 20 --parallel 20 --waves 10 --gap-seconds 60
npx tsx price-perfomance-test/send.ts --test test3 --platform agentcorev1 \
  --requests 20 --parallel 20 --waves 10 --gap-seconds 60
npx tsx price-perfomance-test/send.ts --test test3 --platform agentcorev2 \
  --requests 20 --parallel 20 --waves 10 --gap-seconds 60

# 4. download the window's logs
npx tsx price-perfomance-test/download-logs.ts --test test3 --platform lambdaevent
npx tsx price-perfomance-test/download-logs.ts --test test3 --platform lambdaweb
npx tsx price-perfomance-test/download-logs.ts --test test3 --platform agentcorev1
npx tsx price-perfomance-test/download-logs.ts --test test3 --platform agentcorev2

# 5. transform the logs into the cost/usage CSV
npx tsx price-perfomance-test/logs-to-csv.ts --test test3 --platform lambdaevent
npx tsx price-perfomance-test/logs-to-csv.ts --test test3 --platform lambdaweb
npx tsx price-perfomance-test/logs-to-csv.ts --test test3 --platform agentcorev1
npx tsx price-perfomance-test/logs-to-csv.ts --test test3 --platform agentcorev2

# 6. analyze — speed + cost
npx tsx price-perfomance-test/analyze.ts --test test3 --platform lambdaevent
npx tsx price-perfomance-test/analyze.ts --test test3 --platform lambdaweb
npx tsx price-perfomance-test/analyze.ts --test test3 --platform agentcorev1
npx tsx price-perfomance-test/analyze.ts --test test3 --platform agentcorev2

# 7. after the day's bill posts (~24-72 h): download the bill for the tag
npx tsx price-perfomance-test/bill.ts --test test3 --platform lambdaevent
npx tsx price-perfomance-test/bill.ts --test test3 --platform lambdaweb
npx tsx price-perfomance-test/bill.ts --test test3 --platform agentcorev1
npx tsx price-perfomance-test/bill.ts --test test3 --platform agentcorev2
```

What it proves: sustained-conversation economics — sessions stay warm, every
turn after the first skips the setup, AgentCore sessions hold billed memory
for the whole window (idle 120 s tail per session × 20), and the demo agent's
rolling window evicts old turns around turn 3–4 (identical on every platform).

## Cross-platform comparison + bill checks

```bash
# after a test ran on every platform: one table, all platforms
npx tsx price-perfomance-test/analyze.ts --test test1
```

```bash
# 8. markdown report for ALL platforms — summary, speed, calculated cost,
#    and (where bill/bill.csv has rows) estimated-vs-billed + bill breakdowns.
#    Run it right after analyze; RE-RUN it after the bill posts (~24-72 h) to
#    add the bill comparison. Reads local files only (no AWS calls).
npx tsx price-perfomance-test/report.ts --test test1
```

`analyze.ts` prices at the published cards (lambdaevent $0.20/1M req +
$0.0000133334/GB-s; lambdaweb $0.30/1M req + $0.0000291572/vCPU-s +
$0.0000038603/GB-s over peak × environment lifetime; agentcorev1
$0.0895/vCPU-h + $0.00945/GB-h; agentcorev2 $0.1276/vCPU-h + $0.0169/GB-h)
and reports the LambdaWeb **alive-after-last-request** drain tail per
environment and in total. Excluded as identical-on-all-sides: model tokens,
Titan embed, auth-token invocations, data transfer. `bill.csv` is the
Cost Explorer cross-check for the tag (posts ~24–72 h after the run).
In BOTH modes `analyze.ts` also writes `results/<test>/speed.csv` — the
latency detail (first question of a session vs follow-ups vs the sequential
question numbers) — which `report.ts` renders into `report.md`; report.ts
does no calculation of its own, it only formats the CSVs.

## Result tree

```
price-perfomance-test/results/test1/lambdaweb/
  performance/performance.csv   ← one row per request (appended live)
  logs/<log-group-slug>.jsonl   ← raw CloudWatch download
  logs/logs.csv                 ← transformed usage/cost rows
  analysis.csv                  ← speed + cost summary
  bill/bill.csv                 ← Cost Explorer rows for the tag
price-perfomance-test/results/test1/comparison.csv   ← cross-platform
price-perfomance-test/results/test1/speed.csv        ← latency detail: first vs follow-ups + sequential question numbers (analyze.ts)
price-perfomance-test/results/test1/report.md        ← markdown report (all platforms; estimated vs billed where the bill posted)
```

## Cautions

- Deploy all four platforms together if you like — but SEND traffic to one
  platform at a time (quiet window for the platform under test; the idle
  stacks cost nothing).
- **Seed after every (re)deploy of an environment** — the deploy may replace
  the environment's tables (DESTROY removal policy), and the products table
  must hold the embedded catalog before the first request.
- AgentCore V2 deploys take minutes (snapshot prep). After every AgentCore
  deploy run the one-command re-tag: `tag-endpoints.ts`.
- Fresh auth token per batch, minted before the requests start (TTL 1 h) —
  `send.ts` handles it (from the TEST's own auth leg — each environment
  carries its own).

## End-of-campaign cleanup

Destroy uses the name patterns — one command per environment (the `-c`
contexts must be passed one command at a time — the last `-c environment=…`
wins, so combining them into one command only ever matches one environment).
Each pattern now ALSO destroys that environment's own shared stack (tables +
auth) — the per-environment tables are DESTROY-policy and vanish with it:

```bash
cd infra
AWS_REGION=eu-west-1 npx cdk destroy 'Test1*' -c environment=test1 --require-approval never
AWS_REGION=eu-west-1 npx cdk destroy 'Test2*' -c environment=test2 --require-approval never
AWS_REGION=eu-west-1 npx cdk destroy 'Test3*' -c environment=test3 --require-approval never
```
