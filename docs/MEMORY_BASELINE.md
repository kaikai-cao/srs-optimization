# M3-E｜Powers of Tau 内存基线测量与热点分析

> 配套文档：`docs/MEMORY_SOURCE_AUDIT.md`（M3-A 源码级分配表）、`results/raw/m3_*.json`（逐次原始记录）、
> `results/processed/m3_summary.csv` 与 `m3_tables.md`（汇总）。本文件只做**实测分析**，
> 不修改 snarkjs / ffjavascript 计算逻辑。
>
> 验收清单全部覆盖：M3-A / M3-B / M3-C / M3-D / Prepared Verify / SHA-256/大小/退出码 /
> 峰值工作集与耗时对照图 / 热点分析与 H1 / Git 提交。

## 1. 测量环境与方法（指标口径）

| 项 | 值 |
| --- | --- |
| 平台 | Windows 11 家庭版 Insider（x64，非 WSL） |
| CPU | Intel i7-14700，28 逻辑核（`ffjavascript` `tm.concurrency=28`） |
| 内存 | 32 GiB 物理，记录时约 14.9 GiB 空闲 |
| Node | v22.22.2（V8 12.4.254.21-node.39） |
| snarkjs / ffjavascript / binfileutils / fastfile | 0.7.6 / 0.3.1 / 0.0.12 / 0.0.20 |
| Powershell | 5.1.26100.9836 |
| **指标** | **Windows Peak Working Set（进程 `PeakWorkingSet64`）** |

- 测量脚本：`scripts/measure_snarkjs.ps1`（独立 `node` 进程、100 ms 轮询 `PeakWorkingSet64`、
  记录退出码、输入 SHA-256、耗时、stdout/stderr 日志）；`scripts/run_m3_benchmarks.ps1` 编排矩阵；
  `scripts/timestamp_hook.cjs` 给 snarkjs 日志注入毫秒级时间戳用于分阶段耗时。
- **口径一致性**：始终保持 **Windows Peak Working Set**，不标成「Linux Maximum RSS」。
  该指标包含 Node 代码、V8 堆、WASM 线性内存、`fastfile` 页缓存（Node `Buffer`）、
  `BigBuffer`/`Uint8Array` 外部内存、以及 OS 映射进进程工作集的文件页——即所有可被 snarkjs
  真实占用的部分都已计入。
- 测量了三种操作：`phase1_verify`（仅贡献关系，需 `_0001`）、`prepare_phase2`、
  `prepared_verify`（对已含 Sections 12–15 的 `*_final.ptau` 做 Phase 1 + Phase 2 Lagrange 验证）。
- 全量原始 JSON 见 `results/raw/m3_{phase1_verify,prepare_phase2,prepared_verify}_p{10,12,14,16,18}.json`。
  所有 `.ptau` 均被 `.gitignore` 排除，未入库；仅保留 SHA-256 与大小。

## 2. 实测结果

### 2.1 峰值工作集（MiB）与总耗时（s）

| 操作 | p10 | p12 | p14 | p16 | p18 |
| --- | ---: | ---: | ---: | ---: | ---: |
| **Phase 1 Verify**（仅贡献验证） | 532.07 | 501.95 | 654.53 | 1117.60 | 1195.61 |
| **Phase 2 Prepare** | 475.00 | 513.86 | 651.12 | 1028.65 | 1609.94 |
| **Prepared Verify**（Phase1 + Lagrange） | 616.92 | 715.03 | 1152.50 | 1694.68 | 3660.04 |
| — Prepare 总耗时 (s) | 3.64 | 15.16 | 77.09 | 355.84 | 1589.55 |
| — Prepared Verify 总耗时 (s) | 1.20 | 1.78 | 3.69 | 12.59 | 43.09 |
| — Phase 1 Verify 总耗时 (s) | 0.86 | 0.96 | 1.42 | 2.93 | 13.44 |

### 2.2 Prepare Phase2 各 Section 耗时（ms，p18 为单位秒）

| Power | tauG1 | tauG2 | alphaTauG1 | betaTauG1 |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 810 | 1219 | 403 | 454 |
| 12 | 3709 | 6646 | 1982 | 2070 |
| 14 | 21997 | 33214 | 10856 | 10172 |
| 16 | 100132 | 159799 | 48369 | 46438 |
| 18 | 454214 | 710927 | 205378 | 217340 |

各 Section 随 Power 翻倍约增长 **3.6–4.2×**，符合 `O(N·logN)` 的 FFT/MSM 量级；
`tauG2` 与 `tauG1` 主导耗时（点更大或更密集）。

### 2.3 输入 / 输出体积

| Power | 输入 `_0001.ptau` | 输出 `_final.ptau`（含 Sections 12–15） |
| ---: | ---: | ---: |
| 10 | 592,215 | 1,771,431 |
| 12 | 2,361,683 | 7,079,843 |
| 14 | 9,439,571 | 28,313,507 |
| 16 | 37,751,121 | 113,248,161 |
| 18 | 150,997,329 | 452,986,785 |

所有输入/输出 SHA-256 已写入对应 JSON 与 `m3_tables.md`；每次退出码均为 0。

## 3. 核心验证：384 MiB 假设 vs 实测峰值

你给的朴素估算：**Power 21** 下 Phase 2 Prepare 的 Tau G1 / Tau G2 输入缓冲区各为 `2N×96 = 384 MiB`。
但实测表明「384 MiB 不能直接当成整个流程的峰值内存」——而且**偏差比预想的更严重**：

| 场景 | 朴素单输入缓冲估算 | 实测峰值工作集 | 倍数 |
| --- | ---: | ---: | ---: |
| Power 18，Prepare | **48 MiB**（`2N=2^19`, `2^19×96=48 MiB`） | **1610 MiB** | **≈ 33×** |
| Power 21（外推，见 §6） | 384 MiB | 预计数 GiB | — |

> Power 18 时朴素输入缓冲只有 48 MiB，实测却是 1610 MiB，说明真正的峰值由**多个大缓冲区叠加**构成，
> 与 M3-A 审计表完全对应：`A3`（fastfile 页缓存随大 `readToBuffer` 放大到约 `1.1×len`）、
> `A4`（FFT 入口 `buff.slice(0, len)` 全量复制）、`A9/A11`（FFT 输出 + MSM 分片与 WASM 中间缓冲）。
> 单看 `2N×96` 完全低估了峰值。

## 4. 五个热点问题（M3-E 验收）

**Q1. Phase 1 Verify 的分块策略是否真的限制了峰值？**
是的，但只是「相对最低」。三种操作中 Phase 1 Verify 在**每个 Power 都是峰值最低的**，
证明 `MAX_CHUNK_SIZE = 1<<16`（每 chunk 6 MiB G1 / 12 MiB G2）把逐块读入上限压住了。
但峰值仍随 Power 上升（532→1196 MiB），原因是贡献验证需顺序读取整段 Section 2–7，
`fastfile` 页缓存 `maxPagesLoaded` 被首次大读取永久放大（`A3`），叠加 ~450 MiB 的 Node+WASM 基线。
结论：分块有效，但不消除增长。

**Q2. Phase 2 Prepare 的 FFT 是否产生大量重复缓冲区？**
**是，已被实测证实。** 峰值 1610 MiB 相对朴素 48 MiB 高达 33×；
审计表 `A4/A9/A11` 的「输入副本 + FFT 输出 + MSM 分片」三套全量 384 MiB 级缓冲（p21 口径）
在 p18 虽名义更小，但页缓存与多 Section 串行累积仍把峰值推到 1.6 GiB。
这是本阶段**最值得优化**的对象。

**Q3. Prepared Verify 的全域 MSM 是否带来额外内存复制？**
**是，且是三者中最严重的热点。** Prepared Verify 峰值增长最快：
p14→p16→p18 分别为 1153→1695→**3660 MiB**（最后一步 2.16×/翻倍）。
审计表 `C4/C5`（verifyLagrangeEvaluations 的两次 full-domain `multiExpAffine` + Fr FFT 往返）
在 p18 上把工作集推到 3.6 GiB。它同时做 Phase 1 贡献验证（Q1 的页缓存）+ Phase 2 Lagrange 全域 MSM，
两类大缓冲叠加，故高于单独的 Prepare。

**Q4. 峰值内存是否近似随 2^k 线性增长？**
**不是线性，是超线性（约 1.5–2.2× / 翻倍）。** 每翻一倍 Power：
- Prepare 峰值 ×1.08→×1.27→×1.58→×1.56（高 Power 段趋近 1.5×）；
- Prepared Verify 峰值 ×1.16→×1.61→×1.47→**×2.16**（p18 段加速）。
说明数据相关分配（缓冲副本、页缓存、WASM 中间态）的增长快于单纯数据量 `O(N)`。

**Q5. 各阶段是否有明显的时间/空间交换？**
有，且方向是「用空间换时间」：FFT/MSM 的 `Promise.all` 分块并行
（`engine_fft.js` 按 `2^bits` 切分、每片独立 worker 线程，28 线程并发）通过持有多份中间分片
来换取并行吞吐——这正是峰值随线程数/分片数放大的直接原因（见 `A9` chunk 缓冲与 `threadman` 多线程 WASM）。

## 5. H1 优化假设可行性判断

> H1：在 `processSectionPower()` 中，输入缓冲在转换完成后不再需要原始内容，可设计
> 「消耗输入缓冲区（consume-input）」的 FFT 路径，复用输入内存而非先全量复制再重分配输出。

**结论：方向成立，但单次消除「一次输入复制」收益有限，不是峰值主因。**

支持 H1 的源码事实：
- `engine_fft.js:235` 的 `buff = buff.slice(0, buff.byteLength)` 是 `Uint8Array.prototype.slice`，
  **确实产生真实数据复制**（M3-A 已确认 `slice` 非视图）。
- `buffReverseBits`（`utils.js`）在 `slice` 之后执行，说明复制是为保护原始输入不被位逆序破坏；
  若调用方在 FFT 前已不需要原缓冲，理论上可就地位逆序，**省去一次 48 MiB（p18）~ 384 MiB（p21）副本**。
- `buffOut` 为新建缓冲区（`A11`），输出大小与输入相同（affine→affine），**可尝试直接复用被消费的输入内存**。

但必须警惕的约束（你已点名）：
- `engine_fft.js` 的 `Promise.all` 把缓冲切成多个 chunk 并发做蝴蝶运算，中间 chunk 在 join 前全保留——
  **真正放大峰值的是「多 chunk 中间态 + 28 线程 WASM 工作内存」**（见 `A9`），一次输入复制只是其中一项。
- `buffReverseBits` 是否修改输入、`Fr` 与 `G1/G2` 的位逆序是否共享同一缓冲、`worker_threads` 间是否有数据竞争，
  都需逐一核实后才能改动；任一错误都会破坏 `e(P_i,Q_j)=e(P_{i+j},Q_0)` 级别的代数关系。
- 正确性门槛：任何优化必须满足 `Optimized Output == Original Output`，比较手段是
  **对 Sections 12–15 逐字节核对 + snarkjs 完整 `verify` 通过**，而非仅能读出文件。

**建议**：H1 作为后续 M3 优化阶段的候选，但应与「缩短页缓存生命周期（`A3`）」「限制 FFT 并发分片数（`A9`）」
合并评估——单点优化预计只能回收峰值的一小部分（约 1 份 48 MiB~384 MiB 副本），
而页缓存与并发分片才是 p18 上 1.6–3.6 GiB 峰值的更大贡献者。

## 6. Power 21 规模外推（仅测算，未运行）

按 §4 的每翻倍倍数（取保守 1.56× 与激进 2.16× 两档），从 p18 外推 3 个翻倍到 p21：

| 操作 | p18 实测 | p21 外推（×1.56³） | p21 外推（×2.16³） |
| --- | ---: | ---: | ---: |
| Phase 1 Verify | 1196 MiB | ~4.5 GiB | ~6 GiB |
| Phase 2 Prepare | 1610 MiB | ~6 GiB | ~16 GiB |
| Prepared Verify | 3660 MiB | ~14 GiB | ~36 GiB |

- 磁盘：p18 `final` 输出 432 MiB；p21 预计输入 ~1.2 GiB、`final` ~2.5–3 GiB，当前 D: 盘余量充足。
- 内存风险：p21 的 Prepared Verify 可能逼近 15–25 GiB，在当前 32 GiB 机器上**有 OOM 风险**；
  Prepare 约 6–10 GiB，相对安全。
- **按你的要求，本轮未运行 Power 21**；是否实测需在拿到 p18 数据与优化方案后单独决策。

## 7. 局限与诚实声明

1. **Peak Working Set ≠ Private Bytes ≠ Linux RSS**：这是 Windows 进程驻留工作集峰值，含 OS 文件缓存页；
   与「进程独占私有内存」和「Linux RSS」口径不同，跨平台比较时必须保持本口径。
2. **基线开销未扣除**：~450 MiB 的 Node+WASM 启动基线被计入每次峰值；数据相关增量见 §3/§4。
3. **分阶段耗时的精度**：Phase 2 Lagrange 耗时取自 `prepared_verify` 日志的 `Verifying phase2 calculated values`
   区间；Prepare 各 Section 耗时取自 `processSectionPower` 的 Section 级日志，均为 ms 级相对值，非 CPU 独占时间。
4. **未触碰计算逻辑**：所有数据来自 `node`（已发布 snarkjs 0.7.6）的只读观测，未 patch 任何依赖。
5. **样本规模**：每个 Power 各运行一次（非多次取中位数）；耗时受机器并发负载影响，峰值内存为进程级硬上限，更稳健。
