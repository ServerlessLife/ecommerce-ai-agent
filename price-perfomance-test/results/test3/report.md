# Price-performance report — test3

_Generated 2026-11-01T15:31:23.091Z — cost: comparison.csv (analyze.ts), speed: speed.csv (analyze.ts), bills: bill/bill.csv (bill.ts, Cost Explorer)._

## Summary

| platform | requests | ok | errors | sessions | instances | calculated cost | cost vs lambdaevent | billed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lambdaevent | 200 | 199 | 1 | 20 | — | $0.005900 | 1.0X | $0.005860 |
| lambdaweb | 200 | 199 | 1 | 20 | 2 | **$0.002655** | 0.4X | $0.002497 |
| agentcorev1 | 200 | 200 | 0 | 20 | — | $0.040089 | 6.8X | $0.040268 |
| agentcorev2 | 200 | 200 | 0 | 20 | — | $0.119019 | 20.2X | $0.119222 |

Cheapest (calculated): **lambdaweb**.

`cost vs lambdaevent` — calculated cost as a multiple of lambdaevent's (the fixed reference); **1X = lambdaevent**, even when another platform is cheaper (it then shows < 1X).

Bills post ~24-72 h after the run — see [Estimated vs billed](#estimated-vs-billed-cost-explorer).

## Speed — first question of a session

The earliest request of each session: session setup, cold environment/init and the first model turn are all included.

| platform | requests | ok | errors | first byte p50 (s) | first answer char p50 (s) | full answer p50 (s) |
| --- | --- | --- | --- | --- | --- | --- |
| lambdaevent | 20 | 20 | 0 | 1.30 | 3.27 | 3.33 |
| lambdaweb | 20 | 20 | 0 | 0.42 | 2.08 | **2.23** |
| agentcorev1 | 20 | 20 | 0 | 2.08 | 3.51 | 4.09 |
| agentcorev2 | 20 | 20 | 0 | 2.92 | 4.53 | 4.86 |

Fastest first question of a session (full answer p50): **lambdaweb**

## Speed — follow-up questions (same session)

Later requests reusing a session: history is already server-side and the setup is already paid.

| platform | requests | ok | errors | first byte p50 (s) | first answer char p50 (s) | full answer p50 (s) |
| --- | --- | --- | --- | --- | --- | --- |
| lambdaevent | 180 | 179 | 1 | 0.24 | 1.14 | 1.84 |
| lambdaweb | 180 | 179 | 1 | 0.19 | 1.12 | **1.81** |
| agentcorev1 | 180 | 180 | 0 | 0.23 | 1.07 | 1.86 |
| agentcorev2 | 180 | 180 | 0 | 0.26 | 1.17 | 1.89 |

Fastest follow-up questions (same session) (full answer p50): **lambdaweb**

How to read the speed tables:

- **first byte** (`ttfb_p50_ms`) — POST sent → first response byte (the server accepted the request and started replying).
- **first answer char** (`first_char_p50_ms`) — POST sent → first visible answer character (the model started producing the answer).
- **full answer** (`total_p50_ms`) — POST sent → response complete.
- **p50 (median)** — half of the requests were faster than this; the report compares platforms on p50. (p95 values remain available in `speed.csv` / `analysis.csv`.)
- **first question of a session** — decided per `session_id`, not per wave: a shape reusing sessions across waves (e.g. the test3 shape) shows its follow-ups here, a `--new-session-each-request` shape shows none.

## Speed — sequential questions of a session

Median full answer by question number WITHIN a session (1st = first question, 2nd = first follow-up, …): how latency evolves as the conversation grows and the server-side history gets longer.

| platform | question 1 (s) | question 2 (s) | question 3 (s) | question 4 (s) | question 5 (s) | question 6 (s) | question 7 (s) | question 8 (s) | question 9 (s) | question 10 (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lambdaevent | 3.33 (20) | 1.68 (20) | 1.54 (20) | 1.66 (20) | 2.01 (20) | 2.99 (20) | 1.92 (20) | 1.82 (20) | 1.88 (20) | 1.49 (20) |
| lambdaweb | 2.23 (20) | 1.44 (20) | 1.68 (20) | 1.60 (20) | 2.28 (20) | 2.27 (20) | 1.85 (20) | 2.07 (20) | 1.68 (20) | 1.74 (20) |
| agentcorev1 | 4.09 (20) | 1.54 (20) | 1.37 (20) | 1.92 (20) | 1.97 (20) | 2.45 (20) | 1.92 (20) | 1.47 (20) | 1.80 (20) | 2.20 (20) |
| agentcorev2 | 4.86 (20) | 1.47 (20) | 1.53 (20) | 1.51 (20) | 2.11 (20) | 2.47 (20) | 2.68 (20) | 1.72 (20) | 1.79 (20) | 2.07 (20) |

Each cell: median (sessions observed). A cell is only filled when at least one session had that question number — later numbers fill in only for shapes that reuse sessions.

## Calculated cost (published card rates)

| platform | cost | per request | per session | cost vs lambdaevent |
| --- | --- | --- | --- | --- |
| lambdaevent | $0.005900 | $0.00002950 | $0.00029499 | 1.0X |
| lambdaweb | **$0.002655** | **$0.00001327** | $0.00013275 | 0.4X |
| agentcorev1 | $0.040089 | $0.00020045 | $0.00200446 | 6.8X |
| agentcorev2 | $0.119019 | $0.00059510 | $0.00595096 | 20.2X |

### Detail lines (from analyze.ts)

- **lambdaevent**
  - 200 invocations; billed 439.49 GB-s; requests $0.000040 + compute $0.005860
- **lambdaweb**
  - 2 environments; total life 1896 s; requests 200 ($0.000060); cpu 13.5 s ($0.000393); memory 570.31 GB-s ($0.002202)
  - alive after last response: 328 s — tail cost $0.000393
- **agentcorev1**
  - 20 sessions; vCPU 0.044669 h ($0.003998); memory 3.8192 GB-h ($0.036091); 120 s idle tail per session included
- **agentcorev2**
  - 20 sessions; vCPU 0.116726 h ($0.014894); memory 6.1612 GB-h ($0.104125); 120 s idle tail per session included

## Estimated vs billed (Cost Explorer)

The bill is the ACTUAL tagged spend (Cost Explorer, tag `cost-experiment=<test>-<platform>`, region us-east-1) and posts ~24-72 h after the run — re-run this report once bill.ts shows a non-zero total.

| platform | estimated | billed | diff | diff % | bill window | status |
| --- | --- | --- | --- | --- | --- | --- |
| lambdaevent | $0.005900 | $0.005860 | -$0.000040 | -0.7% | 2026-10-30 | within 5% |
| lambdaweb | $0.002655 | $0.002497 | -$0.000158 | -6.0% | 2026-10-30 | off — check the breakdown below |
| agentcorev1 | $0.040089 | $0.040268 | +$0.000179 | +0.4% | 2026-10-30 | within 5% |
| agentcorev2 | $0.119019 | $0.119222 | +$0.000203 | +0.2% | 2026-10-30 | within 5% |

### Bill breakdown (usage types)

#### lambdaevent — tag `test3-lambdaevent` (2 CE rows, 2026-10-30)

| usage_type | quantity | unit | cost |
| --- | --- | --- | --- |
| EU-Lambda-GB-Second-ARM | 439.481 | Lambda-GB-Second | $0.005860 |
| EU-Request-ARM | 200 | Requests | $0.000000 |
| **total** | — | — | **$0.005860** |

#### lambdaweb — tag `test3-lambdaweb` (4 CE rows, 2026-10-30)

| usage_type | quantity | unit | cost |
| --- | --- | --- | --- |
| EU-Lambda-Web-Memory-GB-Second-ARM | 522.1097177734 | GB-Seconds | $0.002016 |
| EU-Lambda-Web-vCPU-Second-ARM | 14.447 | vCPU-Seconds | $0.000421 |
| EU-Lambda-Web-Request-ARM | 200 | Requests | $0.000060 |
| EU-DataTransfer-Out-Bytes | 0.0008273842 | GB | $0.000000 |
| **total** | — | — | **$0.002497** |

#### agentcorev1 — tag `test3-agentcorev1` (5 CE rows, 2026-10-30)

| usage_type | quantity | unit | cost |
| --- | --- | --- | --- |
| EU-Runtime:Consumption-based:Memory | 3.819187391 | GB-Hours | $0.036091 |
| EU-Runtime:Consumption-based:vCPU | 0.0446688975 | vCPU-Hours | $0.003998 |
| EU-DataTransfer-Regional-Bytes | 0.0178697631 | GB | $0.000179 |
| EU-DataTransfer-In-Bytes | 0.0004695887 | GB | $0.000000 |
| EU-DataTransfer-Out-Bytes | 0.0008059265 | GB | $0.000000 |
| **total** | — | — | **$0.040268** |

#### agentcorev2 — tag `test3-agentcorev2` (5 CE rows, 2026-10-30)

| usage_type | quantity | unit | cost |
| --- | --- | --- | --- |
| EU-Runtime:Consumption-based:Memory-v2 | 6.1612399283 | GB-Hours | $0.104125 |
| EU-Runtime:Consumption-based:vCPU-v2 | 0.1167258744 | vCPU-Hours | $0.014894 |
| EU-DataTransfer-Regional-Bytes | 0.0203290237 | GB | $0.000203 |
| EU-DataTransfer-In-Bytes | 0.0004695887 | GB | $0.000000 |
| EU-DataTransfer-Out-Bytes | 0.00084389 | GB | $0.000000 |
| **total** | — | — | **$0.119222** |

## Pricing model (keep in sync with analyze.ts)

- lambdaevent: $0.20/1M requests + $0.0000133334/GB-s (1024 MB memory)
- lambdaweb: $0.30/1M requests + $0.0000291572/vCPU-s + $0.0000038603/GB-s (peak × environment lifetime)
- agentcorev1: $0.0895/vCPU-h + $0.00945/GB-h
- agentcorev2: $0.1276/vCPU-h + $0.0169/GB-h

Excluded as identical on every platform: model tokens, Titan embeddings, auth-token invocations, data transfer.
The bill covers the same tagged resources — residual differences come from rounding, pricing-tier edges or untagged resources.

