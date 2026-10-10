# Resolver eval: synthetic (mocked backends)

Cases: 210. Backends: kev, llm. Label: synthetic truth.

- Backends are MOCKED (synthetic noise over the label). Numbers show the harness works, not how Kev or the LLM perform.

## Overall

| Backend | Answered | Acc vs label | Within 1 (score) | MAE (score) | Mean p | Brier | ECE | Auto rate | Auto acc | Call p50 | Call p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| kev | 210/210 | 78.6% | 100.0% | 0.23 | 0.76 | 0.107 | 0.222 | 98.1% | 79.6% | 700 ms | 700 ms |
| llm | 210/210 | 82.4% | 100.0% | 0.17 | 0.72 | 0.140 | 0.145 | 91.4% | 83.9% | 2500 ms | 2500 ms |

## roles.criterion

| Backend | Answered | Acc vs label | Within 1 (score) | MAE (score) | Mean p | Brier | ECE | Auto rate | Auto acc | Call p50 | Call p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| kev | 180/180 | 77.2% | 100.0% | 0.23 | 0.75 | 0.112 | 0.232 | 100.0% | 77.2% | 700 ms | 700 ms |
| llm | 180/180 | 83.3% | 100.0% | 0.17 | 0.72 | 0.135 | 0.160 | 100.0% | 83.3% | 2500 ms | 2500 ms |

## inbox.classify

| Backend | Answered | Acc vs label | Within 1 (score) | MAE (score) | Mean p | Brier | ECE | Auto rate | Auto acc | Call p50 | Call p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| kev | 30/30 | 86.7% | n/a | n/a | 0.79 | 0.079 | 0.185 | 86.7% | 96.2% | 700 ms | 700 ms |
| llm | 30/30 | 76.7% | n/a | n/a | 0.71 | 0.172 | 0.064 | 40.0% | 91.7% | 2500 ms | 2500 ms |

## Agreement between backends

| | kev | llm |
| --- | --- | --- |
| kev | 100.0% | 68.1% |
| llm | 68.1% | 100.0% |

## Calibration (p bin -> observed accuracy)

**kev**

| p bin | n | mean p | accuracy |
| --- | --- | --- | --- |
| 0.4 to 0.5 | 10 | 0.47 | 0.0% |
| 0.5 to 0.6 | 19 | 0.56 | 0.0% |
| 0.6 to 0.7 | 18 | 0.66 | 38.9% |
| 0.7 to 0.8 | 78 | 0.75 | 93.6% |
| 0.8 to 0.9 | 73 | 0.84 | 100.0% |
| 0.9 to 1.0 | 12 | 0.92 | 100.0% |

**llm**

| p bin | n | mean p | accuracy |
| --- | --- | --- | --- |
| 0.3 to 0.4 | 1 | 0.39 | 0.0% |
| 0.4 to 0.5 | 8 | 0.47 | 0.0% |
| 0.5 to 0.6 | 30 | 0.56 | 73.3% |
| 0.6 to 0.7 | 57 | 0.65 | 89.5% |
| 0.7 to 0.8 | 53 | 0.75 | 79.2% |
| 0.8 to 0.9 | 48 | 0.86 | 93.8% |
| 0.9 to 1.0 | 13 | 0.93 | 100.0% |

## How to read this

- Acc vs label: share of answers equal to the label (true score or class). Within 1 / MAE apply to 1..5 criterion scores.
- Call p50 / p95: latency of the backend call that carried the question (one call holds every question for a state).
- Brier and ECE measure calibration: lower is better. A calibrated backend at p = 0.9 is right about 90% of the time.
- Auto rate / Auto acc: what the policy would auto-apply at default thresholds for each case impact, and how often those picks were right. High impact cases are never auto.
