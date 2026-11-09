# M5-D attribution — m5_trace_prepared_verify_p16_r1_b1.jsonl

probe: `efd3ed81d155…` resolved to `D:\Research\srs-optimization\vendor\ffjavascript-0.3.1-m5\build\main.cjs`

| quantity | value | clock |
| --- | ---: | --- |
| tasks | 16582 | probe |
| calls | 360 | probe |
| in-flight peak | **265.1 MiB** | probe (send→done) |
| capacity, final | **426.6 MiB** (6826 pages over 28 workers) | probe (worker_task) |
| capacity, at in-flight peak | 215.0 MiB | probe |
| WS at in-flight peak | 1317.0–1313.2 MiB | measurer (25 ms) |
| peak WS (whole run) | 1491.6 MiB | measurer |
| peak commit (whole run) | 1777.1 MiB | measurer |

## In-flight peak composition (top sites)

| site | MiB |
| --- | ---: |
| tauG1_17_transformed | 265.1 |

## Same-instant placement

| checkpoint | t (ms) | in-flight | capacity | WS (before→after poll) | residual |
| --- | ---: | ---: | ---: | --- | ---: |
| before first task | 2901 | 0.0 | 43.8 | 443.9→443.9 | 400.2…400.2 |
| in-flight peak | 9007 | 265.1 | 215.0 | 1317.0→1313.2 | 836.9…833.1 |
| end of run | 18700 | 0.0 | 426.6 | 1216.8→1216.8 | 790.2…790.2 |

Residual = WS − in-flight − capacity, given as an interval because WS is polled every 25 ms while
the probe events are exact. It is **not** attributed to anything in this file.
