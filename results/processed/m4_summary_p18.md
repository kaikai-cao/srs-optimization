# M4 Repeat Baseline — prepared_verify @ Power 18

- Repeats: 3 (PASS: 3)
- Instrument: m4_instrument.js (FastFile page-pool probe)

## Aggregate statistics (over PASS runs)

| Quantity | n | mean | median | min | max | stdev | CV % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Peak Working Set (MiB) | 3 | 3641.994 | 3634.145 | 3617.25 | 3674.586 | 29.463 | 0.81 |
| Peak Pagefile Usage (MiB) | 3 | 4380.047 | 4392.328 | 4353.637 | 4394.176 | 22.89 | 0.52 |
| Elapsed (ms) | 3 | 39750.516 | 39768.846 | 39206.373 | 40276.33 | 535.214 | 1.35 |
| FastFile peak cache capacity (MiB) | 3 | 52.8 | 52.8 | 52.8 | 52.8 | 0 | 0 |
| FastFile peak held buffers (MiB) | 3 | 52.8 | 52.8 | 52.8 | 52.8 | 0 | 0 |

## Per-run detail

| run | label | exit | peak WS (MiB) | peak Pagefile (MiB) | elapsed (ms) | FF cap (MiB) | FF held (MiB) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | m4_prepared_verify_p18_r1 | 0 | 3674.586 | 4394.176 | 39206.373 | 52.8 | 52.8 |
| 2 | m4_prepared_verify_p18_r2 | 0 | 3634.145 | 4392.328 | 40276.33 | 52.8 | 52.8 |
| 3 | m4_prepared_verify_p18_r3 | 0 | 3617.25 | 4353.637 | 39768.846 | 52.8 | 52.8 |

## FastFile per-file page pool (max across PASS runs)

| file | pageSize | peakMaxPagesLoaded | capacity (MiB) | peakPages | peakAvBuffs | held (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| pot18_final.ptau | 8192 | 6759 | 52.8 | 6759 | 0 | 52.8 |

> `capacityMiB = peakMaxPagesLoaded * pageSize` is the page-buffer cache UPPER BOUND that fastfile
> keeps allocated (never returned to OS) while the file descriptor is open. `heldMiB` is the
> sum of actually-allocated page buffers (`peakPagesCount + peakAvBuffsCount`) * pageSize.
