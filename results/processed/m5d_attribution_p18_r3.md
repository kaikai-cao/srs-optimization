# M5-D attribution — m5_trace_prepared_verify_p18_r1_b3.jsonl

probe: `efd3ed81d155…` resolved to `D:\Research\srs-optimization\vendor\ffjavascript-0.3.1-m5\build\main.cjs`

| quantity | value | clock |
| --- | ---: | --- |
| tasks | 20145 | probe |
| calls | 445 | probe |
| in-flight peak | **987.4 MiB** | probe (send→done) |
| capacity, final | **1580.5 MiB** (25288 pages over 28 workers) | probe (worker_task) |
| capacity, at in-flight peak | 778.3 MiB | probe |
| WS at in-flight peak | 3336.7–3324.5 MiB | measurer (25 ms) |
| peak WS (whole run) | 3763.4 MiB | measurer |
| peak commit (whole run) | 4498.2 MiB | measurer |

## In-flight peak composition (top sites)

| site | MiB |
| --- | ---: |
| tauG1_19_transformed | 987.4 |

## Same-instant placement

| checkpoint | t (ms) | in-flight | capacity | WS (before→after poll) | residual |
| --- | ---: | ---: | ---: | --- | ---: |
| before first task | 7522 | 0.0 | 43.8 | 443.3→443.3 | 399.5…399.5 |
| in-flight peak | 28461 | 987.4 | 778.3 | 3336.7→3324.5 | 1571.0…1558.8 |
| end of run | 56825 | 0.0 | 1580.5 | 2714.0→2679.4 | 1133.5…1098.9 |

Residual = WS − in-flight − capacity, given as an interval because WS is polled every 25 ms while
the probe events are exact. It is **not** attributed to anything in this file.
