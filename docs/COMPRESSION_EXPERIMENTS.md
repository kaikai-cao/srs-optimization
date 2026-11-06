# COMPRESSION_EXPERIMENTS — 奇偶幂次 / 前半部分 / 间隔采样恢复实验（M2-B）

> 状态：**R1–R4 修订版完成（2026-11-06）**。M1 与 M2-A 结论冻结；本文件按评审意见
> 修复了实验安全模型、公开生成元处理与存储统计口径，并重新运行了七种方案。
> 原始数据 `results/raw/m2_results.json`（不入库）。
> 结论仍是**负面结果**，但实验前提已收紧，失败环节定位不变。

## 0. 本轮修订了什么

| 编号 | 问题 | 修订 |
| --- | --- | --- |
| R1 | 旧版把生成 $\tau,\alpha,\beta$ 的固定种子 `SRS_SEED` 写进源码并公开，任何人都能重建陷门 | 正式实验改用 OS 熵；固定种子仅保留在 `#[cfg(test)]`；生成 / 恢复 / 评估拆成三个独立进程 |
| R2 | $P_0=G_1,\ Q_0=G_2$ 是公开常量，旧版既没保存也没当作已知量使用 | 恢复时自动填充 $P_0$；GT 目标构造把 $(0,P_0)$ 纳入公开来源 |
| R3 | 旧 `storage_reduction_pct` 只对自定义 SCP1 基线（12 + 63×100），不是原始 CRS 口径 | 输出三种口径：原生 Tau G1 Section / SCP1 表示 / 五组参数总大小 |
| R4 | — | 重新生成公开参数、重跑七种方案、更新四份产物 |

## 1. R1：实验安全模型（三进程隔离）

```
┌─ 进程 1: gen (src/main.rs) ─────────────────────────────────┐
│  getrandom OS 熵 → 32 B 随机种子 → StdRng → τ, α, β          │
│  种子是局部变量：不返回、不打印、不序列化、不落盘、不提交      │
│  生成完整公开 SRS → public/aux.bin + 7 个 SCP1 文件            │
│                    + oracle/tau_g1_full.bin（仅 eval 读）      │
│  记录：公开数据集 SHA-256（不是种子）                          │
└──────────────────────────────────────────────────────────┘
                          │ 只写公开文件
                          ▼
┌─ 进程 2: recover (src/bin/recover.rs) ──────────────────────┐
│  唯一输入：public/aux.bin + 7 个 public/*.bin                 │
│  不打开 oracle/，不生成 SRS，不接触 τ/α/β 与完整 Tau G1 数组   │
│  输出：recovered/*.bin（部分恢复结果）+ summary.json           │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ 进程 3: eval (src/main.rs) ────────────────────────────────┐
│  读 oracle + recovered + manifest，独立逐点比较并评分          │
│  计算三种存储口径，写 results/raw/m2_results.json              │
└──────────────────────────────────────────────────────────┘
```

- 编排脚本：`scripts/run_m2b.sh`（三次 `cargo run --release …`，即三个独立 OS 进程）。
- **正式实验种子**来自 `getrandom`（Windows 上为 `BCryptGenRandom`），进程退出即消失；
  仓库、公开参数文件和报告中都**没有**它。公开测试参数用
  `public_dataset_sha256` 标识，可在本地复用同一份公开数据而无需知道陷门。
- `ark-std 0.6.0` 以 `default-features = false, features = ["std_rng"]` 引入 rand，
  因此 `OsRng` / `StdRng::from_entropy` 不可用，本实现显式依赖 `getrandom 0.2`。
- **固定种子仅用于单元测试**：`powers.rs` 中常量改名为 `TEST_SEED` 并置于
  `#[cfg(test)]`，release 二进制不编译它。`os_entropy_path_is_usable_and_not_the_fixed_seed`
  单测验证正式路径确实不使用该固定种子。
- 关于 `drop(secret)`：这里只表示「秘密标量不传递给恢复接口」，**不作安全清零声明**；
  真正的隔离来自进程退出，而不是 `drop`。

### 隔离边界（诚实说明）

这是**进程级 + 输入级**隔离，不是编译单元级隔离：`recover` 与 `gen`/`eval`
同属一个 package，链接同一个 lib（lib 内含生成代码）。但 `recover` 进程的
代码路径里没有 oracle 读取、没有 SRS 生成、没有陷门输入；它的三个输入文件
都是公开数据，且 `manifest.json` 显式记录了 `oracle_accessed: false`。
因此「恢复程序意外访问完整数组」在运行时不成立。若后续需要更形式化的保证，
可把恢复模块拆成独立 crate —— 本轮未做，也不宣称已做。

### 公开数据格式（M2 专用，不是 .ptau 片段）

| 文件 | 内容 |
| --- | --- |
| `public/aux.bin` | `SAX1` + n + seq_len + $Q_j$(N×192 B) + $A_i$(N×96 B) + $B_i$(N×96 B) + $B_2$(192 B) |
| `public/<scheme>.bin` | SCP1：`SCP1`(4) + seq_len u32 + count u32 + count×[index u32 + 96 B G1] |
| `oracle/tau_g1_full.bin` | `SOR1` + count u32 + 63×96 B（评分 oracle，**仅 eval 读**） |
| `recovered/<scheme>.bin` | `SCR1` + count u32 + count×[index u32 + 96 B G1] |

使用 arkworks canonical **uncompressed** 序列化，与 snarkjs 的 LEM/Montgomery 编码不同；
这些是数学实验样本，不是 `.ptau` 片段。全部位于 `results/raw/m2b/`，被 `.gitignore` 排除。

恢复接口仍保持评审要求的签名（只接受公开参数）：

```rust
fn recover_missing_powers(
    public_parameters: &CompressedParameters
) -> Result<Vec<G1Affine>, RecoveryError>
```

## 2. R2：$P_0, Q_0$ 是公开生成元，不是未知参数

$P_0=[1]G_1=G_1$、$Q_0=[1]G_2=G_2$ 是曲线标准常量。本机
`node_modules/snarkjs/src/powersoftau_verify.js:182-183` 明确校验
`First element of tau*G1 section must be the generator`，
`:201-202` 对 Tau G2 做同样校验。因此：

1. 恢复时若索引 0 不在压缩文件中，自动填 `G1Affine::generator()`
   （`implicit_generator_filled = 1`）；它算「由公开常量确定」，不是求逆成功。
2. GT 目标构造的公开来源集合加入 $(0,P_0)$。对任意 $0\le k<N$，
   即使一个 $P_i$ 都没保存，也能用 $e(P_0,Q_k)=e(P_k,Q_0)$ 算出 $t_k$。
3. 候选集显式加入 $P_0$。

**效果**：`odd_only` 的 GT 目标覆盖从旧版 31/32 修正为 **32/32**，
其中 $P_0$ 本身被直接确定；其余 31 个偶数次幂仍无法恢复。
其余方案覆盖率不变（`first_half` 仍为 31/47，因为 $k\ge N$ 时没有公开的 $Q_k$）。
`q0_is_the_public_generator`、`odd_only_fills_implicit_generator_and_still_fails`
两个单测锁定了这一行为。

## 3. R3：三种存储统计口径（$N=32$，序列长度 $2N-1=63$）

| 口径 | 计算 | 值 (B) | 说明 |
| --- | --- | ---: | --- |
| ① Tau G1 原生 Section | $(2N-1)\times96$ | **6,048** | `.ptau` Section 2 的实际布局，无逐点索引（M1 已审计） |
| ② SCP1 表示 | $12 + m\times100$ | 各方案不同 | M2 自定义格式，每点 4 B 索引 + 96 B 点 + 12 B 头 |
| ② 的基线（全部 63 点） | $12+63\times100$ | **6,312** | 旧版 `storage_reduction_pct` 的分母 |
| 其余四组原生参数 | $N\times192 + 2N\times96 + 192$ | **12,480** | $Q_j,A_i,B_i,B_2$，各方案均完整保留 |
| ③ 原生五组参数总大小 | ① + 12,480 | **18,528** | 完整 CRS 基线 |
| ③（某方案） | ② + 12,480 | 各方案不同 | 只替换 Tau G1 表示，其余四组不变 |

主指标改为 **`tau_g1_representation_saving_pct`** $=1-\dfrac{\text{SCP1}}{6048}$。
例如 `odd_only`：

$$R = 1-\frac{3112}{6048} = 48.545\% \approx 48.55\%$$

旧口径保留为 `scp1_baseline_reduction_pct`（50.697%）供对照，但不再作为主指标。
另输出 `full_crs_bytes` 与 `full_crs_reduction_pct`（对 18,528 B）。
`all_powers_baseline` 出现 **负值**（SCP1 6,312 > 原生 6,048）是正常的：
自定义表示每点多 4 B 索引，比原生 Section 更大。

> **这些百分比一律不是「有效 CRS 压缩率」**：缺失点没有被恢复，下游
> Setup/Prove 无法使用。它们只描述「少存了多少点 / 表示缩小了多少」。

## 4. R4：重新运行的结果

正式实验数据集（每次运行不同，以下为本次记录）：

```
public_dataset_sha256 = 18bf4eb9900119f555482d37797b2af2d49238460e2cb2c2b8fe6910436522f5
eval 重算一致 = true
M2-A 在随机 SRS 上复跑：tau=1520 alpha=528 beta=32，共 2080 组 / 4160 次配对，全部 PASS
小标量有界搜索功能测试：隐藏标量 7，搜索 1..=64 → 找回 7（PASS）
```

### 表 A：恢复结果（`determ = saved + new_rec`）

| 方案 | 保存点 | 缺失点 | GT 目标 | 覆盖率 | 隐式 P0 | 新恢复 | 已确定 | 候选点 | 辅助关系 | 逐点比较 | 恢复成功 | 耗时 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
| 全部幂次（基线） | 63 | 0 | 0/0 | 100.0% | 0 | 0 | 63 | 0 | 0 | PASS | 是 | 2.80 |
| 仅奇数次幂 | 31 | 32 | 32/32 | 100.0% | 1 | 1 | 32 | 351 | 16 | PARTIAL (32/63, 32 equal) | **否** | 320.18 |
| 仅偶数次幂 | 32 | 31 | 31/31 | 100.0% | 0 | 0 | 32 | 352 | 16 | PARTIAL (32/63, 32 equal) | **否** | 320.19 |
| 前半部分（前 N/2） | 16 | 47 | 31/47 | 66.0% | 0 | 0 | 16 | 304 | 16 | PARTIAL (16/63, 16 equal) | **否** | 281.75 |
| 每隔 2 个点 | 32 | 31 | 31/31 | 100.0% | 0 | 0 | 32 | 352 | 16 | PARTIAL (32/63, 32 equal) | **否** | 321.32 |
| 每隔 4 个点 | 16 | 47 | 47/47 | 100.0% | 0 | 0 | 16 | 304 | 8 | PARTIAL (16/63, 16 equal) | **否** | 286.12 |
| 每隔 8 个点 | 8 | 55 | 55/55 | 100.0% | 0 | 0 | 8 | 242 | 4 | PARTIAL (8/63, 8 equal) | **否** | 235.93 |

> 「逐点比较」由独立 `eval` 进程完成：读 `recovered/*.bin`，与 oracle 中同索引点
> 逐点比较；`recovery_success` 由评估器独立判定（必须 63/63 全等），
> **不盲信** `recover` 进程的自报结果。
> 「新恢复」指原本缺失的索引中新确定的点数；`odd_only` 的 1 个点就是隐式 $P_0$。
> 「每隔 2 个点」与「仅偶数次幂」在本定义下是同一子集，数值相同是预期现象。

### 表 B：三种存储口径（字节）

| 方案 | ① 原生 Tau G1 Section | ② SCP1 表示 | ②/① 节省 | ② vs SCP1 基线 | ③ 五组参数总大小 | ③ vs 原生全 CRS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 全部幂次（基线） | 6048 | 6312 | -4.365% | 0.000% | 18792 | -1.425% |
| 仅奇数次幂 | 6048 | 3112 | 48.545% | 50.697% | 15592 | 15.846% |
| 仅偶数次幂 | 6048 | 3212 | 46.892% | 49.113% | 15692 | 15.307% |
| 前半部分（前 N/2） | 6048 | 1612 | 73.347% | 74.461% | 14092 | 23.942% |
| 每隔 2 个点 | 6048 | 3212 | 46.892% | 49.113% | 15692 | 15.307% |
| 每隔 4 个点 | 6048 | 1612 | 73.347% | 74.461% | 14092 | 23.942% |
| 每隔 8 个点 | 6048 | 812 | 86.574% | 87.136% | 13292 | 28.260% |

## 5. 失败定位到哪一步（结论未变）

所有非基线方案都停在 **$G_T \to G_1$ 求逆**：

```
pairing yields GT elements only; GT -> G1 inversion requires solving
the discrete log of tau^k, which is not a known public scalar
```

- $e(\cdot,Q_0):G_1\to G_T$ 在非退化配对下是单射，$t_k$ 在 $G_1$ 中存在**唯一**原像
  $P_k=[\tau^k]G_1$；问题不是「不存在」，而是「构造不出来」。
- 由 $t_k=e(G_1,G_2)^{\tau^k}$ 反推点等价于求 $\tau^k$ 的离散对数；$\tau$ 是未知陷门，
  $\tau^k$ 不是任何已知小标量。
- 群律只允许对已知指数做整数线性组合：由 $\{\tau^i:i\in S\}$ 只能得到
  $\sum_i c_i\tau^i$。对随机 $\tau$，$\tau^k$ 不落在这个整数张成空间里。
- $A_i=\alpha\tau^i G_1$、$B_i=\beta\tau^i G_1$ 引入的是 $\alpha,\beta$ 因子，
  也不能产生 $\tau^k G_1$。

**R2 之后公开信息能做到的程度（更精确了）**：

- 能**验证**任意候选点：$e(X,Q_0)\stackrel{?}{=}t_k$。
- 能**算出**更多 GT 目标：`odd_only` 已由 31/32 提升到 **32/32**；
  `first_half` 仍为 31/47（$k\ge N$ 时没有公开 $Q_k$，也无法分解）。
- 能**直接确定** $P_0$（公开常量），但它只是 63 个点中的 1 个。
- **仍不能构造**其余缺失的 $G_1$ 点。$G_T$ 元素与 $G_1$ 点是两种对象。

## 6. 结论边界（必须明确）

- 对导师的两个设想，本轮答案不变，且前提更严格：
  **在「不知道陷门、只掌握公开 CRS 子集」的前提下，奇偶次幂、前半部分、
  间隔采样都无法恢复出缺失的 $G_1$ 群元素。** 递推 $P_{i+1}=[\tau]P_i$ 成立，
  但 $[\tau]$ 不可公开计算，这正是断点。
- R1 收紧后，这个结论不再受「种子公开、攻击者可重建陷门」的质疑：
  正式实验的陷门从未持久化，恢复进程也拿不到完整数组。
- 结论只否定**本轮实际实现的恢复方法**（整数线性组合、已知标量、配对 GT 目标、
  有界求逆）。**不宣称从数学上证明所有代数压缩都不可能**；改变参数表示、
  更换承诺方案、或直接支持 MSM 而不恢复原点，都不在否定范围内。
- 阳性对照只说明**小标量有界搜索功能测试通过**（`control_known_scalar` 找回 $[7]G_1$），
  **不证明**任何未知幂次恢复算法的普遍正确性。
- 本轮没有设计新算法、没有做流式 MSM、没有跑 Power 21，也未启动 M3。

## 7. 复现

```bash
cargo test --workspace                 # 35 个单元测试（含 R1/R2/R3 新增用例）
bash scripts/run_m2b.sh                # gen / recover / eval 三个独立进程
                                       # 写 results/raw/m2_results.json
```

也可分阶段单独执行：

```bash
cargo run --release -p srs-relations --bin srs-relations -- gen
cargo run --release -p srs-relations --bin recover
cargo run --release -p srs-relations --bin srs-relations -- eval
```

每次 `gen` 都会产生新的 OS 熵，因此 `public_dataset_sha256` 会变化；
引用某次实验时以该哈希和 `results/raw/m2_results.json` 为准，不要用种子复现。
