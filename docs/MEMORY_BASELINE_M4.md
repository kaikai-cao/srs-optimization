# M4 — Prepared Verify: Repeat Baseline, FastFile Page-Pool Measurement, Stage Decomposition

> **Scope.** M4 is a *runtime memory* study of the snarkjs 0.7.6 `powersoftau verify`
> path ("Prepared Verify") at Power 16 and Power 18. It does **not** address
> persistence compression of the `.ptau` file itself, and it does **not** claim any
> optimization has been achieved. Its purpose is to (a) quantify run-to-run variance
> of the M3 baseline, (b) empirically settle how much memory the FastFile page cache
> really holds, and (c) decompose the ~3.6 GiB peak into stages.

Inputs (SHA-256 recorded in each run JSON):

| Power | fixture | file size |
| ---: | --- | ---: |
| 16 | `data/fixtures/pot16_final.ptau` | 113,248,161 B |
| 18 | `data/fixtures/pot18_final.ptau` | 452,986,785 B |

---

## 1. Method

| Component | What it does |
| --- | --- |
| `scripts/m4_instrument.js` | Non-invasive FastFile probe. `require('fastfile')` returns the same cached CJS build binfileutils uses; we wrap its exported factories (`readExisting`, `readWriteExisting`, …) and patch the returned `FastFile` prototype. Per-read hooks only read `maxPagesLoaded` (O(1)); a 50 ms sampler does the O(pages) `Object.keys(pages)` scan. No dependency source is modified. |
| `scripts/measure_snarkjs.ps1` | Launches `node --require` ×2 (timestamp hook + FastFile probe) directly, polls `Process.PeakWorkingSet64` and `Process.PeakPagedMemorySize64` at 50 ms, and records a per-poll timeline. |
| `scripts/measure_m4.ps1` | Repeats the operation N times, sets a per-run `M4_FASTFILE_OUT`, aggregates. |
| `scripts/build_m4_summary.cjs` | Mean/median/min/max/stdev/CV over PASS runs + FastFile pool merge. |
| `scripts/m4_stage_analysis.cjs` | Deciles, largest working-set jumps, and snarkjs phase markers (ANSI-stripped). |

**Two metric corrections relative to M3:**

1. **`Process.PeakPagefileUsage` does not exist in .NET Framework 4.x.** The M3-era
   reads silently returned `$null` (PowerShell is lenient on missing properties), so
   every `peak_pagefile_usage_mib` was `0`. The correct property for peak commit
   charge is **`Process.PeakPagedMemorySize64`**. M4 now records that value.
2. **Peak Working Set and Peak Commit are kernel monotonic counters**, so the peak is
   authoritative *regardless of poll rate*; the 50 ms timeline is used only for the
   *shape* of memory over time, not to determine the peak.

Each power was run **3 times** on the same machine. All 6 runs exited 0.

---

## 2. Repeat baseline

### Power 16 (n = 3)

| Quantity | mean | median | min | max | stdev | CV % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Peak Working Set (MiB) | 1662.24 | 1662.68 | 1633.10 | 1690.94 | 28.92 | **1.74** |
| Peak Commit — `PeakPagedMemorySize64` (MiB) | 1969.26 | 1968.12 | 1940.30 | 1999.35 | 29.54 | **1.50** |
| Elapsed (ms) | 10022 | 9866 | 9845 | 10355 | 288 | 2.88 |
| FastFile page-pool (MiB) | 13.2 | 13.2 | 13.2 | 13.2 | 0 | 0 |

### Power 18 (n = 3)

| Quantity | mean | median | min | max | stdev | CV % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Peak Working Set (MiB) | 3641.99 | 3634.15 | 3617.25 | 3674.59 | 29.46 | **0.81** |
| Peak Commit — `PeakPagedMemorySize64` (MiB) | 4380.05 | 4392.33 | 4353.64 | 4394.18 | 22.89 | **0.52** |
| Elapsed (ms) | 39751 | 39769 | 39206 | 40276 | 535 | 1.35 |
| FastFile page-pool (MiB) | 52.8 | 52.8 | 52.8 | 52.8 | 0 | 0 |

**Reproducibility.** Peak Working Set CV ≤ 1.74 %, peak commit CV ≤ 1.50 %. The p18
mean (3642 MiB) agrees with the M3 single run (3660 MiB) to within **−0.5 %**, and
p16 (1662 MiB) with M3 (1695 MiB) to within **−1.9 %**. The M3 baseline is therefore
confirmed by an independent, repeated measurement.

**Commit vs resident.** Peak commit exceeds peak resident by **+307 MiB (18 %)** at p16
and **+738 MiB (20 %)** at p18. Roughly one fifth of what the process commits is not
resident at the peak. Peak Working Set remains the right metric for *physical* pressure;
peak commit is the right metric for pagefile/overcommit limits. Both are now reported.

**Scaling p16 → p18 (4× input).** Working Set ×2.19, commit ×2.22, elapsed ×3.97,
FastFile pool ×4.00. With only two powers and a large fixed Node+WASM baseline, this
**does not** establish an asymptotic growth order; it only says the data-dependent
portion grows sub-linearly relative to the 4× input while the FastFile pool grows
linearly.

---

## 3. FastFile page pool — the empirical answer to the 422 MiB question

| Power | pageSize | peakPagesLoaded | peakPages | peakAvBuffs | capacity = held |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 16 | 8192 B | 1690 | 1690 | 0 | **13.2 MiB** |
| 18 | 8192 B | 6759 | 6759 | 0 | **52.8 MiB** |

Three facts, measured rather than estimated:

1. **The pool is tiny relative to the peak.** 13.2 MiB = 0.79 % of the p16 working
   set; 52.8 MiB = 1.45 % of the p18 working set.
2. **`capacity == held` in every run, and `avBuffs == 0` at peak.** At the moment of
   peak, every page buffer fastfile has allocated is a live mapped page — there is no
   additional "capacity-only" footprint beyond the mapped pages. This is the empirical
   form of the earlier correction: the amplification constant
   (`maxPagesLoaded = floor(len·1.1/pageSize)+1`) is an *upper bound on how many buffers
   may be retained*, and here the retained set equals the mapped set.
3. **It scales O(N) with the input** (13.2 → 52.8 MiB for 4× data), exactly as a page
   cache should — and stays negligible.

**Why the M3 "422 MiB" figure does not apply here.** That figure was computed for the
`prepare_phase2` path, whose single `readToBuffer` is the full ~384 MiB point buffer,
giving `floor(384 MiB·1.1/8192)+1 ≈ 54,068` pages ≈ 422 MiB. `powersoftau verify` never
performs such a read: its largest reads are individual Lagrange sections (~2^p·96 B;
≈ 25 MiB each at p18), which is why the measured pool is ~53 MiB, not ~422 MiB.

**Conclusion.** For Prepared Verify, the FastFile page cache is **not** a meaningful
contributor to the 3.6 GiB peak (≤ 1.5 %). Optimizing it would recover at most tens of
MiB and should be deprioritized for this operation.

---

## 4. Stage decomposition

Memory shape from the 50 ms timeline; stage boundaries from the timestamped snarkjs log
(ANSI-stripped). Working Set and commit in MiB.

### Power 16 (peak 1691 / commit 1999)

| t (ms) | stage | current WS | peak WS | commit |
| ---: | --- | ---: | ---: | ---: |
| 602 | `power: 2**16` | — | — | — |
| 880 | startup | 440 | 471 | 690 |
| 1372 | verify tau·G1 | — | — | — |
| 1792 | verify tau·G2 | 742 | 744 | 948 |
| 2283 | verify α·τ·G1 | — | — | — |
| 2491 | verify β·τ·G1 | 850 | 1118 | 1343 |
| 2696 | **phase2 verify tauG1** (Lagrange read + MSM) | — | — | — |
| 4672 | phase2 verify tauG2 | 1169 | 1311 | 1602 |
| 7156 | phase2 verify ατG1 | 1505 | 1523 | 1837 |
| 8922 | phase2 verify βτG1 | 1210 | 1691 | 1999 |
| 10355 | exit | 257 | 1691 | 1999 |

Largest single-step jumps: **+218 MiB** at 573 ms (WASM/heap startup), **+203 MiB** at
3255 ms (Lagrange section read), +179 MiB at 6833 ms, +173 MiB near 10 s.

### Power 18 (peak 3675 / commit 4394)

| t (ms) | stage | current WS | peak WS | commit |
| ---: | --- | ---: | ---: | ---: |
| 605 | `power: 2**18` | — | — | — |
| 3463 | startup | 440 | 534 | 752 |
| 3709 | verify tau·G1 | — | — | — |
| 6468 | verify tau·G2 | 820 | 1166 | 1367 |
| 9888 | verify α·τ·G1 | 1102 | 1166 | 1367 |
| 11263 | verify β·τ·G1 | 1287 | 1287 | 1574 |
| 12635 | **phase2 verify tauG1** (Lagrange read + MSM) | — | — | — |
| 18833 | phase2 tauG1 MSM in progress | **3478** | 3491 | 4153 |
| 19682 | phase2 verify tauG2 | 3249 | 3619 | 4274 |
| 30948 | phase2 verify ατG1 | 3423 | 3619 | 4274 |
| 34959 | phase2 verify βτG1 | 3025 | 3675 | 4394 |
| 39751 | exit | 275 | 3675 | 4394 |

Largest single-step jumps: **+277 MiB** at 588 ms (startup), **+240 MiB** at 16664 ms
(inside the Phase-2 tauG1 full-domain MSM), +185 MiB at 33881 ms, +202/+191 MiB near
35.9–36.6 s (later Phase-2 sections).

**Interpretation (bounded to what is measured).**
- Phase 1 (contribution verification) is **chunked and cheap in memory**: at p18 it
  holds ~0.8–1.3 GiB across 3.7–11.3 s while reading sections in `1<<16`-point chunks.
- The dominant jump is the **Phase-2 full-domain MSM on tauG1**: at p18 the working set
  rises from 1.29 GiB to 3.48 GiB (+2.2 GiB) between ~11.3 s and ~18.8 s, i.e. while the
  first Phase-2 section is being verified. Subsequent Phase-2 sections add smaller
  increments to the peak.
- The FastFile pool is a constant 52.8 MiB throughout, so **it cannot explain the jump**.

What M4 does **not** claim: the exact split of that +2.2 GiB among FFT input copy
(`buff.slice`), MSM shard/accumulator buffers, and WASM linear-memory growth. That
requires instrumenting `engine_multiexp.js` / `engine_fft.js` allocation sites, which is
M5 work, not M4.

---

## 5. What this means for the next step

1. **Do not target the FastFile cache** for Prepared Verify — it is ≤ 1.5 % of the peak
   and O(N) with the input.
2. **Target the Phase-2 full-domain MSM path** — the tauG1 MSM is where the working set
   jumps by ~2.2 GiB at p18. Candidate levers: the FFT input copy (H1), MSM shard
   concurrency, and Phase-2 output-buffer lifetimes.
3. **Before patching, attribute.** The right next experiment is to instrument
   `engine_multiexp.js` / `engine_fft.js` to record allocation size and lifetime per
   call, so that any peak reduction can be attributed to a specific change rather than
   to the bundle.

---

## 6. Caveats

- **Single machine** (32 GiB), **3 repeats** per power. No Power 20/21 (not run; the
  p18 commit of 4.38 GiB already indicates substantial pressure at higher powers).
- **Peak Working Set ≠ Linux RSS ≠ private bytes.** Peak commit is reported separately
  as `PeakPagedMemorySize64`.
- **The timeline is 50 ms resolution** and reflects the shape only; the peak itself is a
  kernel counter and is not sensitive to poll rate.
- **Instrumentation perturbs elapsed time**, not memory. A first version scanned
  `Object.keys(pages)` on every read and inflated p16 elapsed from ~10 s to ~18 s; the
  shipped version does an O(1) read per call and restores elapsed to ~10 s. Elapsed
  across instrumented runs should be treated as within ~±10 % of an uninstrumented run,
  not as a precise timing baseline.
- **Only two powers** are used; the ×2.19 / ×2.22 scaling figures are descriptive, not
  an asymptotic claim.
