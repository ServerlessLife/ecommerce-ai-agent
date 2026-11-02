# Price-performance report — test1

_Generated 2026-11-01T15:31:17.703Z — cost: comparison.csv (analyze.ts), speed: speed.csv (analyze.ts), bills: bill/bill.csv (bill.ts, Cost Explorer)._

## Summary

| platform | requests | ok | errors | sessions | instances | calculated cost | cost vs lambdaevent | billed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lambdaevent | 20 | 20 | 0 | 20 | — | **$0.000895** | 1.0X | $0.000891 |
| lambdaweb | 20 | 20 | 0 | 20 | 20 | $0.006794 | 7.6X | $0.007082 |
| agentcorev1 | 20 | 20 | 0 | 20 | — | $0.008995 | 10.1X | $0.009011 |
| agentcorev2 | 20 | 20 | 0 | 20 | — | $0.026235 | 29.3X | $0.026253 |

Cheapest (calculated): **lambdaevent**.

`cost vs lambdaevent` — calculated cost as a multiple of lambdaevent's (the fixed reference); **1X = lambdaevent**, even when another platform is cheaper (it then shows < 1X).

Bills post ~24-72 h after the run — see [Estimated vs billed](#estimated-vs-billed-cost-explorer).

## Speed — first question of a session

The earliest request of each session: session setup, cold environment/init and the first model turn are all included.

| platform | requests | ok | errors | first byte p50 (s) | first answer char p50 (s) | full answer p50 (s) |
| --- | --- | --- | --- | --- | --- | --- |
| lambdaevent | 20 | 20 | 0 | 1.53 | 3.24 | 3.78 |
| lambdaweb | 20 | 20 | 0 | 1.09 | 2.95 | **3.38** |
| agentcorev1 | 20 | 20 | 0 | 2.18 | 3.97 | 4.24 |
| agentcorev2 | 20 | 20 | 0 | 2.11 | 4.17 | 4.81 |

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
| lambdaevent | **$0.000895** | **$0.00004474** | $0.00004474 | 1.0X |
| lambdaweb | $0.006794 | $0.00033969 | $0.00033969 | 7.6X |
| agentcorev1 | $0.008995 | $0.00044976 | $0.00044976 | 10.1X |
| agentcorev2 | $0.026235 | $0.00131177 | $0.00131177 | 29.3X |

### Detail lines (from analyze.ts)

- **lambdaevent**
  - 20 invocations; billed 66.80 GB-s; requests $0.000004 + compute $0.000891
- **lambdaweb**
  - 20 environments; total life 7573 s; requests 20 ($0.000006); cpu 17.1 s ($0.000499); memory 1629.22 GB-s ($0.006289)
  - alive after last response: 350 s — tail cost $0.000300
- **agentcorev1**
  - 20 sessions; vCPU 0.016438 h ($0.001471); memory 0.7962 GB-h ($0.007524); 120 s idle tail per session included
- **agentcorev2**
  - 20 sessions; vCPU 0.036646 h ($0.004676); memory 1.2757 GB-h ($0.021559); 120 s idle tail per session included

## Estimated vs billed (Cost Explorer)

The bill is the ACTUAL tagged spend (Cost Explorer, tag `cost-experiment=<test>-<platform>`, region us-east-1) and posts ~24-72 h after the run — re-run this report once bill.ts shows a non-zero total.

| platform | estimated | billed | diff | diff % | bill window | status |
| --- | --- | --- | --- | --- | --- | --- |
| lambdaevent | $0.000895 | $0.000891 | -$0.000004 | -0.4% | 2026-10-30 | within 5% |
| lambdaweb | $0.006794 | $0.007082 | +$0.000288 | +4.2% | 2026-10-30 | within 5% |
| agentcorev1 | $0.008995 | $0.009011 | +$0.000016 | +0.2% | 2026-10-30 | within 5% |
| agentcorev2 | $0.026235 | $0.026253 | +$0.000018 | +0.1% | 2026-10-30 | within 5% |

### Bill breakdown (usage types)

#### lambdaevent — tag `test1-lambdaevent` (2 CE rows, 2026-10-30)

| usage_type | quantity | unit | cost |
| --- | --- | --- | --- |
| EU-Lambda-GB-Second-ARM | 66.804 | Lambda-GB-Second | $0.000891 |
| EU-Request-ARM | 20 | Requests | $0.000000 |
| **total** | — | — | **$0.000891** |

#### lambdaweb — tag `test1-lambdaweb` (4 CE rows, 2026-10-30)

| usage_type | quantity | unit | cost |
| --- | --- | --- | --- |
| EU-Lambda-Web-Memory-GB-Second-ARM | 1629.6692851463 | GB-Seconds | $0.006291 |
| EU-Lambda-Web-vCPU-Second-ARM | 26.929 | vCPU-Seconds | $0.000785 |
| EU-Lambda-Web-Request-ARM | 20 | Requests | $0.000006 |
| EU-DataTransfer-Out-Bytes | 0.000094926 | GB | $0.000000 |
| **total** | — | — | **$0.007082** |

#### agentcorev1 — tag `test1-agentcorev1` (5 CE rows, 2026-10-30)

| usage_type | quantity | unit | cost |
| --- | --- | --- | --- |
| EU-Runtime:Consumption-based:Memory | 0.7961836453 | GB-Hours | $0.007524 |
| EU-Runtime:Consumption-based:vCPU | 0.0164383084 | vCPU-Hours | $0.001471 |
| EU-DataTransfer-Regional-Bytes | 0.0015823357 | GB | $0.000016 |
| EU-DataTransfer-In-Bytes | 0.000047139 | GB | $0.000000 |
| EU-DataTransfer-Out-Bytes | 0.0001023506 | GB | $0.000000 |
| **total** | — | — | **$0.009011** |

#### agentcorev2 — tag `test1-agentcorev2` (5 CE rows, 2026-10-30)

| usage_type | quantity | unit | cost |
| --- | --- | --- | --- |
| EU-Runtime:Consumption-based:Memory-v2 | 1.2757069139 | GB-Hours | $0.021559 |
| EU-Runtime:Consumption-based:vCPU-v2 | 0.0366455431 | vCPU-Hours | $0.004676 |
| EU-DataTransfer-Regional-Bytes | 0.0017859278 | GB | $0.000018 |
| EU-DataTransfer-In-Bytes | 0.0000471328 | GB | $0.000000 |
| EU-DataTransfer-Out-Bytes | 0.0001025901 | GB | $0.000000 |
| **total** | — | — | **$0.026253** |

## Pricing model (keep in sync with analyze.ts)

- lambdaevent: $0.20/1M requests + $0.0000133334/GB-s (1024 MB memory)
- lambdaweb: $0.30/1M requests + $0.0000291572/vCPU-s + $0.0000038603/GB-s (peak × environment lifetime)
- agentcorev1: $0.0895/vCPU-h + $0.00945/GB-h
- agentcorev2: $0.1276/vCPU-h + $0.0169/GB-h

Excluded as identical on every platform: model tokens, Titan embeddings, auth-token invocations, data transfer.
The bill covers the same tagged resources — residual differences come from rounding, pricing-tier edges or untagged resources.

