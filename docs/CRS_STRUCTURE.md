# CRS_STRUCTURE — Phase 1 Powers of Tau 文件结构审计

> 范围：snarkjs 0.7.6 生成的 **Phase 1** `.ptau`（未执行 `prepare phase2`）。
> 交付里程碑：M1-B / M1-C / M1-D / M1-E。
> 所有数值由 `ptau-audit` 从真实文件读取，非硬编码；机器可读结果见
> `results/raw/audit-pot{10,12,14}-{0000,0001}.json`（该目录不入库）。

## 1. 容器格式（源码依据）

`@iden3/binfileutils/src/binfileutils.js`：

| 结构 | 字节 | 源码 |
| --- | --- | --- |
| 通用文件头 | 4 B magic `ptau` + 4 B version(u32 LE) + 4 B nSections(u32 LE) = **12 B** | `:41-46` `createBinFile` |
| 每个 Section 头 | 4 B id(u32 LE) + 8 B size(u64 LE) = **12 B** | `:23-32` `readBinFile`、`:51-68` `startWriteSection` / `endWriteSection` |

读取端 `fd.pos += hl` 顺序扫描，Section 按出现顺序存放；**不假设 ID 连续或有序**。
`powersoftau_new.js:75` 与 `powersoftau_contribute.js:69` 均为
`createBinFile(..., "ptau", 1, 7)`（version 1，7 个 Section）。

### Section 1 Header（60 B）

`snarkjs/src/powersoftau_utils.js:26-50` / `:52-70`。

| 字段 | 类型 | 字节 |
| --- | --- | --- |
| `n8` | u32 LE | 4 |
| Base field modulus `q` | Bytes（**小端**） | 48 |
| `power` | u32 LE | 4 |
| `ceremonyPower` | u32 LE | 4 |

曲线识别必须**同时**满足 `n8 = 48` 且模数（反转字节序后）等于 BLS12-381
`q = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab`。
`power` 与 `ceremony_power` 分别保留，不合并；`N = 2^power` 用 `checked_shl` 计算，
并对 `576N+96` 做溢出检查。

### Section 2–6：五类群元素

| Section | 参数 | 元素数量 | 单点 | 字节数 |
| --- | --- | --- | --- | --- |
| 2 | $P_i=[\tau^i]G_1$ | $2N-1$ | 96 B | $(2N-1)\times96$ |
| 3 | $Q_i=[\tau^i]G_2$ | $N$ | 192 B | $N\times192$ |
| 4 | $A_i=[\alpha\tau^i]G_1$ | $N$ | 96 B | $N\times96$ |
| 5 | $B_i=[\beta\tau^i]G_1$ | $N$ | 96 B | $N\times96$ |
| 6 | $B_2=[\beta]G_2$ | 1 | 192 B | 192 |

$$S_{\mathrm{points}} = 576N+96,\qquad C_{\mathrm{points}} = 5N$$

**Section 7 不计入群元素总数。** 本阶段只做字节级长度核对，不反序列化 LEM / Montgomery 编码的点。

### Section 7：Contribution 记录

`powersoftau_utils.js:163-224`（`readContribution`）、`:244-309`（`writeContribution`）。

单条记录固定部分 **2,112 B**（含末尾 4 B 参数长度字段）：

| 字段 | 字节 |
| --- | --- |
| Tau G1 / Tau G2 / Alpha G1 / Beta G1 / Beta G2 | 96 / 192 / 96 / 96 / 192 = 672 |
| Public Key（6×G1 + 3×G2） | 1,152 |
| Partial Hash | 216 |
| Next Challenge | 64 |
| Type (u32) | 4 |
| Parameters Length (u32) | 4 |
| **合计** | **2,112** |

参数区为 TLV，类型必须**严格递增**（源码 `:188`）：

| Type | 内容 | 布局 |
| --- | --- | --- |
| 1 | Name | `type(1) + len(1) + UTF-8 bytes` |
| 2 | Beacon Iteration Exponent | `type(1) + value(1)`（**无长度字段**） |
| 3 | Beacon Hash | `type(1) + len(1) + bytes` |

Section 7 = 4 B `nContributions` + Σ(2,112 + 参数区长度)。
本项目三个贡献名称分别为 21 / 17 / 17 B，因此参数区为 23 / 19 / 19 B，
单条记录为 2,135 / 2,131 / 2,131 B，Section 7 为 2,139 / 2,135 / 2,135 B。

## 2. 口径：四种「大小」不能混用

| 口径 | 定义 | N=2^10 | N=2^21 |
| --- | --- | --- | --- |
| ① 群元素有效数据 | $S_{\mathrm{points}}=576N+96$ | 589,920 B | 1,207,959,648 B |
| ② Section payload 总和 | ① + 60(Section 1) + 4(Section 7 计数器) | 589,984 B | 1,207,959,712 B |
| ③ 初始 `.ptau` 文件大小 | ② + 96 = ① + **160** | 590,080 B | **1,207,959,808 B** |
| ④ 含贡献记录的文件 | ③ + Σ单条贡献记录 | 592,215 B | ③ + Σ记录 |

- `96 = 12 + 7×12`（通用文件头 + 7 个 Section 头）；`160 = 96 + 64`。
- 最初表格里的 `1,207,959,712 B = S_points + 64` 恰好是口径 **②**；
  其中 64 B 并非落盘的 First Challenge Hash，而是 Section 1 参数头 60 B + Section 7 计数器 4 B。
  `powersoftau_new.js:134-136` 显示 First Challenge Hash 在写完文件后才由群元素计算，不落盘。
- N=2^21 时各 Section 理论长度：S2 = 402,653,088 B，S3 = 402,653,184 B，
  S4 = S5 = 201,326,592 B，S6 = 192 B。
- 有贡献记录的文件必须额外统计 Section 7 的完整记录，**不能**只报 ③。

## 3. 实测结果（6 份文件，全部 FULL AUDIT PASS）

| 文件 | Power | N | 文件大小 (B) | SHA-256 | 贡献数 | Section 7 (B) |
| --- | --- | --- | --- | --- | --- | --- |
| `pot10_0000.ptau` | 10 | 1,024 | 590,080 | `9096c1886d3d094777d572a991c4523991ce3491bd6affc503a045e61a3902dc` | 0 | 4 |
| `pot10_0001.ptau` | 10 | 1,024 | 592,215 | `86b13f3cb014f02e2157b5c659baa29e943d4d75f7f2018c70db7b26b9345f5c` | 1 | 2,139 |
| `pot12_0000.ptau` | 12 | 4,096 | 2,359,552 | `0280084087d88e6b1b61250431eab40ef641d68619f36f74d6d90108540b0403` | 0 | 4 |
| `pot12_0001.ptau` | 12 | 4,096 | 2,361,683 | `eda9439b2a96c1204bad169584669304488b7102faf51065e81478bd28248deb` | 1 | 2,135 |
| `pot14_0000.ptau` | 14 | 16,384 | 9,437,440 | `07c098825f787f7c45e503034ba2cc5bc22a3a870a17a9690dcac08288800135` | 0 | 4 |
| `pot14_0001.ptau` | 14 | 16,384 | 9,439,571 | `5c801f245a2c89e93638db54f9ee4a0c13930f4f964ec24c6f10e3f1bed7db63` | 1 | 2,135 |

### Section 实际长度 / 理论长度（三份 `0000` 初始文件）

| Section | 内容 | Power 10 | Power 12 | Power 14 |
| --- | --- | --- | --- | --- |
| 1 | Header | 60 / 60 | 60 / 60 | 60 / 60 |
| 2 | Tau G1 | 196,512 / 196,512 | 786,336 / 786,336 | 3,145,632 / 3,145,632 |
| 3 | Tau G2 | 196,608 / 196,608 | 786,432 / 786,432 | 3,145,728 / 3,145,728 |
| 4 | Alpha Tau G1 | 98,304 / 98,304 | 393,216 / 393,216 | 1,572,864 / 1,572,864 |
| 5 | Beta Tau G1 | 98,304 / 98,304 | 393,216 / 393,216 | 1,572,864 / 1,572,864 |
| 6 | Beta G2 | 192 / 192 | 192 / 192 | 192 / 192 |
| 7 | Contributions | 4 / 4 | 4 / 4 | 4 / 4 |

`0001` 文件前六个 Section 与对应 `0000` 完全相同，仅 Section 7 变化。

### 群元素统计

| Power | N | 总群元素数 `5N` | 群元素字节 `576N+96` |
| --- | --- | --- | --- |
| 10 | 1,024 | 5,120 | 589,920 B |
| 12 | 4,096 | 20,480 | 2,359,392 B |
| 14 | 16,384 | 81,920 | 9,437,280 B |

### 独立交叉验证

- 程序内实现的是纯标准库分块 SHA-256（1 MiB 缓冲），已用空串、`abc`、1,000,000×`a`
  三个标准向量及 `sha256sum` 对六份文件交叉验证一致；**不将 1.2 GB 文件整体读入内存**。
- 每个 Section 的 SHA-256 也写入 JSON（对 payload 字节范围做分块哈希）。
- 结构扫描结果与 Node 直接读取原始字节的独立实现一致（见 `EXPERIMENT_LOG.md` M1-A 节）。

## 4. 完整性检查与异常测试

审计器检查：magic / version / section count；每个 Section 的越界与 `checked_add` 溢出；
文件尾部残留；Section ID 重复；必需 Section 1–7 缺失；模数匹配；Section 2–6 长度与理论值；
TLV 顺序、完整性与 Section 7 精确消耗。
**Phase 2 的 Section 12–15 记录为允许的额外 Section，不判为错误。**

四个异常样本均由 `pot10_0001.ptau` 复制后修改，原件未改动，样本落
`results/raw/negative/`（已被 `.gitignore` 排除）：

| 测试 | 修改 | 结果 | 拒绝原因 |
| --- | --- | --- | --- |
| T1 | magic `ptau` → `xtau` | **PASS（拒绝）** | `Invalid magic` |
| T2 | 截断最后 1 B | **PASS（拒绝）** | `Section 7 exceeds file boundary` |
| T3 | Section 2 长度 → `u64::MAX` | **PASS（拒绝）** | `Section offset overflow` |
| T4 | 尾部追加 1 B | **PASS（拒绝）** | `Trailing or unparsed bytes` |

`cargo test --workspace` 另含 7 个不依赖 fixture 的合成容器异常测试，可在无 `.ptau` 的克隆上复跑。

## 5. 复现

```bash
cargo test --workspace
cargo run -p ptau-audit -- data/fixtures/pot10_0001.ptau \
    --json results/raw/audit-pot10-0001.json --negative-tests
# 其余五份同理
```

结论：1.2 GB 的组成已由程序逐字节审计，并与源码推导、系统 `sha256sum` 三方一致。
本结论只覆盖 Phase 1 初始 / 单次贡献文件；Phase 2 准备后的 Sections 12–15 另行统计。
