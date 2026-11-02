# Price-performance report — test2

_Generated 2026-11-01T15:31:20.378Z — cost: comparison.csv (analyze.ts), speed: speed.csv (analyze.ts), bills: bill/bill.csv (bill.ts, Cost Explorer)._

## Summary

| platform | requests | ok | errors | sessions | instances | calculated cost | cost vs lambdaevent | billed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lambdaevent | 10 | 10 | 0 | 10 | — | **$0.000384** | 1.0X | $0.000382 |
| lambdaweb | 10 | 10 | 0 | 10 | 5 | $0.001823 | 4.7X | $0.001904 |
| agentcorev1 | 10 | 10 | 0 | 10 | — | $0.004408 | 11.5X | $0.004416 |
| agentcorev2 | 10 | 10 | 0 | 10 | — | $0.013545 | 35.3X | $0.013553 |

Cheapest (calculated): **lambdaevent**.

`cost vs lambdaevent` — calculated cost as a multiple of lambdaevent's (the fixed reference); **1X = lambdaevent**, even when another platform is cheaper (it then shows < 1X).

Bills post ~24-72 h after the run — see [Estimated vs billed](#estimated-vs-billed-cost-explorer).

## Speed — first question of a session

The earliest request of each session: session setup, cold environment/init and the first model turn are all included.

| platform | requests | ok | errors | first byte p50 (s) | first answer char p50 (s) | full answer p50 (s) |
| --- | --- | --- | --- | --- | --- | --- |
| lambdaevent | 10 | 10 | 0 | 1.43 | 2.59 | 2.82 |
| lambdaweb | 10 | 10 | 0 | 0.90 | 1.99 | **2.19** |
| agentcorev1 | 10 | 10 | 0 | 2.10 | 3.43 | 3.56 |
| agentcorev2 | 10 | 10 | 0 | 3.05 | 4.54 | 4.60 |

Fastest first question of a session (full answer p50): **lambdaweb**

## Speed — follow-up questions (same session)

Later requests reusing a session: history is already server-side and the setup is already paid.

| platform | requests | ok | errors | first byte p50 (s) | first answer char p50 (s) | full answer p50 (s) |
| --- | --- | --- | --- | --- | --- | --- |
| lambdaevent | 0 | 0 | 0 | — | — | — |
| lambdaweb | 0 | 0 | 0 | — | — | — |
| agentcorev1 | 0 | 0 | 0 | — | — | — |
| agentcorev2 | 0 | 0 | 0 | — | — | — |

How to read the speed tables:

- **first byte** (`ttfb_p50_ms`) — POST sent → first response byte (the server accepted the request and started replying).
- **first answer char** (`first_char_p50_ms`) — POST sent → first visible answer character (the model started producing the answer).
- **full answer** (`total_p50_ms`) — POST sent → response complete.
- **p50 (median)** — half of the requests were faster than this; the report compares platforms on p50. (p95 values remain available in `speed.csv` / `analysis.csv`.)
- **first question of a session** — decided per `session_id`, not per wave: a shape reusing sessions across waves (e.g. the test3 shape) shows its follow-ups here, a `--new-session-each-request` shape shows none.

## Speed — sequential questions of a session

Median full answer by question number WITHIN a session (1st = first question, 2nd = first follow-up, …): how latency evolves as the conversation grows and the server-side history gets longer.

| platform | (no data) |
| --- | --- |
| lambdaevent | — |
| lambdaweb | — |
| agentcorev1 | — |
| agentcorev2 | — |

Each cell: median (sessions observed). A cell is only filled when at least one session had that question number — later numbers fill in only for shapes that reuse sessions.
All sessions in this test had a single question (every request used its own session, e.g. the `--new-session-each-request` shapes) — there is no sequence to compare. Session-reuse shapes (e.g. the test3 shape) fill this table.

## Calculated cost (published card rates)

| platform | cost | per request | per session | cost vs lambdaevent |
| --- | --- | --- | --- | --- |
| lambdaevent | **$0.000384** | **$0.00003839** | $0.00003839 | 1.0X |
| lambdaweb | $0.001823 | $0.00018230 | $0.00018230 | 4.7X |
| agentcorev1 | $0.004408 | $0.00044083 | $0.00044083 | 11.5X |
| agentcorev2 | $0.013545 | $0.00135453 | $0.00135453 | 35.3X |

### Detail lines (from analyze.ts)

- **lambdaevent**
  - 10 invocations; billed 28.64 GB-s; requests $0.000002 + compute $0.000382
- **lambdaweb**
  - 5 environments; total life 1984 s; requests 10 ($0.000003); cpu 5.2 s ($0.000150); memory 432.56 GB-s ($0.001670)
  - alive after last response: 394 s — tail cost $0.000344
- **agentcorev1**
  - 10 sessions; vCPU 0.008541 h ($0.000764); memory 0.3856 GB-h ($0.003644); 120 s idle tail per session included
- **agentcorev2**
  - 10 sessions; vCPU 0.018351 h ($0.002342); memory 0.6629 GB-h ($0.011204); 120 s idle tail per session included

## Estimated vs billed (Cost Explorer)

The bill is the ACTUAL tagged spend (Cost Explorer, tag `cost-experiment=<test>-<platform>`, region us-east-1) and posts ~24-72 h after the run — re-run this report once bill.ts shows a non-zero total.

| platform | estimated | billed | diff | diff % | bill window | status |
| --- | --- | --- | --- | --- | --- | --- |
| lambdaevent | $0.000384 | $0.000382 | -$0.000002 | -0.5% | 2026-10-30 | within 5% |
| lambdaweb | $0.001823 | $0.001904 | +$0.000081 | +4.4% | 2026-10-30 | within 5% |
| agentcorev1 | $0.004408 | $0.004416 | +$0.000008 | +0.2% | 2026-10-30 | within 5% |
| agentcorev2 | $0.013545 | $0.013553 | +$0.000008 | +0.1% | 2026-10-30 | within 5% |

### Bill breakdown (usage types)

#### lambdaevent — tag `test2-lambdaevent` (2 CE rows, 2026-10-30)

| usage_type | quantity | unit | cost |
| --- | --- | --- | --- |
| EU-Lambda-GB-Second-ARM | 28.64 | Lambda-GB-Second | $0.000382 |
| EU-Request-ARM | 10 | Requests | $0.000000 |
| **total** | — | — | **$0.000382** |

#### lambdaweb — tag `test2-lambdaweb` (4 CE rows, 2026-10-30)

| usage_type | quantity | unit | cost |
| --- | --- | --- | --- |
| EU-Lambda-Web-Memory-GB-Second-ARM | 432.8708818359 | GB-Seconds | $0.001671 |
| EU-Lambda-Web-vCPU-Second-ARM | 7.881 | vCPU-Seconds | $0.000230 |
| EU-Lambda-Web-Request-ARM | 10 | Requests | $0.000003 |
| EU-DataTransfer-Out-Bytes | 0.0000400804 | GB | $0.000000 |
| **total** | — | — | **$0.001904** |

#### agentcorev1 — tag `test2-agentcorev1` (5 CE rows, 2026-10-30)

| usage_type | quantity | unit | cost |
| --- | --- | --- | --- |
| EU-Runtime:Consumption-based:Memory | 0.3856037201 | GB-Hours | $0.003644 |
| EU-Runtime:Consumption-based:vCPU | 0.0085406586 | vCPU-Hours | $0.000764 |
| EU-DataTransfer-Regional-Bytes | 0.0007799333 | GB | $0.000008 |
| EU-DataTransfer-In-Bytes | 0.0000234861 | GB | $0.000000 |
| EU-DataTransfer-Out-Bytes | 0.0000464749 | GB | $0.000000 |
| **total** | — | — | **$0.004416** |

#### agentcorev2 — tag `test2-agentcorev2` (5 CE rows, 2026-10-30)

| usage_type | quantity | unit | cost |
| --- | --- | --- | --- |
| EU-Runtime:Consumption-based:Memory-v2 | 0.6629432109 | GB-Hours | $0.011204 |
| EU-Runtime:Consumption-based:vCPU-v2 | 0.0183505603 | vCPU-Hours | $0.002342 |
| EU-DataTransfer-Regional-Bytes | 0.000678747 | GB | $0.000007 |
| EU-DataTransfer-In-Bytes | 0.0000234861 | GB | $0.000000 |
| EU-DataTransfer-Out-Bytes | 0.0000404083 | GB | $0.000000 |
| **total** | — | — | **$0.013553** |

## Pricing model (keep in sync with analyze.ts)

- lambdaevent: $0.20/1M requests + $0.0000133334/GB-s (1024 MB memory)
- lambdaweb: $0.30/1M requests + $0.0000291572/vCPU-s + $0.0000038603/GB-s (peak × environment lifetime)
- agentcorev1: $0.0895/vCPU-h + $0.00945/GB-h
- agentcorev2: $0.1276/vCPU-h + $0.0169/GB-h

Excluded as identical on every platform: model tokens, Titan embeddings, auth-token invocations, data transfer.
The bill covers the same tagged resources — residual differences come from rounding, pricing-tier edges or untagged resources.

