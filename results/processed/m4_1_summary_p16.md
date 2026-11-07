# M4 Repeat Baseline — prepared_verify @ Power 16

- Repeats: 3 (PASS: 3)
- Instrument: m4_instrument.js (FastFile page-pool probe, synchronized snapshots)

## Aggregate statistics (over PASS runs)

| Quantity | n | mean | median | min | max | stdev | CV % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Peak Working Set (MiB) | 3 | 1656.648 | 1631.168 | 1608.535 | 1730.242 | 64.731 | 3.91 |
| Peak Commit Charge — `PeakPagedMemorySize64` (MiB) | 3 | 1956.97 | 1935.398 | 1903.961 | 2031.551 | 66.474 | 3.4 |
| Max sampled current commit — `PagedMemorySize64` (MiB) | 3 | 1948.875 | 1931.957 | 1891.73 | 2022.938 | 67.22 | 3.45 |
| Elapsed (ms) | 3 | 10759.163 | 10279.909 | 10235.341 | 11762.24 | 868.976 | 8.08 |
| FastFile peak cache capacity (MiB) | 3 | 13.2 | 13.2 | 13.2 | 13.2 | 0 | 0 |
| FastFile peak held buffers (MiB) | 3 | 13.2 | 13.2 | 13.2 | 13.2 | 0 | 0 |

## Per-run detail

| run | label | exit | peak WS (MiB) | peak commit (MiB) | elapsed (ms) | FF cap (MiB) | FF held (MiB) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | m4_1_prepared_verify_p16_r1 | 0 | 1631.168 | 1935.398 | 10235.341 | 13.2 | 13.2 |
| 2 | m4_1_prepared_verify_p16_r2 | 0 | 1730.242 | 2031.551 | 10279.909 | 13.2 | 13.2 |
| 3 | m4_1_prepared_verify_p16_r3 | 0 | 1608.535 | 1903.961 | 11762.24 | 13.2 | 13.2 |

## FastFile per-file page pool (max across PASS runs)

`cap@p` = capacity (pages) and `pages@cap`/`av@cap` = the page and free-buffer counts
read in the SAME sample as that capacity. Independent maxima are listed separately.

| file | pageSize | peakMaxPagesLoaded | capacity (MiB) | peakPages | peakAvBuffs | held (MiB) | cap@p | pages@cap | av@cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pot16_final.ptau | 8192 | 1690 | 13.2 | 1690 | 0 | 13.2 | 1690 | 1690 | 0 |

> `capacityMiB = peakMaxPagesLoaded * pageSize` is the page-buffer cache UPPER BOUND that fastfile
> keeps allocated (never returned to OS) while the file descriptor is open. `heldMiB` is the
> sum of actually-allocated page buffers (`peakPagesCount + peakAvBuffsCount`) * pageSize.
> The three `peak*` columns are INDEPENDENT historical maxima and may come from different
> instants; the `*@cap` columns are one synchronized sample, so only those may be compared.
