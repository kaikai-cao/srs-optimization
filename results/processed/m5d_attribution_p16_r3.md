# M5-D attribution — m5_trace_prepared_verify_p16_r1_b3.jsonl

probe: `efd3ed81d155…` resolved to `D:\Research\srs-optimization\vendor\ffjavascript-0.3.1-m5\build\main.cjs`

| quantity | value | clock |
| --- | ---: | --- |
| tasks | 16582 | probe |
| calls | 360 | probe |
| in-flight peak | **265.1 MiB** | probe (send→done) |
| capacity, final | **426.6 MiB** (6826 pages over 28 workers) | probe (worker_task) |
| capacity, at in-flight peak | 215.0 MiB | probe |
| WS at in-flight peak | 1318.1–1335.7 MiB | measurer (25 ms) |
| peak WS (whole run) | 1473.9 MiB | measurer |
| peak commit (whole run) | 1768.7 MiB | measurer |

## In-flight peak composition (top sites)

| site | MiB |
| --- | ---: |
| tauG1_17_transformed | 265.1 |

## Same-instant placement

| checkpoint | t (ms) | in-flight | capacity | WS (before→after poll) | residual |
| --- | ---: | ---: | ---: | --- | ---: |
| before first task | 2895 | 0.0 | 43.8 | 444.6→444.6 | 400.8…400.8 |
| in-flight peak | 8834 | 265.1 | 215.0 | 1318.1→1335.7 | 837.9…855.5 |
| end of run | 18417 | 0.0 | 426.6 | 1252.8→1253.4 | 826.2…826.7 |

Residual = WS − in-flight − capacity, given as an interval because WS is polled every 25 ms while
the probe events are exact. It is **not** attributed to anything in this file.
