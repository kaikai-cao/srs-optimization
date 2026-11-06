# ALGEBRAIC_RELATIONS — 五类 CRS 参数的配对关系验证（M2-A）

> 状态：**结论冻结**（用户 2026-11-06 验收通过）。本文件在 R1–R4 修订批次中
> 只更新「实验设置」与「复现」：正式实验改用 OS 随机 SRS 后重新跑过一遍，
> 三组关系与 2,080 / 4,160 计数**完全不变**。
> 实现 `crates/srs-relations/src/powers.rs`、`pairing.rs`；
> 机器可读结果 `results/raw/m2_results.json`（不入库）。
> 依赖 arkworks `0.6.0`（`ark-bls12-381` / `ark-ec` / `ark-ff` / `ark-std` / `ark-serialize`）。

## 1. 实验设置（与文件解析隔离）

本阶段**不解码 `.ptau` 的 LEM/Montgomery 点**，而是用 arkworks 独立生成一份
小规模、完全可控的 BLS12-381 测试 SRS，把数学问题与文件格式问题分开。

| 项 | 值 |
| --- | --- |
| 曲线 | BLS12-381（arkworks 0.6.0） |
| 容量 | `N = 32` |
| Tau G1 序列长度 | `2N-1 = 63` |
| **正式实验** RNG | `getrandom` OS 熵（32 B 随机种子）→ `StdRng` → $\tau,\alpha,\beta$ |
| **单元测试** RNG | `#[cfg(test)]` 内的固定种子 `TEST_SEED`，仅用于可复现测试，release 不编译 |
| 秘密标量 | $\tau,\alpha,\beta \in \mathbb F_r^\*$，逐个拒绝零值 |
| 秘密处理 | 秘密标量只在 `gen` 进程内存在，**不传递给恢复接口**、不写入任何文件；该进程退出后消失。不作 `drop` 安全清零声明 |

生成五类参数：

$$P_i=[\tau^i]G_1\ (0\le i\le 2N-2),\quad Q_i=[\tau^i]G_2\ (0\le i\le N-1)$$
$$A_i=[\alpha\tau^i]G_1,\quad B_i=[\beta\tau^i]G_1\ (0\le i\le N-1),\quad B_2=[\beta]G_2$$

**为什么改 RNG（R1）**：旧版把 `SRS_SEED` 作为 `pub const` 公开在仓库里，
任何人都可用同一 RNG 重建 $\tau,\alpha,\beta$ 并直接算出所有缺失群元素，
这会破坏 M2-B「攻击者不知道陷门」的实验前提。现在正式实验的种子来自 OS 熵、
不落盘、不提交；公开测试参数改用 `public_dataset_sha256` 标识。
固定种子只保留在单元测试中，用于保证**工程测试**可复现。

**公开常量（R2）**：$P_0=G_1$、$Q_0=G_2$ 是曲线标准生成元，不是未知参数。
本机 `node_modules/snarkjs/src/powersoftau_verify.js:182-183`、`:201-202`
对 Tau G1 / Tau G2 Section 的首元素做了同样的硬校验。
`powers.rs::generators_match_index_zero` 与
`compression_tests.rs::q0_is_the_public_generator` 两个单测锁定这一点。

## 2. 被验证的三组关系

| 编号 | 关系 | 合法索引范围 |
| --- | --- | --- |
| R1 | $e(P_i,Q_j)=e(P_{i+j},Q_0)$ | $0\le i\le 2N-2,\ 0\le j\le N-1,\ i+j\le 2N-2$ |
| R2 | $e(A_i,Q_j)=e(A_{i+j},Q_0)$ | $0\le i\le N-1,\ 0\le j\le N-1,\ i+j\le N-1$ |
| R3 | $e(B_i,Q_0)=e(P_i,B_2)$ | $0\le i\le N-1$ |

代数原因（双线性）：$e([a]G_1,[b]G_2)=e(G_1,G_2)^{ab}$，故 R1 两侧指数同为 $\tau^{i+j}$，
R2 同为 $\alpha\tau^{i+j}$，R3 同为 $\beta\tau^i$。
导师特别关注的相邻关系 $e(P_i,Q_1)=e(P_{i+1},Q_0)$ 是 R1 在 $j=1$ 的特例，已包含在遍历中，
并有独立单元测试 `adjacent_tau_relation_holds`。

**验证方式**：不是抽样，而是遍历全部合法 $(i,j)$ 组合，覆盖边界
（$i=0$、$i=2N-2$、$j=0$、$j=N-1$）、奇偶指数、以及跨不同幂次的组合。

## 3. 结果（修订批次在随机 SRS 上复跑）

```
Tau pairing relations: PASS (1520 groups)
Alpha pairing relations: PASS (528 groups)
Beta pairing relations: PASS (32 groups)
Total relation checks: 2080 (4160 pairings)
```

| 关系 | 验证组数 | 公式核对 | 结果 |
| --- | --- | --- | --- |
| R1 Tau | 1,520 | $\sum_{i=0}^{31}32 + \sum_{i=32}^{62}(63-i) = 1024+496$ | PASS |
| R2 Alpha | 528 | $N(N+1)/2 = 32\times33/2$ | PASS |
| R3 Beta | 32 | $N$ | PASS |
| 合计 | 2,080 | 每组 2 次配对 → 4,160 次 | PASS |

计数只依赖 $N$ 与索引范围，与 $\tau$ 的具体取值无关，因此换成随机 SRS 后数值不变。
`verify_all` 在 `gen` 进程中对当次随机 SRS 全量遍历；结果写入
`public/relations.json` / `manifest.json`，由 `eval` 汇总进 `m2_results.json`。

## 4. 这些 PASS 能说明什么、不能说明什么

**能说明**：自生成的测试 SRS 在五类参数之间满足 Powers-of-Tau 应有的双线性结构；
因此 M2-B 可以把 $e(P_i,Q_j)=e(P_{i+j},Q_0)$ 当作**可公开计算的 GT 目标**来使用。
R2 修订后，$(0,P_0)$ 也纳入公开来源，使 $e(P_0,Q_k)=e(P_k,Q_0)$ 对 $k<N$ 恒成立。

**不能说明**：

- 这不是完整的 Powers-of-Tau 贡献验证。真正的验证要检查贡献链、公钥、
  response hash / nextChallenge 以及 `snarkjs powersoftau verify` 所做的全部配对关系。
  本实验只用自造参数，没有贡献链。
- 这些 PASS 只是结构一致性，**不提供任何关于 $\tau,\alpha,\beta$ 的知识**，
  也不意味着缺失群元素可以被构造出来（见 `COMPRESSION_EXPERIMENTS.md`）。
- 配对结果落在 $G_T$，不是 $G_1$。能验证一个候选点，不等于能算出这个点。

## 5. 复现

```bash
cargo check -p srs-relations
cargo test --workspace                 # 35 个测试，含 M2-A 关系遍历与 R1/R2/R3 新用例
bash scripts/run_m2b.sh                # gen 阶段会在随机 SRS 上重跑 verify_all，
                                       # 并把计数写进 results/raw/m2_results.json
```

单独只验证关系，可运行 `powers::generate_from_os_entropy` + `pairing::verify_all`；
正式实验请以 `scripts/run_m2b.sh` 的三进程流程为准。
