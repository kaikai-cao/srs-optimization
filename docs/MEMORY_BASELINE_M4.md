# M4 / M4.1 — Prepared Verify: Repeat Baseline, FastFile Page-Pool Measurement, Stage Decomposition

> **Scope.** M4 is a *runtime memory* study of the snarkjs 0.7.6 `powersoftau verify`
> path ("Prepared Verify") at Power 16 and Power 18. It does **not** address
> persistence compression of the `.ptau` file itself, and it does **not** claim any
> optimization has been achieved. Its purpose is to (a) quantify run-to-run variance
> of the M3 baseline, (b) empirically settle how much memory the FastFile page cache
> really holds, and (c) decompose the ~3.6 GiB peak into stages.
>
> **M4.1** is a measurement-only revision (no new optimization, no new power): it fixes
> what the commit-charge timeline actually records, tightens the FastFile page-pool
> claim to a same-instant observation, and corrects the G2 read size behind the page
> count. Section 0 lists the changes.

Inputs (SHA-256 recorded in each run JSON):

| Power | fixture | file size |
| ---: | --- | ---: |
| 16 | `data/fixtures/pot16_final.ptau` | 113,248,161 B |
| 18 | `data/fixtures/pot18_final.ptau` | 452,986,785 B |

---

## 0. What M4.1 changed

| # | M4 statement | M4.1 correction | Where |
| ---: | --- | --- | --- |
| 1 | Timeline field `pagefile_mib` — described as the commit charge | It was `PeakPagedMemorySize64`, i.e. a **historical high-water mark that never decreases**. Renamed to `peak_commit_so_far_mib`, and a genuine instantaneous series `current_commit_mib` (`PagedMemorySize64`) was added alongside `ws_mib` / `peak_ws_mib`. | `scripts/measure_snarkjs.ps1` |
| 2 | "Peak commit exceeds peak resident by 18 %–20 %, so ~1/5 of committed memory is not resident" | **Deleted.** The two figures are independent historical maxima that may occur at different instants, and Working Set and commit charge do not cover the same page sets. Both peaks are now reported separately and no ratio is derived. | §2.4 |
| 3 | "Largest reads are individual Lagrange sections (~25 MiB at p18), which is why the pool is ~53 MiB" | The largest read is **48 MiB**, not 25 MiB: `sG = G.F.n8*2` gives 192 B/point for G2, and `2^18 × 192 B = 48 MiB`. The 6759 measured pages are exactly `floor(48 MiB × 1.1 / 8 KiB) + 1`. | §3.2 |
| 4 | "The 422 MiB figure belongs to `prepare_phase2`, not to Prepared Verify" | At **Power 21** Prepared Verify's own G2 read reaches `2^21 × 192 B = 384 MiB`, which yields the same ≈422 MiB capacity estimate. The figure is a capacity estimate for a 384 MiB single read, not a `prepare_phase2` exclusive; it has not been measured at p21. | §3.2 |
| 5 | "`capacity == held` in every run … at the moment of peak every page buffer is live" | Three independent historical maxima cannot support a statement about one moment. The probe now stores a **synchronized snapshot** (capacity, pages, `avBuffs` read in one sample); the claim is restated as an observation about that sample. | §3.1 |

---

## 1. Method

| Component | What it does |
| --- | --- |
| `scripts/m4_instrument.js` | Non-invasive FastFile probe. `require('fastfile')` returns the same cached CJS build binfileutils uses; we wrap its exported factories (`readExisting`, `readWriteExisting`, …) and patch the returned `FastFile` prototype. Per-read hooks only read `maxPagesLoaded` (O(1)); a 50 ms sampler does the O(pages) `Object.keys(pages)` scan and records a **synchronized snapshot** of `(maxPagesLoaded, pagesCount, avBuffsCount)`. No dependency source is modified. |
| `scripts/measure_snarkjs.ps1` | Launches `node --require` ×2 (timestamp hook + FastFile probe) directly and polls four quantities at 50 ms, writing a per-poll timeline. |
| `scripts/measure_m4.ps1` | Repeats the operation N times (`-Prefix` sets the run-label prefix), sets a per-run `M4_FASTFILE_OUT`, aggregates. |
| `scripts/build_m4_summary.cjs` | Mean/median/min/max/stdev/CV over PASS runs + FastFile pool merge. |
| `scripts/m4_stage_analysis.cjs` | Deciles, largest working-set jumps, and snarkjs phase markers (ANSI-stripped) with the current WS/commit at each marker. |

**The four quantities recorded per poll**

| Field | .NET property | Meaning |
| --- | --- | --- |
| `ws_mib` | `Process.WorkingSet64` | current working set (can go down) |
| `current_commit_mib` | `Process.PagedMemorySize64` | current commit charge (can go down) |
| `peak_ws_mib` | `Process.PeakWorkingSet64` | historical peak working set (never decreases) |
| `peak_commit_so_far_mib` | `Process.PeakPagedMemorySize64` | historical peak commit charge (never decreases) |

Only the two `peak*` values are authoritative for peaks; they are kernel counters, so they
do not depend on the poll rate. The two current values describe the *shape* of the run.
`sampled_commit_max_mib` (max of the sampled `current_commit_mib`) is kept as a check on how
much the 50 ms polling misses: it lands at **98.4 %–99.8 %** of `peak_commit_mib`, i.e. polling
underestimates the peak by ~0–1.6 % and must not be used as the peak.

**Metric corrections carried over from M3**

1. **`Process.PeakPagefileUsage` does not exist in .NET Framework 4.x.** The M3-era reads
   silently returned `$null`, so every M3 `peak_pagefile_usage_mib` is a meaningless `0`.
   The correct property for peak commit charge is `PeakPagedMemorySize64`.
2. **The old field name was wrong, not just the value.** `peak_pagefile_usage_*` implied
   "pagefile usage"; the property measures **commit charge**. JSONs before M4.1 kept the old
   name; from M4.1 the field is `peak_commit_mib`.

Each power was measured **3 times in two sessions** (M4, then M4.1) — 6 runs per power, all
exited 0.

---

## 2. Repeat baseline

### 2.1 Per-run results

| session | run | peak WS (MiB) | peak commit (MiB) | max sampled commit (MiB) | elapsed (ms) | samples |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| **p16** | | | | | | |
| M4 | r1 | 1633.10 | 1940.30 | — | 9 845 | 136 |
| M4 | r2 | 1662.68 | 1968.12 | — | 9 866 | 138 |
| M4 | r3 | 1690.94 | 1999.35 | — | 10 355 | 150 |
| M4.1 | r1 | 1631.17 | 1935.40 | 1931.96 | 10 235 | 141 |
| M4.1 | r2 | 1730.24 | 2031.55 | 2022.94 | 10 280 | 144 |
| M4.1 | r3 | 1608.54 | 1903.96 | 1891.73 | 11 762 | 163 |
| **p18** | | | | | | |
| M4 | r1 | 3674.59 | 4394.18 | — | 39 206 | 542 |
| M4 | r2 | 3634.15 | 4392.33 | — | 40 276 | 554 |
| M4 | r3 | 3617.25 | 4353.64 | — | 39 769 | 555 |
| M4.1 | r1 | 3737.72 | 4444.25 | 4381.37 | 40 225 | 550 |
| M4.1 | r2 | 3893.59 | 4599.75 | 4581.40 | 30 659 | 458 |
| M4.1 | r3 | 3720.60 | 4447.67 | 4376.91 | 35 582 | 492 |

("—" = the M4 script version did not sample a current commit series.)

### 2.2 Session statistics

| Power | Quantity | M4 (n=3) | M4.1 (n=3) | pooled (n=6) |
| ---: | --- | ---: | ---: | ---: |
| 16 | Peak WS mean ± sd (MiB) | 1662.24 ± 28.92 | 1656.65 ± 64.73 | **1659.44 ± 44.94** |
| 16 | Peak WS CV | 1.74 % | 3.91 % | **2.71 %** |
| 16 | Peak commit mean ± sd (MiB) | 1969.26 ± 29.54 | 1956.97 ± 66.47 | **1963.11 ± 46.50** |
| 16 | Peak commit CV | 1.50 % | 3.40 % | **2.37 %** |
| 18 | Peak WS mean ± sd (MiB) | 3641.99 ± 29.46 | 3783.97 ± 95.32 | **3712.98 ± 100.14** |
| 18 | Peak WS CV | 0.81 % | 2.52 % | **2.70 %** |
| 18 | Peak commit mean ± sd (MiB) | 4380.05 ± 22.89 | 4497.23 ± 88.81 | **4438.64 ± 86.51** |
| 18 | Peak commit CV | 0.52 % | 1.97 % | **1.95 %** |

### 2.3 Reproducibility — and its real size

- **Within a session** the repeats are tight: p18 peak WS CV 0.81 % in M4, 2.52 % in M4.1.
- **Between the two sessions** the p18 mean moved by **+142 MiB (+3.9 %)** and peak commit by
  **+117 MiB (+2.7 %)**; p16 moved by −0.3 % / −0.6 %. The M4.1 p18 runs are also faster
  (30.7–40.2 s vs 39.2–40.3 s) and noisier (CV 2.5 % vs 0.8 %).
- **This supersedes the M4 claim that p18 "agrees with M3 to −0.5 %".** That agreement was a
  coincidence between two single-session numbers. Across three sessions the p18 Prepared Verify
  peak is **3617–3894 MiB (3.53–3.80 GiB), mean 3713 MiB, CV 2.7 %**, and M3's 3660 MiB sits
  inside that band. The conclusion "≈3.6 GiB, not noise" survives; a two-decimal figure does not.
- **Do not read a cause into the session drift.** The fastest run (30.7 s) produced the highest
  peak (3893.6 MiB), which is consistent with a shorter run doing less heap/page trimming, but
  one correlation over six runs does not establish it.

### 2.4 What is *not* derived: a "non-resident share"

Peak Working Set and peak commit charge are reported side by side and are **not** subtracted
from each other. Two reasons:

1. They are independent historical maxima and can be reached at different moments.
2. They do not cover the same page set: Working Set counts resident pages including shareable
   ones, while commit charge counts committed private virtual memory including pagefile-backed
   pages that are not resident.

The synchronized timeline does show that within a single sample the commit series runs above
the Working Set series (p18 r1: 3997 vs 3378 MiB at 50 % of runtime). That is a statement about
two counters read at the same instant, and it is still **not** a decomposition of memory into
"resident" and "non-resident" parts, so no percentage is reported.

Scaling p16 → p18 (4× input): pooled peak WS ×2.24, peak commit ×2.26. With two powers and a
large fixed Node+WASM baseline this is **descriptive only** — it does not establish an
asymptotic growth order.

---

## 3. FastFile page pool

### 3.1 Measured pool, with a synchronized snapshot

| Power | pageSize | peakMaxPagesLoaded | capacity (MiB) | pages @ cap peak | avBuffs @ cap peak | held (MiB) | share of pooled peak WS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 16 | 8192 B | 1690 | 13.2 | 1690 | 0 | 13.2 | 0.80 % |
| 18 | 8192 B | 6759 | 52.8 | 6759 | 0 | 52.8 | 1.42 % |

`pages @ cap peak` and `avBuffs @ cap peak` are read **in the same 50 ms sample** as the
capacity, so they can legitimately be compared to it. All six runs (3 × p16, 3 × p18) produced
the identical triple: `(1690, 1690, 0)` and `(6759, 6759, 0)`.

Three observations, each bounded to what was measured:

1. **The pool is small relative to the peak** — 0.80 % at p16, 1.42 % at p18 of the pooled
   peak Working Set.
2. **At the sampled instant of maximum capacity, the number of retained page buffers equals the
   capacity and there were no free buffers.** This is an observation about the samples taken
   (129–152 FastFile samples per run at p16, 342–421 at p18), not a proof about every instant:
   the sampler runs every 50 ms, so states between samples are unobserved. It does say that the
   capacity ceiling was reached by buffers that were actually in use, i.e. the pool was not
   over-provisioned at that moment — which is the concrete form of the earlier correction that
   `maxPagesLoaded × pageSize` is an upper bound, not a residency figure.
3. **It scales O(N) with the input** (13.2 → 52.8 MiB for 4× data), exactly as a page cache
   should — and stays negligible either way.

### 3.2 Why 6759 pages: it is a 48 MiB read, and it involves G2

`verifyLagrangeEvaluations()` in snarkjs 0.7.6 does:

```js
const sG = G.F.n8 * 2;          // G1: 96 B/point, G2: 192 B/point
const nPoints = 2 ** p;
buffG = new BigBuffer(nPoints * sG);
await fd.readToBuffer(buffG, 0, nPoints * sG);
```

and fastfile (`osfile.js`) then raises its page ceiling to `floor(len * 1.1 / pageSize) + 1`.

| Power | largest single read | bytes | pages predicted | pages measured | capacity |
| ---: | --- | ---: | ---: | ---: | ---: |
| 16 | `2^16 × 192 B` (G2) | 12.0 MiB | 1690 | **1690** | 13.2 MiB |
| 18 | `2^18 × 192 B` (G2) | 48.0 MiB | 6759 | **6759** | 52.8 MiB |

The prediction matches the measurement exactly at both powers, so **the pool size is set by a
48 MiB read at p18, not by a 384 MiB one** — that is what rules out the 422 MiB figure for the
measured configuration. Note that the same 48 MiB is also reached by the `tau*G1` tail read
(`(2^19 − 1) × 96 B`), which yields the same 6759 pages; the page count alone cannot tell the two
paths apart, but it does fix the size of the largest read.

**Power 21 estimate (not measured).** At p21 the G2 read becomes
`2^21 × 192 B = 384 MiB`, and `floor(384 MiB × 1.1 / 8 KiB) + 1 = 54,068` pages ≈ **422.4 MiB**.
So the ≈422 MiB figure is a capacity estimate for *any* 384 MiB single read; it can arise in
`prepare_phase2` (a full 384 MiB point buffer) **and** in Prepared Verify's G2 full-domain read at
p21. It is an upper bound on retained page buffers, **not** a measured residency, and p21 has
not been run.

**Conclusion.** For Prepared Verify, the FastFile page cache is **not** a meaningful contributor
to the peak (≤ 1.5 %). Optimizing it would recover at most tens of MiB at the measured powers and
should be deprioritized for this operation.

---

## 4. Stage decomposition

Current (not peak) values from the 50 ms timeline, sampled at the first poll after each snarkjs
phase marker; stage boundaries from the timestamped stdout log (ANSI-stripped). MiB.

### Power 16 — M4.1 run r1 (peak 1631 / 1935)

| t (ms) | stage | current WS | current commit |
| ---: | --- | ---: | ---: |
| 620 | `power: 2**16` | 472 | 689 |
| 1 363 | verify τ·G1 | 442 | 660 |
| 1 775 | verify τ·G2 | 740 | 935 |
| 2 258 | verify α·τ·G1 | 1 018 | 1 243 |
| 2 466 | verify β·τ·G1 | 1 031 | 1 258 |
| 2 667 | **phase 2 verify tauG1** starts | 1 035 | 1 260 |
| 4 729 | phase 2 verify tauG2 | 1 229 | 1 517 |
| 7 692 | phase 2 verify ατG1 | 1 489 | 1 796 |
| 8 890 | phase 2 verify βτG1 | 1 396 | 1 686 |
| 9 663 | reading Lagrange16 | 1 343 | 1 647 |
| 10 235 | exit (peak) | — | — |

### Power 18 — M4.1 run r1 (peak 3738 / 4444)

| t (ms) | stage | current WS | current commit |
| ---: | --- | ---: | ---: |
| 600 | `power: 2**18` | 433 | 640 |
| 3 791 | verify τ·G1 | 441 | 664 |
| 6 713 | verify τ·G2 | 1 112 | 1 311 |
| 10 155 | verify α·τ·G1 | 854 | 1 043 |
| 11 518 | verify β·τ·G1 | 1 131 | 1 325 |
| 12 948 | contribution #1 | 851 | 1 064 |
| 12 949 | **phase 2 verify tauG1** starts | 776 | 978 |
| 20 506 | phase 2 verify tauG2 | 2 936 | 3 542 |
| 31 706 | phase 2 verify ατG1 | 3 202 | 3 910 |
| 35 857 | phase 2 verify βτG1 | 3 432 | 4 113 |
| 38 561 | reading Lagrange18 | 3 276 | 3 957 |
| 40 225 | exit (peak) | — | — |

**Interpretation (bounded to what is measured)**

- **Phase 1 is chunked and cheap in memory**: at p18 the current Working Set never exceeds
  ~1.13 GiB across 3.8–11.5 s, consistent with reading sections in `1<<16`-point chunks.
- **The first Phase-2 section carries almost the whole jump.** Between the tauG1 marker
  (776 MiB) and the tauG2 marker (2 936 MiB) the current Working Set rises by **+2.2 GiB**, and
  the 50 % decile already reads 3 378 MiB. The remaining Phase-2 sections oscillate between
  ~3.0 and ~3.4 GiB and push the peak to 3 738 MiB at ~36 s.
- **The FastFile pool is a constant 52.8 MiB throughout**, so it cannot explain the jump.
- Phase 2 also raises commit charge more than Working Set (p18 at 50 %: 3 997 vs 3 378 MiB),
  i.e. a growing part of the committed memory is not resident at that instant. This is observed,
  not decomposed (§2.4).

What M4 does **not** claim: the exact split of that +2.2 GiB among the FFT input copy
(`buff.slice`), MSM shard/accumulator buffers, and WASM linear-memory growth. That requires
instrumenting `engine_multiexp.js` / `engine_fft.js` allocation sites, which is M5 work.

---

## 5. What this means for the next step

1. **Do not target the FastFile cache** for Prepared Verify — ≤ 1.5 % of the peak and O(N) with
   the input; its p21 capacity estimate (~422 MiB) is a ceiling, not a reservation.
2. **Target the Phase-2 full-domain MSM path** — the first Phase-2 section is where ~2.2 GiB of
   the working set appears at p18. Candidate levers: the FFT input copy (H1), MSM shard
   concurrency, Phase-2 output-buffer lifetimes.
3. **Before patching, attribute.** Instrument `engine_multiexp.js` / `engine_fft.js` to record
   allocation size and release point per call, targeting a table like:

   | source | allocation size | peak overlap | optimizability |
   | --- | --- | --- | --- |
   | FFT input copy (`buff.slice`) | to measure | to measure | H1 |
   | MSM shards / accumulators | to measure | to measure | to study |
   | WASM linear memory | to measure | to measure | to study |
   | FastFile page pool | 52.8 MiB @ p18 | synchronized snapshot taken (§3.1) | low |

---

## 6. Caveats

- **Single machine** (32 GiB), 3 + 3 repeats per power across two sessions. No Power 20/21.
- **Session drift is real**: within-session CV 0.8–3.9 %, between-session mean shift up to 3.9 %
  (p18). Quote p18 as 3617–3894 MiB (mean 3713 MiB), not to two decimals.
- **Peak Working Set ≠ Linux RSS ≠ private bytes**; peak commit charge is reported separately
  and the two are never subtracted (§2.4).
- **The timeline is 50 ms resolution** and reflects shape only; sampled peaks recover
  98.4–99.8 % of the kernel peak commit, which is why the kernel counter, not the timeline, is
  the reported peak.
- **FastFile sampling is 50 ms as well**; the synchronized snapshot is a statement about the
  samples taken, not about every instant.
- **Instrumentation perturbs elapsed time**, not memory. A first version scanned
  `Object.keys(pages)` on every read and inflated p16 elapsed from ~10 s to ~18 s; the shipped
  version does an O(1) read per call. Elapsed across instrumented runs should be treated as
  within ~±10 % of an uninstrumented run, not as a timing baseline.
- **Only two powers** are used; the ×2.24 / ×2.26 scaling figures are descriptive.
