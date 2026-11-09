# M5-C perturbation budget (prepared_verify @ 2^10)

Input fixture sha256: `5a77b9a84788c181cbe8c80da7c0c5afcf02ef87353ed2d1a7063b21c0e27e79` (identical for all 15 runs).

| mode | peak WS (MiB) | WS median | WS spread | elapsed median (ms) | elapsed spread | commit median |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| pristine | 613.5 / 554.4 / 555.1 / 556.9 / 613.1 | 556.9 | 59.0 | 1885.35 | 70.7 | 783.1 |
| vendor | 626.4 / 625.1 / 589.4 / 589.3 / 565.7 | 589.4 | 60.8 | 1912.56 | 639.9 | 788.6 |
| trace | 622.6 / 565.2 / 628.3 / 595.4 / 570.5 | 595.4 | 63.1 | 2066.79 | 170.8 | 792.6 |

## How to read this

1. **Peak WS is not a control variable here.** The within-mode spread is the same size as the
   between-mode difference, so it cannot be used to claim that the probe perturbs the workload,
   nor that it does not. Attribution must rest on per-worker `allocs / grow_events / wasm_after`.
2. **Wall time is usable.** Compare medians and require an ordering that holds for every repeat,
   not just for the mean: the JSONL writer has a fixed cost and it must be declared before any
   trace-vs-pristine timing claim.
3. n is small. These are 5 repeats per mode, quoted as min/median/max, never as mean ± sigma.
