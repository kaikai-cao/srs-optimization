# M4 Repeat Baseline — prepared_verify @ Power 18

- Repeats: 3 (PASS: 3)
- Instrument: m4_instrument.js (FastFile page-pool probe, synchronized snapshots)

## Aggregate statistics (over PASS runs)

| Quantity | n | mean | median | min | max | stdev | CV % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Peak Working Set (MiB) | 3 | 3783.966 | 3737.715 | 3720.598 | 3893.586 | 95.318 | 2.52 |
| Peak Commit Charge — `PeakPagedMemorySize64` (MiB) | 3 | 4497.225 | 4447.672 | 4444.25 | 4599.754 | 88.809 | 1.97 |
| Max sampled current commit — `PagedMemorySize64` (MiB) | 3 | 4446.558 | 4381.367 | 4376.91 | 4581.398 | 116.796 | 2.63 |
| Elapsed (ms) | 3 | 35488.521 | 35582.065 | 30658.575 | 40224.924 | 4783.86 | 13.48 |
| FastFile peak cache capacity (MiB) | 3 | 52.8 | 52.8 | 52.8 | 52.8 | 0 | 0 |
| FastFile peak held buffers (MiB) | 3 | 52.8 | 52.8 | 52.8 | 52.8 | 0 | 0 |

## Per-run detail

| run | label | exit | peak WS (MiB) | peak commit (MiB) | elapsed (ms) | FF cap (MiB) | FF held (MiB) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | m4_1_prepared_verify_p18_r1 | 0 | 3737.715 | 4444.25 | 40224.924 | 52.8 | 52.8 |
| 2 | m4_1_prepared_verify_p18_r2 | 0 | 3893.586 | 4599.754 | 30658.575 | 52.8 | 52.8 |
| 3 | m4_1_prepared_verify_p18_r3 | 0 | 3720.598 | 4447.672 | 35582.065 | 52.8 | 52.8 |

## FastFile per-file page pool (max across PASS runs)

`cap@p` = capacity (pages) and `pages@cap`/`av@cap` = the page and free-buffer counts
read in the SAME sample as that capacity. Independent maxima are listed separately.

| file | pageSize | peakMaxPagesLoaded | capacity (MiB) | peakPages | peakAvBuffs | held (MiB) | cap@p | pages@cap | av@cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pot18_final.ptau | 8192 | 6759 | 52.8 | 6759 | 0 | 52.8 | 6759 | 6759 | 0 |

> `capacityMiB = peakMaxPagesLoaded * pageSize` is the page-buffer cache UPPER BOUND that fastfile
> keeps allocated (never returned to OS) while the file descriptor is open. `heldMiB` is the
> sum of actually-allocated page buffers (`peakPagesCount + peakAvBuffsCount`) * pageSize.
> The three `peak*` columns are INDEPENDENT historical maxima and may come from different
> instants; the `*@cap` columns are one synchronized sample, so only those may be compared.
