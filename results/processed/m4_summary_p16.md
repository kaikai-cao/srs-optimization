# M4 Repeat Baseline — prepared_verify @ Power 16

- Repeats: 3 (PASS: 3)
- Instrument: m4_instrument.js (FastFile page-pool probe)

## Aggregate statistics (over PASS runs)

| Quantity | n | mean | median | min | max | stdev | CV % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Peak Working Set (MiB) | 3 | 1662.241 | 1662.684 | 1633.102 | 1690.938 | 28.921 | 1.74 |
| Peak Pagefile Usage (MiB) | 3 | 1969.255 | 1968.121 | 1940.297 | 1999.348 | 29.542 | 1.5 |
| Elapsed (ms) | 3 | 10022.058 | 9866.417 | 9844.903 | 10354.855 | 288.411 | 2.88 |
| FastFile peak cache capacity (MiB) | 3 | 13.2 | 13.2 | 13.2 | 13.2 | 0 | 0 |
| FastFile peak held buffers (MiB) | 3 | 13.2 | 13.2 | 13.2 | 13.2 | 0 | 0 |

## Per-run detail

| run | label | exit | peak WS (MiB) | peak Pagefile (MiB) | elapsed (ms) | FF cap (MiB) | FF held (MiB) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | m4_prepared_verify_p16_r1 | 0 | 1633.102 | 1940.297 | 9844.903 | 13.2 | 13.2 |
| 2 | m4_prepared_verify_p16_r2 | 0 | 1662.684 | 1968.121 | 9866.417 | 13.2 | 13.2 |
| 3 | m4_prepared_verify_p16_r3 | 0 | 1690.938 | 1999.348 | 10354.855 | 13.2 | 13.2 |

## FastFile per-file page pool (max across PASS runs)

| file | pageSize | peakMaxPagesLoaded | capacity (MiB) | peakPages | peakAvBuffs | held (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| pot16_final.ptau | 8192 | 1690 | 13.2 | 1690 | 0 | 13.2 |

> `capacityMiB = peakMaxPagesLoaded * pageSize` is the page-buffer cache UPPER BOUND that fastfile
> keeps allocated (never returned to OS) while the file descriptor is open. `heldMiB` is the
> sum of actually-allocated page buffers (`peakPagesCount + peakAvBuffsCount`) * pageSize.
