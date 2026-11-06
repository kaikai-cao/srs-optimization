# EXPERIMENT_LOG

按里程碑追加记录：环境、命令、输入文件哈希与原始观察值。
**只写实测值**；预期结论、待验证假设一律标注为「待测」，不写成结果。

---

## M0 — 工程初始化与 Power 10 测试 CRS（2026-11-06）

### 执行环境（实测）

| 项 | 值 |
| --- | --- |
| 执行 shell | Windows 11 + Git Bash，工作目录 `D:\Research\srs-optimization` |
| WSL2 | Ubuntu，内核 `6.18.58.1-microsoft-standard-WSL2`；**本次未在 WSL 内执行** |
| rustc | `1.98.1 (48a229cea 2026-09-01)` |
| cargo | `1.98.1 (797e8a9bc 2026-08-05)` |
| node | `v22.22.2` |
| npm | `10.9.7` |
| git | `2.55.0.windows.3` |
| snarkjs | `0.7.6`（devDependency，锁定于 `package-lock.json`） |

**环境偏差（必须记录）**：实验计划第十一部分指定 WSL2。实测该 WSL2 Ubuntu 中
`rustc` / `cargo` / `node` 均不存在（`npm` 是 Windows 侧的 shim），
且 `curl https://registry.npmjs.org` 12 秒超时、无 `http_proxy` 等代理变量，
无法在 WSL 内安装依赖。因此 M0 在 Windows 原生工具链上完成。
仓库位于共享 D: 盘，WSL 侧 `/mnt/d/Research/srs-optimization` 可完整访问同一份文件。

**待办（进入 M4/M6 前必须解决）**：性能实验需要 `/usr/bin/time -v` 的
Maximum resident set size 与冷/热缓存分离，需在 WSL2 内安装 Rust + Node 工具链，
或确定 Windows 等效测量方案并重新固定全部版本。届时环境版本需重新记录，不能直接沿用本表。

### Git 基线

- 远端 `https://github.com/kaikai-cao/srs-optimization.git` 已存在，`main` 分支为
  Initial commit `a860b0e55d0bc73a4c2b9a5063656c90bafab7c8`（仅含 `README.md`）。
- 采用 `git clone <url> .` 初始化，保留远端历史；未强推、未重复添加 remote。
- `.gitignore` 已用 `git check-ignore -v` 实测：两个 `.ptau` 均被 `*.ptau` 规则命中。

### 执行命令

```bash
npm init -y
npm install --save-dev snarkjs
npm ls snarkjs

npx snarkjs powersoftau new bls12-381 10 data/fixtures/pot10_0000.ptau -v
npx snarkjs powersoftau contribute \
    data/fixtures/pot10_0000.ptau data/fixtures/pot10_0001.ptau \
    --name="SRS Optimization Test" \
    -e="srs-optimization-M0-power10-test-entropy-2026-11-06-NOT-FOR-PRODUCTION" -v
npx snarkjs powersoftau verify data/fixtures/pot10_0001.ptau -v
```

说明：`--entropy/-e` 为 snarkjs 0.7.6 的非交互式熵参数（`src/clprocessor.js` /
`src/misc.js` 已核实）。`bls12-381` 经 `getCurveFromName` 归一化后等价于 `BLS12381`。
**未执行 `powersoftau prepare phase2`**，当前文件不含 Sections 12–15。

### Power 10 生成与验证结果

| 项 | 结果 |
| --- | --- |
| `powersoftau new` | 成功；First Contribution Hash `96f31268...853a7e9` |
| `powersoftau contribute` | 成功；Contribution #1 = `SRS Optimization Test`，Response Hash `c2366b2c...e9626a7` |
| `powersoftau verify` | **PASS**，退出码 0，输出 `Powers of Tau Ok!`；Next Challenge `3b8c9cf5...563d541c` |
| verify 附带警告 | 文件不含 phase2 预计算值（预期行为，本阶段刻意不执行 `prepare phase2`） |

### 文件大小与 SHA-256（实测）

| 文件 | 大小（字节） | `ls -lh` | SHA-256 |
| --- | --- | --- | --- |
| `data/fixtures/pot10_0000.ptau` | 590,080 | 577K | `9096c1886d3d094777d572a991c4523991ce3491bd6affc503a045e61a3902dc` |
| `data/fixtures/pot10_0001.ptau` | 592,215 | 579K | `86b13f3cb014f02e2157b5c659baa29e943d4d75f7f2018c70db7b26b9345f5c` |

理论群元素字节数（$N=2^{10}=1024$，未压缩）：

```
S2 = (2N-1)*96  = 196,512
S3 = N*192      = 196,608
S4 = N*96       =  98,304
S5 = N*96       =  98,304
S6 = 192        =     192
S_points        = 589,920   (= 576N + 96，公式核对一致)
S_points + 64B  = 589,984
```

**留给 M1 的原始观察（不作结论）**：

- `pot10_0000.ptau` 比 `S_points + 64B` 多 96 B；比纯 `S_points` 多 160 B。
- `pot10_0001.ptau` 比 `pot10_0000.ptau` 多 2,135 B（贡献后新增的 Section 7 记录规模待审计）。
- 这些差额正是「1.2 GB 究竟是 Accumulator 还是整个 `.ptau` 容器」的小规模对照样本，
  需由 `ptau-audit` 逐 Section 解析后解释，本阶段不推断其构成。

### 复现性注意

`src/misc.js:getRandomRng(entropy)` 在写入熵字符串的同时还混合了
`getRandomBytes(64)` 的操作系统随机数。因此**固定 `-e` 也不能复现同一个 `.ptau` 文件**；
后续实验必须以文件 SHA-256 作为输入基准，而不是以熵字符串作为基准。
两个 fixture 均不入库（`.gitignore` 命中）；其哈希记录在此，用于引用。

### 已知风险

- `npm audit` 报告 3 个 high：`underscore`（`_.flatten` / `_.isEqual` 无限递归 DoS）
  经 `jsonpath` → `bfj` 传递。仅影响测试用 JS 工具链，不进入 Rust 实现；
  当前未执行 `npm audit fix`，以免在未冻结依赖的情况下改变 `package-lock.json`。
- 三个 crate 目前是 `cargo new` 空壳，`Cargo.lock` 由 `cargo generate-lockfile --offline`
  生成（零外部依赖）；引入 arkworks 0.6.0 等依赖时须重新锁定并记录版本。

---

## M0 修订（M1-A 实施前）：容器固定开销与 1.2 GB 口径

> 本节为**修订条目**，修正上文「`S_points + 64B = 589,984`」与「容器超额 96 B」的口径。
> 上文原始实测记录保留不删，以本节为准。以下结论已在本机安装的
> snarkjs 0.7.6 / `@iden3/binfileutils` 源码逐条核对（非外部推断）。

### 源码依据（本机 `node_modules/` 实测行号）

| 结论 | 源码位置 |
| --- | --- |
| 通用头 = 4 B magic `ptau` + 4 B version(LE u32) + 4 B nSections(LE u32) = **12 B** | `@iden3/binfileutils/src/binfileutils.js:41-46` (`createBinFile`) |
| 每个 Section 头 = 4 B id(LE u32) + 8 B size(LE u64) = **12 B**；读取端顺序扫描 `fd.pos += hl` | 同文件 `:23-32` (`readBinFile`)、`:51-58` (`startWriteSection`)、`:60-68` (`endWriteSection`) |
| `createBinFile(..., "ptau", 1, 7)` → version 1、7 个 Section | `snarkjs/src/powersoftau_new.js:75`；`powersoftau_contribute.js:69` 同为 7 |
| Section 1 payload = 4 (n8) + 48 (q, BLS12-381 `F1.n8`) + 4 (power) + 4 (ceremonyPower) = **60 B** | `snarkjs/src/powersoftau_utils.js:26-50` (`writePTauHeader`)、`:52-70` (`readPTauHeader`) |
| Section 7 起始 **4 B** = `nContributions`（初始文件写 0） | `powersoftau_new.js:130-132`；`powersoftau_utils.js:226-241, 294-304` |
| First Challenge Hash 在文件写完**之后**由群元素计算，**不落盘** | `powersoftau_new.js:134-136` (`calculateFirstChallengeHash`) |

**固定容器开销** $= 12 + 7\times12 + 60 + 4 = 160$ B。
无贡献记录的初始 `.ptau`：

$$S_{\mathrm{file}} = S_{\mathrm{points}} + 160 = 589{,}920 + 160 = \boxed{590{,}080\ \mathrm{B}}$$

与 M0 实测 `pot10_0000.ptau` 完全一致。

### 单次 Contribution 记录 = 2,135 B

| 内容 | 字节数 | 依据 |
| --- | --- | --- |
| 五个贡献群元素（3×G1 + 2×G2 = 3×96 + 2×192） | 672 | `powersoftau_utils.js:244-252, 282-290` |
| 九个公开密钥群元素（6×G1 + 3×G2 = 6×96 + 3×192） | 1,152 | `powersoftau_utils.js:157-160`（`F1.n8*2*6 + F2.n8*2*3`） |
| Partial Hash | 216 | `snarkjs/src/misc.js:111-113`（`new Uint8Array(216)`） |
| Next Challenge | 64 | blake2b `dkLen = 64` |
| Type (u32) | 4 | `powersoftau_utils.js:256` |
| Params 长度 (u32) | 4 | `powersoftau_utils.js:275-279` |
| Name 参数（1 B 类型 + 1 B 长度 + 21 B UTF-8） | 23 | `powersoftau_utils.js:258-264`；`SRS Optimization Test` = 21 B |
| **合计** | **2,135** | |

`592{,}215 - 590{,}080 = 2{,}135` B ✓；有贡献文件的 Section 7 payload = 4 + 2,135 = **2,139 B**。

### 1.2 GB 的口径必须分开报告

| 口径 | N = 2^10 = 1,024 | N = 2^21 = 2,097,152 |
| --- | --- | --- |
| ① 五类群元素有效数据 $S_{\mathrm{points}}=576N+96$ | 589,920 B | 1,207,959,648 B |
| ② ① + 64 B 前序贡献哈希（**引用口径**，由群元素计算，不落盘） | 589,984 B | 1,207,959,712 B |
| ③ 初始 `.ptau` 实际文件大小 = ① + 160 | 590,080 B | **1,207,959,808 B** |
| ④ 含 1 次贡献的文件 = ③ + Σ(单条贡献记录) | 592,215 B | 需按实际 Section 7 记录逐条累加 |

- 最初的 1,207,959,712 B 对应口径 ②，**不是错误**，但它不是 `.ptau` 容器文件大小。
- 上文「容器超额 96 B」只是 ③−② 的差值；正确表述是「容器固定开销 160 B」，
  其中 64 B 从未作为独立字段写入文件。
- 后续 `CRS_STRUCTURE.md` / `audit.json` 必须分别报告 ①②③④，
  不得合并成一个「CRS 大小」；含贡献记录的文件还要单列 Section 7 完整记录（M1-C 负责）。
- 结论口径：群元素有效数据 / Accumulator 状态引用 / 容器实际文件大小，三者不可混用。

---

## M1-A — 二进制容器扫描器（2026-11-06）

实现：`crates/ptau-audit/src/parser.rs` + `main.rs`，**仅 Rust 标准库、零 Cargo 依赖**，
未安装 arkworks，未改动另外两个 crate，未生成 Power 21 数据。
`cargo check -p ptau-audit` 通过（无 warning）；两次 `cargo run` 退出码均为 0。

### 实测 Section 表（两份文件，前六个 Section 完全一致）

| Index | ID | Header Offset | Payload Offset | Payload Length (`0000` / `0001`) |
| --- | --- | --- | --- | --- |
| 1 | 1 | 12 | 24 | 60 / 60 |
| 2 | 2 | 84 | 96 | 196,512 / 196,512 |
| 3 | 3 | 196,608 | 196,620 | 196,608 / 196,608 |
| 4 | 4 | 393,228 | 393,240 | 98,304 / 98,304 |
| 5 | 5 | 491,544 | 491,556 | 98,304 / 98,304 |
| 6 | 6 | 589,860 | 589,872 | 192 / 192 |
| 7 | 7 | 590,064 | 590,076 | **4 / 2,139** |

| 文件 | File size | Declared sections | Version | 末尾位置 | Audit result |
| --- | --- | --- | --- | --- | --- |
| `pot10_0000.ptau` | 590,080 | 7 | 1 | 590,080 | `CONTAINER SCAN PASS` |
| `pot10_0001.ptau` | 592,215 | 7 | 1 | 592,215 | `CONTAINER SCAN PASS` |

与预期值逐项一致；`header_offset[i+1] = payload_offset[i] + payload_len[i]` 全链自洽，
最后一个 Section 的结束位置等于文件总大小（无重叠、无空洞、无尾部残留）。

### 独立交叉核对（Node 直接读原始字节，不复用 Rust 实现）

| 文件 | Σ payload | `file_size − Σ payload` | `ends_at` |
| --- | --- | --- | --- |
| `pot10_0000.ptau` | 589,984 | 96 | 590,080 |
| `pot10_0001.ptau` | 592,119 | 96 | 592,215 |

**补记（对 1.2 GB 口径的进一步澄清）**：

- `Σ payload = S_points + 60 + 4 = S_points + 64`。
  也就是说，最初的 `1,207,959,712 B`（N=2^21）**恰好等于初始 `.ptau` 的 Section payload 总和**；
  其中那 64 B 并非落盘的 First Challenge Hash，而是 Section 1 参数头 60 B + Section 7 计数器 4 B。
- `file_size − Σ payload = 96 = 12 + 7×12`（通用文件头 + 7 个 Section 头）。
- 故固定开销 `160 = 96 + 64`，两种拆分口径互不矛盾：
  **96 B 是容器结构头，64 B 是 Section 1/7 的非群元素 payload**。
- 这进一步说明「1.2 GB」必须注明是「有效群元素」「Section payload 总和」还是「容器文件大小」。

M1-A 验收状态：**PASS（用户已确认冻结）**。已单独提交并推送：`0fafedf feat(ptau-audit): scan ptau container sections`。

---

## M1-B ～ M1-E — 完整 CRS 结构审计（2026-11-06）

新增 `header.rs` / `sections.rs` / `contributions.rs` / `report.rs`，重写 `main.rs`。
`ptau-audit` 仍为**零 Cargo 依赖**（SHA-256 与 JSON 均为标准库手写实现）。
完整结构说明见 `docs/CRS_STRUCTURE.md`，机器可读结果见 `results/raw/audit-*.json`（不入库）。

### 实现要点

- Section 1：同时校验 `n8=48` 与 48 B 小端模数（反转后比对 BLS12-381 q）；
  `power` / `ceremony_power` 分开保留；`N=2^power` 用 `checked_shl`，`576N+96` 做溢出检查；
  校验 Header 恰好读完 60 B。
- Section 2–6：由 N 推导 `2N-1, N, N, N, 1` 与 `576N+96`，**逐 Section 比对实际长度**，
  不只是打印理论值；检查 ID 重复 / 必需 Section 缺失；额外 ID（Phase 2 的 12–15）记录但不报错。
- Section 7：4 B 计数器 + 每条 2,112 B 固定部分 + TLV 参数区。
  实测 TLV 规则（源码 `:186-206`）：类型必须严格递增；Type 2 是 1 B 值而非长度字段；
  参数区必须恰好消耗；记录必须恰好消耗整个 Section 7。
- `report.rs`：纯标准库 SHA-256，1 MiB 分块；文件哈希、每个 Section payload 哈希、
  JSON 报告、T1–T4 异常测试（复制后修改，原件不动）。
  SHA-256 用 3 个标准向量 + 系统 `sha256sum` 交叉验证通过。

### 实测（6 份文件全部 `FULL AUDIT PASS`）

| 文件 | Power / N | 文件大小 (B) | 贡献数 | Section 7 (B) | 群元素数 | 群元素字节 |
| --- | --- | --- | --- | --- | --- | --- |
| `pot10_0000` | 10 / 1,024 | 590,080 | 0 | 4 | 5,120 | 589,920 |
| `pot10_0001` | 10 / 1,024 | 592,215 | 1 | 2,139 | 5,120 | 589,920 |
| `pot12_0000` | 12 / 4,096 | 2,359,552 | 0 | 4 | 20,480 | 2,359,392 |
| `pot12_0001` | 12 / 4,096 | 2,361,683 | 1 | 2,135 | 20,480 | 2,359,392 |
| `pot14_0000` | 14 / 16,384 | 9,437,440 | 0 | 4 | 81,920 | 9,437,280 |
| `pot14_0001` | 14 / 16,384 | 9,439,571 | 1 | 2,135 | 81,920 | 9,437,280 |

`pot10_0001` 的 Contribution #1：`Type: 0`、`Name: SRS Optimization Test`、
`TLV types: [1]`、`Record Bytes: 2,135`、`Section 7: 2,139` — 与预期完全一致。
Power 12/14 的名称为 17 B，故单条记录 2,131 B、Section 7 = 2,135 B（动态解析生效）。

### SHA-256（六份文件，均由程序计算并与 `sha256sum` 一致）

```
9096c1886d3d094777d572a991c4523991ce3491bd6affc503a045e61a3902dc  pot10_0000.ptau
86b13f3cb014f02e2157b5c659baa29e943d4d75f7f2018c70db7b26b9345f5c  pot10_0001.ptau
0280084087d88e6b1b61250431eab40ef641d68619f36f74d6d90108540b0403  pot12_0000.ptau
eda9439b2a96c1204bad169584669304488b7102faf51065e81478bd28248deb  pot12_0001.ptau
07c098825f787f7c45e503034ba2cc5bc22a3a870a17a9690dcac08288800135  pot14_0000.ptau
5c801f245a2c89e93638db54f9ee4a0c13930f4f964ec24c6f10e3f1bed7db63  pot14_0001.ptau
```

### snarkjs 验证（新增四份）

- `powersoftau new bls12-381 12/14` + `contribute --name="SRS Power 12/14 Test" -e="srs-power12/14-test"` 均成功。
- `npx snarkjs powersoftau verify pot12_0001.ptau -v` → `Powers of Tau Ok!`，退出码 0。
- `npx snarkjs powersoftau verify pot14_0001.ptau -v` → `Powers of Tau Ok!`，退出码 0。
- 均给出「不含 phase2 预计算值」警告（预期，本轮不执行 `prepare phase2`）。
- 固定 `-e` 不可复现同一文件（M0 已记录），以 SHA-256 为输入基准。
- **统一复跑六份文件**：三份 `_0001`（各 1 条贡献）verify 均 `Powers of Tau Ok!`、退出码 0；
  三份 `_0000`（0 条贡献）verify 退出码 1，snarkjs 明确报
  `This file has no contribution! It cannot be used in production`。
  这是 snarkjs 对「尚未有贡献的初始累加器」的预期拒绝，**不是文件损坏**；
  实验计划本来也只对 `_0001` 执行 verify。六份 `_0000` 由我们自己的
  `ptau-audit` 完成结构审计，未依赖 snarkjs verify。

### 异常测试（4/4 拒绝）

| 测试 | 修改 | 拒绝原因 |
| --- | --- | --- |
| T1 | magic → `xtau` | `Invalid magic` |
| T2 | 截断最后 1 B | `Section 7 exceeds file boundary` |
| T3 | Section 2 长度 → `u64::MAX` | `Section offset overflow` |
| T4 | 尾部追加 1 B | `Trailing or unparsed bytes` |

### 测试与已知噪声

- `cargo test --workspace`（M1 阶段）：`ptau-audit` 12 个单元测试 + 7 个合成容器异常测试全部通过，
  另两个 crate 各 0 个测试。
- Windows 上 incremental 编译偶发 `error deleting lock file ... 拒绝访问 (os error 5)` 警告，
  不影响编译结果与退出码；属于文件锁噪声，不是代码问题。
- M1 单独提交 `3aa2503 feat(ptau-audit): full CRS structure audit with SHA-256 and negative tests`；
  当次 `git push` 先后遇到 SSL EOF 与代理 502，本地提交保留，稍后随最终批次重试推送。

---

## M2-A / M2-B — 代数关系与压缩恢复实验（2026-11-06）

`srs-relations` 引入 arkworks **0.6.0**（`ark-bls12-381` / `ark-ec` / `ark-ff` / `ark-std` / `ark-serialize`），
`cargo check -p srs-relations` 通过；`Cargo.lock` 已随之锁定。
未改动 `srs-stream`，未执行 Power 21，未设计 M3 新算法。
详细论证见 `docs/ALGEBRAIC_RELATIONS.md` 与 `docs/COMPRESSION_EXPERIMENTS.md`。

### M2-A（`cargo run --release -p srs-relations`）

固定种子 `StdRng` 生成 $N=32$ 测试 SRS，秘密标量在生成器内生成并 `drop`，
不进入任何公开参数文件或恢复接口。遍历全部合法索引组合：

```
Tau pairing relations: PASS (1520 groups)
Alpha pairing relations: PASS (528 groups)
Beta pairing relations: PASS (32 groups)
Total relation checks: 2080 (4160 pairings)
```

仅证明结构一致性，**不是**完整 Powers-of-Tau 贡献验证。

### M2-B（七种参数子集）

| 方案 | 保存点 | 文件 (B) | 减少 | 缺失 | GT 目标 | 候选 | 恢复 | 成功 | 耗时 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 全部幂次（基线） | 63 | 6,312 | 0.00% | 0 | 0 | 0 | 63 | 是 | 6.97 |
| 仅奇数次幂 | 31 | 3,112 | 50.70% | 32 | 31 | 351 | 0 | 否 | 313.83 |
| 仅偶数次幂 | 32 | 3,212 | 49.11% | 31 | 31 | 352 | 0 | 否 | 314.31 |
| 前半部分（前 N/2） | 16 | 1,612 | 74.46% | 47 | 31 | 304 | 0 | 否 | 282.35 |
| 每隔 2 个点 | 32 | 3,212 | 49.11% | 31 | 31 | 352 | 0 | 否 | 312.37 |
| 每隔 4 个点 | 16 | 1,612 | 74.46% | 47 | 47 | 304 | 0 | 否 | 284.57 |
| 每隔 8 个点 | 8 | 812 | 87.14% | 55 | 55 | 242 | 0 | 否 | 229.25 |

- 阳性对照：隐藏指数 7、有界搜索 1..=64 → 成功找回标量 7，证明配对/求逆实现可用。
- 所有非基线方案失败于同一环节：**GT → G1 求逆**。
  配对只给出 $t_k=e(G_1,G_2)^{\tau^k}\in G_T$，唯一原像 $P_k\in G_1$ 存在，
  但构造它需要未知指数 $\tau^k$；群律只能做已知幂次的整数线性组合。
- 公开信息可以**验证**候选点、可以算 GT 目标（但并非全覆盖：奇数方案 31/32、
  前半方案 31/47），**不能构造**缺失的 $G_1$ 点。
- 结论只否定本轮实际测试的恢复方法；**不宣称证明所有代数压缩不可能**。
- 文件大小仅针对 Tau G1 子序列（arkworks canonical 96 B/点），不是整个 CRS 的压缩率。

### 产物

`results/raw/m2_results.json`、`results/raw/compression/*.bin`（均被 `.gitignore` 排除，
未提交）。`cargo test -p srs-relations` 9 个单元测试全部通过。
