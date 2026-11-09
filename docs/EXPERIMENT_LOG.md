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

> **以下为 R1–R4 修订前的原始记录，保留不删。固定种子、旧 `storage_reduction_pct`
> 口径与旧表数值均以「R1–R4 修订」节及 `COMPRESSION_EXPERIMENTS.md` 新版为准。**

---

## R1–R4 修订批次 — M2 实验前提与统计口径（2026-11-06）

用户远端复核 `6594cb7` 后的验收结论：**M1 通过并冻结 / M2-A 通过并冻结 /
M2-B 需要修订**。核心问题是 `powers.rs` 的 `pub const SRS_SEED` 把生成
$\tau,\alpha,\beta$ 的固定种子公开在 GitHub 上，任何人都能重建陷门并直接算出
缺失点，因此旧结论只能证明「恢复函数被限制为只用 CompressedParameters 时，
当前候选构造策略失败」，不能证明「不知道陷门的攻击者无法恢复」。
另需修正 $P_0/Q_0$ 公开生成元处理与存储统计口径。

### 新增依赖（已锁定于 `Cargo.lock`）

| crate | 版本 | 用途 |
| --- | --- | --- |
| `getrandom` | 0.2.17 | OS 熵生成正式实验种子（ark-std 的 rand 是 `default-features=false`，无 `OsRng`） |
| `serde_json` | 1.0.154 | manifest / summary / relations / m2_results 的 JSON 读写 |
| `serde` / `serde_core` / `serde_derive` | 1.0.229 | serde_json 传递依赖 |
| `itoa` 1.0.18 / `memchr` 2.8.3 / `zmij` 1.0.23 / `wasi` 0.11.1 / `libc` 0.2.191 | — | 传递依赖 |

SHA-256 未引入新依赖：`src/sha256.rs` 为纯标准库实现（1 MiB 分块流式），
带 3 个标准向量 + 分块边界单测，与 `ptau-audit::report` 的 K 常量逐行一致。

### 源码变更

| 文件 | 变更 |
| --- | --- |
| `src/powers.rs` | 删除 `pub const SRS_SEED`；新增 `generate_from_os_entropy()`；固定种子改名 `TEST_SEED` 并移入 `#[cfg(test)]`；新增 OS 熵路径单测 |
| `src/lib.rs`（新） | 库入口，暴露 `powers/pairing/public_io/compression_tests/sha256`；写明三进程安全模型 |
| `src/public_io.rs`（新） | 三阶段文件协议（aux / SCP1 / oracle / recovered / manifest）+ R3 三种统计口径 + 公开数据集 SHA-256 |
| `src/sha256.rs`（新） | 纯标准库 SHA-256（分块流式） |
| `src/compression_tests.rs` | R2：$P_0/Q_0$ 隐式公开常量、自动填充 index 0、GT 目标来源加入 $(0,P_0)$；新增 `RecoveryOutcome`/`recover_with_diagnostics`；`recover_missing_powers` 签名保持不变；移除 `run_all`；R3 字段 |
| `src/main.rs` | 改为 `gen` / `eval` 两个阶段（独立进程），generator 写公开文件+oracle，evaluator 独立逐点评分并输出 JSON |
| `src/bin/recover.rs`（新） | 独立恢复进程，唯一输入 `public/`，不读 oracle |
| `scripts/run_m2b.sh`（新） | 三次 `cargo run --release` 编排三个独立 OS 进程 |
| `pairing.rs` | 单测改用 `generate_for_tests`；`verify_all` 逻辑未变 |

### 实测：三进程正式运行（`bash scripts/run_m2b.sh`，退出码 0）

```
[gen]     N=32 seq_len=63；trapdoor = getrandom OS entropy，未持久化 / 未提交
          M2-A 在随机 SRS 上复跑：tau=1520 alpha=528 beta=32 total=2080 (4160 pairings)
          public_dataset_sha256 = 18bf4eb9900119f555482d37797b2af2d49238460e2cb2c2b8fe6910436522f5
[recover] inputs = public/aux.bin + 7 SCP1；oracle_accessed=false；trapdoor_accessed=false
          control（小标量有界搜索功能测试）：hidden=7 → found=7，searched=1..=64
[eval]    dataset_sha256 重算一致 = true
          storage scopes: native TauG1=6048  SCP1 baseline=6312  aux=12480  full CRS=18528
```

| 方案 | saved | SCP1 (B) | ①/② 节省 | missing | GT 目标 | 覆盖 | P0 | 新恢复 | 已确定 | success | ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 全部幂次（基线） | 63 | 6,312 | -4.365% | 0 | 0/0 | 100.0% | 0 | 0 | 63 | 是 | 2.80 |
| 仅奇数次幂 | 31 | 3,112 | 48.545% | 32 | 32/32 | 100.0% | 1 | 1 | 32 | **否** | 320.18 |
| 仅偶数次幂 | 32 | 3,212 | 46.892% | 31 | 31/31 | 100.0% | 0 | 0 | 32 | **否** | 320.19 |
| 前半部分 | 16 | 1,612 | 73.347% | 47 | 31/47 | 66.0% | 0 | 0 | 16 | **否** | 281.75 |
| 每隔 2 | 32 | 3,212 | 46.892% | 31 | 31/31 | 100.0% | 0 | 0 | 32 | **否** | 321.32 |
| 每隔 4 | 16 | 1,612 | 73.347% | 47 | 47/47 | 100.0% | 0 | 0 | 16 | **否** | 286.12 |
| 每隔 8 | 8 | 812 | 86.574% | 55 | 55/55 | 100.0% | 0 | 0 | 8 | **否** | 235.93 |

- **R2 生效点**：`odd_only` 的 GT 目标覆盖由 31/32 修正为 **32/32**，
  $P_0$ 作为公开生成元被直接确定（新恢复 = 1），其余 31 个偶数次幂仍无法恢复。
  `first_half` 仍为 31/47（$k\ge N$ 缺少公开 $Q_k$，符合预期）。
- **R3 主指标**：`tau_g1_representation_saving_pct = 1 - SCP1/6048`；
  `odd_only` = `1 - 3112/6048 = 48.545%`（对应评审给出的 ≈48.55%）。
  旧 SCP1 基线口径（50.697%）保留为 `scp1_baseline_reduction_pct`；
  另输出 `full_crs_bytes` / `full_crs_reduction_pct`（对 18,528 B）。
  基线出现负值是正常的：SCP1 每点多 4 B 索引，比原生 Section 更大。
  **全部百分比只是表示节省，不是有效 CRS 压缩率。**
- 失败环节不变：$G_T\to G_1$ 求逆。结论边界不变，且不再受「种子公开」质疑。

### 秘密隔离证据（本机实测）

- 全仓库 `grep -rn "SRS_SEED" crates/ docs/ scripts/` 已无源码引用（文档旧节保留历史叙述）。
- `TEST_SEED` 仅出现在 `powers.rs:118/125`，位于 `#[cfg(test)]`，release 二进制不编译。
- `manifest.json` 字段：`phase, curve, arkworks, n, seq_len, secret_model,
  public_dataset_sha256, aux_file, oracle_file, files, relations` —— 不含 $\tau,\alpha,\beta$ 或种子。
- `recovered/summary.json` 显式记录 `oracle_accessed: false` / `trapdoor_accessed: false`。
- `git check-ignore -v`：`results/raw/m2b/public/*.bin`、`oracle/tau_g1_full.bin`、
  `results/raw/m2_results.json` 均由 `/results/raw/*` 命中，未入库。
- M2-A 计数（1520 / 528 / 32）只依赖 $N$ 与索引范围，随机 SRS 上复跑数值不变。

### 测试与提交前检查

- `cargo fmt --all -- --check` ✅、`git diff --check` ✅。
- `cargo test --workspace`：**35 个测试全绿**（ptau-audit 12 + 合成容器异常 7 +
  srs-relations lib 16），比修订前多 7 个（R1 OS 熵、R2 生成元/隐式 P0、
  R3 口径、SHA-256 标准向量、文件协议往返等）。
- 过程中发现并修复 `sha256.rs` 的 `K[16]` 抄写错误（`0xefbe4788` → `0xefbe4786`），
  已与 `ptau-audit::report` 的 K 数组逐行 diff 确认一致；标准向量全部通过。
- Windows incremental 编译偶发 `error deleting lock file ... os error 5` 警告，
  不影响退出码（M1 已记录）。
- 旧版 `results/raw/compression/*.bin` 留在本地（不入库），新版产物在
  `results/raw/m2b/`；两者不互相覆盖。

### 冻结声明

按用户验收：**M1（CRS 结构审计）与 M2-A（代数关系）正式冻结**，本轮未改动其结论；
M2-B 以本修订版为准。下一阶段为 **M3：Powers of Tau 真实内存开销分析**，本轮未启动。

### M3 前置待办（环境，沿用 M0 记录）

- 用户已指出 snarkjs 0.7.6 `powersoftau_verify.js:341` 有
  `MAX_CHUNK_SIZE = 1<<16`，而 `powersoftau_preparephase2.js` 的
  `buff = new BigBuffer(nPoints * sGin)` 在 $N=2^{21}$ 时仅 Tau G1 输入缓冲即
  $2N\times96 = 402{,}653{,}184$ B = 384 MiB。本机源码行号已核实前者的分块常量。
- 当前 WSL2 Ubuntu 内仍无 `rustc`/`cargo`/`node` 且无外网；M3 若继续用 Windows
  原生工具链，必须报告 **Windows Peak Working Set**，不能标成 Linux Maximum RSS。
  进入 M3 前须先固定测量环境与口径。

---

## M3｜Powers of Tau 真实内存开销基线（分支 `experiment/m3-memory-baseline`）

起点 `c5d0e01`（tag `m1-m2-frozen`），**M1 / M2 代码与结论零改动**。本轮只做源码审计、
测量脚本和基线实验，未修改 snarkjs / ffjavascript 计算逻辑，未跑 Power 20/21。

### M2 公开数据集归档（用户建议，非阻塞项，已完成）

`results/processed/M2-public-dataset/`（目录 + `M2-public-dataset.zip`），含
`public/`（7 个 scheme 文件 + aux.bin + manifest/relations）、`oracle/`、`recovered/`、
`m2_results.json`、`ARCHIVE_README.md`、`SHA256SUMS`。21 个文件 `sha256sum -c` 全 OK，
zip 26 个条目可完整解压。**不含秘密种子**（OS 熵生成、未落盘），
`public_dataset_sha256 = 18bf4eb9900119f555482d37797b2af2d49238460e2cb2c2b8fe6910436522f5`。
zip SHA-256：`e030671d63a4eaebdb499b5178565499f83020bd62f4e3098b17d1baeec7a33d`。

归档时发现一个 Windows 细节：`public/aux.bin` 基名 `AUX` 是 DOS 保留设备名，
Windows PowerShell 5.1 的 `Get-Item` / `Compress-Archive` 无法打开它（Rust、Node、
Git Bash 可以）。zip 改用系统 `tar.exe`（bsdtar）生成，细节写入 `ARCHIVE_README.md`。

### M3-A 源码审计（`docs/MEMORY_SOURCE_AUDIT.md`）

- 审计 snarkjs 0.7.6 / ffjavascript 0.3.1 / @iden3/binfileutils 0.0.12 / fastfile 0.0.20；
  核对 `build/cli.cjs`、`build/main.cjs` bundle 与 ESM 源码关键语句逐条对应。
- 实测 `Fr.s = 32`、`tm.concurrency = 28`、G1/G2 affine 96/192 B、jacobian 144/288 B。
- **纠正一个先验判断**：`engine_fft.js` 的 `_fftExt` / `lagrangeEvaluations` 的 t0/t1 扩展
  分支只在 `bits ≥ 33` 触发，而 Power 21 最高 `bits = power+1 = 22`；且
  `preparephase2.js:46-94` 的 ifft/t0/t1 整段被注释。常规 `_fft` 路径才是本项目的对象。
- **新发现（用户未提及）**：`fastfile/src/osfile.js:285-288` 的 `readToBuffer` 会把
  `maxPagesLoaded` 永久放大到 `floor(len*1.1/pageSize)+1`；Power 21 的 384 MiB 读入会
  把页缓存**容量上限**放大到约 **422 MiB**（54,068 页 × 8 KiB）——这是 `maxPagesLoaded` 决定的上限，
  页面按需创建并经 `avBuffs` 复用，**实际驻留未实测**；`avBuffs` 复用不归还 OS。
  这部分内存与 FFT 无关，改 FFT 无法消除。
- 完整分配表 A1–A13 / B1–B6 / C1–C4 / W0–W1，标注类别（JS-EXT / JS-HEAP / WASM / PAGE）、
  是否真实复制、理论生命周期、最早可释放点；`BigBuffer.slice` 在 <1 GiB 时确实全量复制。
- 理论量级（**未实测**）：Power 21 Prepare 仅用户态活跃数据约 3.1 GiB，且 GC 决定叠加方式。

### M3-B 测量工具与环境（`results/raw/m3_environment.json`）

新增 `scripts/measure_snarkjs.ps1`、`run_m3_benchmarks.ps1`、`timestamp_hook.cjs`、
`record_m3_env.cjs`、`build_m3_summary.cjs`、`measure_worker_baseline.ps1`。

- 直接启动 `node.exe ... build/cli.cjs`（不经 `npx`/cmd shim），被测进程就是 snarkjs；
  `web-worker` 在 Node 下用 `worker_threads`，worker 内存在同一进程工作集内。
- 指标统一为 **Windows Peak Working Set**（`Process.PeakWorkingSet64`），25 ms 轮询 +
  退出后再读一次取最大值；stdout/stderr 逐行加 `[t=NNNms]` 前缀以便分段计时。
  每测试一份 `results/raw/m3_*.json`（含命令、输入 SHA-256/字节、输出 SHA-256/字节、
  耗时、峰值、退出码、日志路径）。
- 环境：Windows 11 家庭版 Insider Preview 10.0.26220 / i7-14700（28 逻辑核）/
  31.69 GiB RAM / D: 167.6 GiB 可用 / Node v22.22.2 / PowerShell 5.1.26100.9836 /
  snarkjs 0.7.6 / ffjavascript 0.3.1。**未使用 WSL2**，报告中不出现 Linux Maximum RSS 口径。

#### 测量实现中修正的三个真实问题（保留记录）

1. **.NET 属性缓存**：首轮 9 次测量峰值全部恒为 28.77 MiB。原因是
   `Process.PeakWorkingSet64` 会缓存，必须每次 `Refresh()` 才重新取数。修正后用
   **独立 Process 对象**（`GetProcessById` + `Refresh`）交叉验证 Power 12 Prepare
   得到 513.99 MiB，与主脚本 513.86 MiB 一致。首轮 9 个 JSON 已全部重跑覆盖。
2. **安全删除钩子**：测量脚本原本先删旧输出文件，被 `safe-delete` 钩子 fail-closed 拦截。
   改为不删除，依赖 snarkjs `createOverride` 的 `O_TRUNC`，并用「退出码 + 文件
   LastWriteTimeUtc ≥ 进程启动」判定本次产物，避免误记陈旧文件。
3. **PowerShell 环境变量重复键**：`run_m3_benchmarks.ps1` 的 fixture 生成原用
   `Start-Process`，本机同时存在 `HTTPS_PROXY` 与 `https_proxy`，触发
   `ArgumentException: 已添加项`。改用 .NET `ProcessStartInfo` 直接启动。

### M3-C / M3-D 基线矩阵（Windows Peak Working Set，MiB）

全部使用**有贡献的** `pot<p>_0001.ptau`；`pot<p>_0000.ptau` 只作为生成中间产物。
Power 16 / 18 的贡献文件由本轮生成（`-e` 熵不保证文件哈希可复现，以 SHA-256 为准）。

| Power | Phase 1 Verify | Phase 2 Prepare | Prepared Verify |
| ---: | ---: | ---: | ---: |
| 10 | 532.07 MiB / 0.86 s | 475.00 MiB / 3.64 s | 616.92 MiB / 1.20 s |
| 12 | 501.95 MiB / 0.96 s | 513.86 MiB / 15.15 s | 715.03 MiB / 1.78 s |
| 14 | 654.53 MiB / 1.42 s | 651.12 MiB / 77.09 s | 1152.50 MiB / 3.69 s |
| 16 | 1117.60 MiB / 2.93 s | 1028.65 MiB / 355.84 s | 1694.68 MiB / 12.59 s |

（Power 18 数据见本节末尾补记与 `docs/MEMORY_BASELINE.md`。）

- `prepare phase2` 输出：p10 1,771,431 B / p12 7,079,843 B / p14 28,313,507 B /
  p16 113,248,161 B；三份 `_0001` 与全部 `_final` 的 `powersoftau verify` 退出码均为 0。
- 峰值工作集受 V8 GC 影响有单次运行波动（p10 Phase 1 Verify 两次分别为 532 / 547 MiB），
  本轮以单次测量为主，另做重复实验量化离散度（见 `m3_repeatability.csv`）。
- 未执行 Power 20/21；磁盘余量 168 GiB、内存 31.69 GiB，但是否扩大须等 Power 18 峰值实测。

### M3-C/D 补记：Power 18 完成（2026-11-06）

`pot18_0001.ptau`（150,997,329 B，SHA-256 `ed5b4288…fb86a1`）与 `pot18_final.ptau`
（452,986,785 B，SHA-256 `19546863…5f2cd`）均生成成功，`powersoftau verify` 退出码 0。

| Power | Phase 1 Verify | Phase 2 Prepare | Prepared Verify |
| ---: | ---: | ---: | ---: |
| 18 | 1195.61 MiB / 13.44 s | 1609.94 MiB / 1589.55 s | 3660.04 MiB / 43.09 s |

- 矩阵完整：Power 10/12/14/16/18 ×（Phase1 Verify / Prepare / Prepared Verify）= **15 组**，全部 exit=0。
- 关键结论：Power 18 时 Prepare 的朴素单输入缓冲仅 48 MiB（`2N×96`），实测峰值 **1610 MiB（≈33×）**；
  这证实 M3-A 审计表 `A3/A4/A9/A11` 的多缓冲叠加是真实峰值主因，`384 MiB` 估算（p21 口径）严重低估。
  Prepared Verify 是三者中峰值最高热点（p18 3.6 GiB，p16→p18 每步对应输入 4×、峰值倍率 2.16×）。详见 `docs/MEMORY_BASELINE.md`。

### M3-E 热点分析与 H1 判断（已完成）

交付 `docs/MEMORY_BASELINE.md` + `results/processed/m3_summary.csv` + `m3_tables.md` +
`m3_peak_vs_power.svg` + `m3_phase_timings.csv`。

- 五个热点问题全部回答（分块有效性 / FFT 重复缓冲 / 全域 MSM 复制 / 增长阶推断的限制 / 时间-空间交换）。
- **H1（consume-input FFT）方向成立但单次收益有限**：消除一次 48 MiB~384 MiB 副本只是其中一项，
  真正放大峰值的是 `A3` 页缓存与 `A9` 并发分片 + 28 线程 WASM；建议与「缩短页缓存生命周期」「限制 FFT 并发分片」
  合并评估。任何优化必须满足 `Optimized Output == Original Output`（Sections 12–15 逐字节核对 + 完整 `verify` 通过）。
- Power 21 外推（未运行，仅情景测算）：Prepared Verify 尚未实测，在当前 32 GiB 机器存在较高内存压力风险（情景估算约 6.5–11.6 GiB，不可靠，不构成预测）；已删除原「15–25 GiB」数字。
  磁盘（~3 GiB）充足。按用户要求未跑 p20/21。

### M3 提交与 Git

- 单独分支 `experiment/m3-memory-baseline`（从 `m1-m2-frozen` = `c5d0e01` 切出）。
- 提交 `feat(m3): add powers-of-tau memory profiling baseline`，含 `docs/`（M3-A 审计 + M3-E 基线）、
  `scripts/`（6 个测量/汇总脚本）、`results/processed/m3_*.csv|svg`（汇总，非原始大文件）、
  `results/raw/m3_environment.json`（环境快照）。
- **未入库**：所有 `.ptau` / `*_final.ptau` / `results/raw/m3_*.json` 原始测量（被 `.gitignore` 排除），
  仅保留 SHA-256、大小与汇总。
- 提交前自检：`cargo fmt --all -- --check` 通过（Rust 部分未改动）、`cargo test --workspace` 35 测试全绿、
  三份 `_0001` 与 `_final` 的 `snarkjs verify` 退出码 0。

### 本轮验证的「用户先验假设 ≠ 实测」清单（诚实记录）

1. 「384 MiB 是 Phase 2 Prepare 峰值」→ 实测 p18 已达 1610 MiB，且 p18 朴素输入仅 48 MiB（≈33×），证明多缓冲叠加。
2. 「Phase 1 Verify 的 65,536 分块控制了峰值」→ 成立但只是三者最低，仍随 Power 增至 1.2 GiB（页缓存 `A3` 累积）。
3. 「Prepared Verify 只是多一次 MSM」→ 实测峰值最高（p18 3.6 GiB，但单次测量+固定基线无法判定超线性，详见基线报告 Q4），是首要优先研究目标。

### M4 — Prepared Verify 重复基线 + FastFile 页面池实测 + 分阶段拆解

- 分支 `experiment/m4-repeat-baseline`（从 `main`/`2736c2b` 切出）。对 `powersoftau verify`
  （Prepared Verify）在 p16 / p18 各运行 **3 次**，6 次全部 exit 0。
- 基线（Windows Peak Working Set / Peak Commit，MiB）：

  | Power | Peak WS mean (CV) | Peak Commit mean (CV) | Elapsed mean | FastFile 页面池 |
  | ---: | ---: | ---: | ---: | ---: |
  | 16 | 1662.2 (1.74%) | 1969.3 (1.50%) | 10.0 s | 13.2 MiB（0.79% of WS） |
  | 18 | 3642.0 (0.81%) | 4380.0 (0.52%) | 39.8 s | 52.8 MiB（1.45% of WS） |

- **与 M3 单次测量互验**：p18 3642 vs 3660（−0.5%），p16 1662 vs 1695（−1.9%）；重复测量 CV ≤ 1.74%，基线可复现。
  → **M4.1 修正**：该 −0.5% 是同会话内的巧合。跨会话（M4.1 另测 3 次）p18 均值为 3784 MiB（+3.9%），
  三会话合计 3617–3894 MiB（均值 3713，CV 2.7%）。「≈3.6 GiB 非噪声」成立，两位小数的精度不成立。
- **FastFile 页面池实测（非估算）**：p16 1690 页 × 8 KiB = 13.2 MiB；p18 6759 页 × 8 KiB = 52.8 MiB。
  每次 `capacity == held` 且 `avBuffs = 0`（峰值时所有已分配页缓冲都是活映射页，不存在“仅容量”虚增）。
  池随输入 O(N) 线性增长（4× 数据 → 4× 池），但仅占峰值 0.79% / 1.45%。
  **M3 的 422 MiB 只适用于 `prepare_phase2` 的 384 MiB 单次读入，不适用于 prepared_verify**——实测已证实。
  → **M4.1 修正**：`capacity == held` 原为三个独立历史最大值，不能断言“峰值时刻”；已改为同一采样时刻的同步快照。
  且 422 MiB 是「384 MiB 单次读入的容量估算」，p21 下 prepared_verify 的 G2 全域读取本身即为 384 MiB。
  p18 实测 52.8 MiB 对应的是一次 **48 MiB** 读取（`2^18 × 192 B`，G2），不是 25 MiB。
- **分阶段拆解**：Phase 1（分块贡献验证）在 p18 仅约 0.8–1.3 GiB；Phase 2 首个全域 MSM（tauG1）
  使 WS 从 1.29 GiB 跃至 3.48 GiB（**+2.2 GiB**，t≈11.3→18.8 s），是峰值主因；
  FastFile 全程恒定 52.8 MiB，无法解释该跳变。MSM/FFT 内部各分配（H1 输入副本、分片缓冲、
  WASM 线性内存）的精确切分留待 M5 对 `engine_multiexp.js`/`engine_fft.js` 仪器化，M4 不作归因。
- **工具修正**（本轮踩坑，诚实记录）：
  1. `Process.PeakPagefileUsage` 在 .NET Framework 4.x **不存在**，M3 读到的 `0` 是静默 `$null`；
     改用 `Process.PeakPagedMemorySize64` 记录峰值提交量（commit charge）。
  2. `$Timeline` 参数与 `$timeline` 局部变量因 PowerShell **大小写不敏感**而冲突，把 List 赋给 bool
     类型变量被强制转换为 `$true`，导致 `.Add()` 每次抛异常、`peak_samples=0`；已移除该参数并把局部
     变量改名 `$memorySeries`。
  3. 探针每次读只做 O(1) 读 `maxPagesLoaded`，O(pages) 的 `Object.keys` 仅由 50 ms 采样器执行，
     避免把 p16 耗时从 ~10 s 抬到 ~18 s（内存峰值不受影响）。
- 提交（仅汇总入库；raw json / timeline / log 按约定不入库）：`results/processed/m4_summary_p16|p18.csv|md`、
  `docs/MEMORY_BASELINE_M4.md`、`scripts/m4_instrument.js`、`scripts/measure_m4.ps1`、
  `scripts/build_m4_summary.cjs`、`scripts/m4_stage_analysis.cjs`。

### M4.1 — 测量口径修订（不新增优化、不扩大 Power）

- 分支 `experiment/m4-1-metric-calibration`。目标只有一个：把 M4 的**观测口径**改对，
  再进入 M5 分配归因。M4 的三次峰值结果不推翻，另以 `m4_1_` 前缀补测 3 次（p16/p18 各 3 次，6 次全部 exit 0）。
- **五处修订**：

  | # | M4 表述 | M4.1 修正 |
  | ---: | --- | --- |
  | 1 | 时间线 `pagefile_mib` 当作「当前 commit」 | 它实为 `PeakPagedMemorySize64`（历史高水位，永不下降）。改名 `peak_commit_so_far_mib`，并新增真正的瞬时序列 `current_commit_mib`（`PagedMemorySize64`）；时间线共四个量：`ws_mib` / `current_commit_mib` / `peak_ws_mib` / `peak_commit_so_far_mib` |
  | 2 | 「commit 比 WS 高 18–20%，故约 1/5 提交内存未驻留」 | **删除**。两个独立历史峰值可能发生在不同时刻，且两者统计对象不同；只分别报告两项峰值，不做减法/比例 |
  | 3 | 「最大读取是单个 Lagrange 段 ~25 MiB，故池子 ~53 MiB」 | 最大读取是 **48 MiB**：`sG = G.F.n8*2` → G2 为 192 B/point，`2^18 × 192 B = 48 MiB`；`floor(48 MiB×1.1/8 KiB)+1 = 6759` 页，与实测完全吻合 |
  | 4 | 「422 MiB 只属于 prepare_phase2」 | p21 下 prepared_verify 的 G2 全域读取即为 `2^21 × 192 B = 384 MiB`，同样给出 ≈422 MiB **容量估算**；并非 prepare_phase2 专属，且 p21 未实测，估算 ≠ 驻留 |
  | 5 | 「每次 `capacity == held`，峰值时所有页缓冲都在活动映射」 | 三个量原为独立历史最大值。探针改为每次采样同步读取 `(maxPagesLoaded, pagesCount, avBuffs)` 三元组并保存快照；结论收紧为「容量最大那次采样中，已装载页数等于容量且无空闲缓冲」 |

- **补测结果（M4.1 会话，n=3，MiB）**：

  | Power | Peak WS mean ± sd (CV) | Peak Commit mean ± sd (CV) | 采样到的当前 commit 最大值 |
  | ---: | ---: | ---: | ---: |
  | 16 | 1656.65 ± 64.73 (3.91%) | 1956.97 ± 66.47 (3.40%) | 1932 / 2023 / 1892 |
  | 18 | 3783.97 ± 95.32 (2.52%) | 4497.23 ± 88.81 (1.97%) | 4381 / 4581 / 4377 |

  与 M4 会话合并（n=6）：p16 1659.44 ± 44.94（CV 2.71%）、commit 1963.11 ± 46.50；
  p18 3712.98 ± 100.14（CV 2.70%）、commit 4438.64 ± 86.51。
  **会话间漂移 +3.9%（p18 WS）/ +2.7%（commit）**，大于会话内 CV——这是本轮最有价值的方法学发现：
  同一名义测量在不同会话可差 ~4%，此前「与 M3 差 −0.5%」属巧合。
- **采样覆盖率的自校验**：`sampled_commit_max_mib` 只回收 `peak_commit_mib` 的 **98.4–99.8%**，
  说明 50 ms 轮询会低估峰值 ~0–1.6%，因此峰值一律取内核计数器，时间线只用于形状。
- **FastFile 同步快照（6 次运行全部一致）**：p16 `(cap 1690, pages 1690, av 0)` = 13.2 MiB（占均值峰值 0.80%）；
  p18 `(cap 6759, pages 6759, av 0)` = 52.8 MiB（1.42%）。即容量上限由实际在用页撑满，不存在「仅容量」虚增。
- **阶段表改用当前值**（p18 r1，peak 3738/4444）：Phase 1 当前 WS 峰值 1131 MiB（β·τ·G1 处，t≈11.5 s）；
  Phase 2 tauG1 起点 776 MiB → tauG2 标记处 2936 MiB（**+2.2 GiB**），50% 分位已 3378 MiB；
  此后在 3.0–3.4 GiB 平台振荡，峰值 3738 MiB 出现在 βτG1（t≈36 s）。FastFile 全程恒定 52.8 MiB。
- **工具改动**：`measure_snarkjs.ps1`（四量时间线 + `peak_commit_*` 改名 + `sampled_commit_max_*`）、
  `m4_instrument.js`（同步快照，输出 `peakCapacitySnapshot`/`peakHeldSnapshot`/`nSamples`）、
  `measure_m4.ps1`（`-Prefix`，默认 `m4` 保持原命名）、`build_m4_summary.cjs`（`peak_commit_mib` 回退旧字段 +
  快照列）、`m4_stage_analysis.cjs`（当前/历史 commit 双列 + 标记处取当前值）。
- 汇总入库：`results/processed/m4_1_summary_p16|p18.csv|md`；报告 `docs/MEMORY_BASELINE_M4.md` 已按上表重写 §0–§6。
- **下一批（M5）不做 patch，只做归因**：对 `engine_multiexp.js` / `engine_fft.js` 记录分配大小与释放时机，
  回答那 +2.2 GiB 中 FFT 输入副本、MSM 分片/累加缓冲、WASM 线性内存各占多少；再决定先动哪一处（H1 / MSM 并发 / 缓冲生命周期）。

---

## M5-A｜探针设计与源码分配路径审计（2026-11-07，无实验）

- **分支**：`experiment/m5-attribution`。本轮**不跑任何新测量、不改依赖、不改计算逻辑**；
  交付 `docs/M5_PROBE_DESIGN.md` + `scripts/m5_budget.cjs`（纯静态算术）。
- **源码级事实（ffjavascript 0.3.1，逐行核对）**：
  1. `threadman_thread.js:44-56` 的 `alloc()` 扩容判据在 `u32[0]` 已 `+= length` 后再加一次 `length`，
     等价于要求 `byteLength >= top + 2*length` → **单 Worker 线性内存 ≈ 2× 首块 ALLOCSET**；任务结束只回滚
     分配指针（`:115-117`），**永不缩容**。
  2. `engine_multiexp.js:119-125`：`nBitChunks = floor(255/bitChunk)+1`，`chunkSize = floor(N / (concurrency / nBitChunks))`；
     每个 bit-chunk 任务**各带整块** bases+scalars，`queueAction` **不传 transfer list** → 结构化克隆。
     克隆总量 = `nBitChunks × N × 128 B`，**与并发度无关**；在途量 ≈ `min(28, 任务数) × 单任务载荷`。
     → **A.1 修正**：位块公式必须带标量宽度（`(8·sScalar−1)/bitChunk+1`），本条的 18 位块只对 32 B 标量成立。
  3. 全路径唯一的 transfer 是启动时每个 Worker 的 wasm 模块字节（`threadman.js:137`）。
  4. Worker 源码经 `thread.toString()` → data URL → `VM.runInThisContext`，**无模块级 `require`**，
     遥测只能随结果 `postMessage` 回传，由主线程落盘；且不能额外 `postMessage`（会被 `getOnMsg` 误判为任务完成）。
- **账本（模型值，p18 prepared_verify）**：tauG1 MSM `2^19` 点 → 18 bit-chunk × 2 point-chunk = 36 任务，
  单任务 41.2/22.9 MiB，在途峰 **970 MiB**，28 个 Worker 的 WASM 容量合计 **1455 MiB**；lagrange MSM 505/759；
  Fr FFT 16/44；FastFile 52.8。扣除 phase-1 已支付的 223 MiB 后，tauG1 段增量模型 **2200 MiB**，
  对照 M4.1 实测 **+2160 MiB**（误差 2%）。
  → **A.1 撤回该行结论**：账目须按标量宽度拆三条；phase-1 基线 223 MiB 错（应为 72.4 MiB），
  故「误差 2%」不成立，改后为 2351 MiB 对 2160 MiB（**高出 8.9%**）。详见下方 M5-A.1 条目。
- **推翻/降级 M4 的候选排序**：原 H1（FFT 输入副本 `buff.slice`）在 prepared_verify@p18 约 50 MiB（≈2%），降级；
  `prepare_phase2` 相反——那里 FFT 是主路径，但模型账本（430 MiB）远小于 M3 实测（1610 MiB），
  残差指向「重复分配未及时回收」，故 M5 必须测 `arrayBuffers` 而不只是 WASM。
- **未做**：不改 `chunkSize`/`concurrency`/任务顺序；不引入 transfer list；不「顺手修」`alloc()` 的双倍余量；
  不跑 p20/p21。
- **下一步**：M5-B 按 `docs/M5_PROBE_DESIGN.md` §6 实现 instrumentation-only patch（vendor 副本 + resolve hook + JSONL），
  再由 M5-C p10 smoke 验证扰动预算，M5-D 做 p16/p18 交错对照。
---

## M5-A.1｜标量宽度与 Phase 1 基线修正（2026-11-09，无实验）

- **触发**：设计评审指出 A 稿把 `resLagrange` 的 32 B 标量参数套用到了全部 MSM。逐行复核后确认成立，
  且波及 Phase 1 基线与「2% 吻合」两个结论。
- **源码复核（三条标量路径，互不通用）**：
  1. `powersoftau_verify.js:361` `scalars = misc.getRandomBytes(4*(n-1))` → **Phase 1 = 4 B**；
     `:371-372` 每个 64 Ki 点分片跑两次 MSM，各 `n-1` 点（顺序 await，在途不相加）。
  2. `:425,439` `buff_r = new Uint32Array(nPoints)` → **resTau = 4 B**（`:452` 调用）。
  3. `:454` `bigBuffer(nPoints*Fr.n8)` 经 batchToMontgomery → fft → batchFromMontgomery → **resLagrange = 32 B**（`:482`）。
- **Phase 1 重算（p18，4 B）**：65535 点 → `pTSizes[15]=12` → `nBitChunks=3`（原写 22）；
  `chunkSize = floor(65535/(28/3)) = 7021` → 10 个 point-chunk（原写 2）。任务 30、单任务 0.67 MiB、在途 18.3 MiB。
  G1 分片 `7021×96×2 = 1,348,032 < 25 页` → 不扩容；**G2（tauG2）** `7021×192×2 = 2,696,064 > 25 页` → 扩到 42 页。
  尾部小分片（2346 点）不扩容 → **27×2.625 + 1×1.5625 = 72.4 MiB**，替代原 223 MiB。**驱动项是 G2，不是 G1。**
- **resTau（4 B）单列**：`2^19` → bitChunk 15、3 位块、10 point-chunk、30 任务、单任务 5.4 MiB、在途 146.4 MiB、
  165 页/Worker。它在时间上先于 resLagrange，决定 tauG1 窗口前半段形状，但不抬高最终高水位。
- **resLagrange（32 B）不变**：`2^19` → 18 位块 × 2 point-chunk = 36 任务、单任务 41.1 MiB、在途 969.1 MiB、
  988 页/Worker（61.75 MiB 容量）、合计 1454.6 MiB。
- **修正后对账**：模型段增量 = 969.1 + (1454.6 − 72.4) = **2351.3 MiB**，对 M4.1 实测 +2160 MiB **高出 8.9%**；
  同窗锚定 776 + 2351 = 3127 MiB 对实测 tauG2 标记处 2936 MiB（+6.5%）。p16 同法得 591.5 MiB 对 194 MiB（**3.0×**）。
  → 「2% 吻合」撤回；模型身份改为**上界**，且 p16/p18 偏差量级不同，说明仍有未建模项。
- **其他修正**：
  - 删除「模型共存峰值 − 全程峰值」比较（不同相位不可比），改为同窗「起始 current WS + 模型增量」。
  - F14 改正：`2^19` 的 FFT 是 **32 chunk × 16384 点**（8192 是 `2^18`）。
  - 单位统一 MiB：`2^19×32 = 16 MiB`、`2^19×96 = 48 MiB`（原 16.8/50.3 是十进制 MB 混入）。
  - `prepare_phase2` 的 920–1180 MiB 差额降级为**未解释残差**，不再断言「碎片/未释放」。
  - 删除 p19–p21 外推表（模型在 p16 差 3×，外推无意义）；只保留定性风险陈述。
  - 验收门由「模型值 70%–100%」改为三层：**L1 切分逐字段相等 / L2 逐 Worker 页数对账 / L3 同刻四量 + 显式残差**。
- **新增两条防错要求（M5-B 必做）**：
  1. **provenance 自证**：首条 JSONL 记录 `require.resolve('ffjavascript')` 的实际路径 + 副本 SHA-256 + patch SHA-256；
     若指向 `node_modules` 则整次运行作废（非零退出）。
  2. **入队绑定**：`queueAction` 入队时写 `task_id/call_id/site/send_bytes`，调度时只用该元数据，不读全局状态，
     避免延迟调度导致 site 被下一次 MSM 覆盖。
- **未做**：不改依赖、不改计算逻辑、不跑新测量、不跑 p20/p21；`m1-m2-frozen` 未动。
- **下一步**：等 A.1 评审通过后进入 M5-B（vendor 副本 + resolve hook + 自证 + 入队绑定）。

---

## M5-A.2｜补齐账目 D、边界假设与无容差回放（2026-11-09，无实验）

- **触发**：A.1 评审指出三项——① 账目缺 `Fr.batchTo/FromMontgomery`；② HYP-1/HYP-2 只能作边界；③ 不接受
  L2 的"整页差"容差；另指出 `3127 vs 2936`（6.5%）不能当吻合证据。逐条核实后全部成立。
- **账目 D（新增）**：`engine_batchconvert.js:23-32` 每 chunk **两次分配**（`ALLOCSET` + `ALLOC`），
  `Fr.batchTo/FromMontgomery` 的 `sIn = sOut = 32`（`wasm_field1.js:71`）。
  p18 @`2^19`：28 chunk × 18,724 点（末块 18,740），每块 `599,168 + 599,168 B`；
  回放 `alloc()` 得 **25 → 28 页**，28 个 Worker 合计 **49.0 MiB**。
  **但它在同一次 `verifyPower` 中晚于 `resTau`**（p18 165 页 / p16 42 页），故**不抬高水位**（增量 0），
  只进入容量历史。p16 的 `2^17` 档两次分配仅 `299,584 B`，**不扩容**。
  主线程侧：`BigBuffer.slice` 跨页必复制 → 每次调用共存 64 MiB（输入 16 + 分片 16 + GET 16 + 输出 16），
  相对调用前新增 48 MiB，`verifyPower` 内连续两次。
- **HYP 边界化**：HYP-1（基址 0）明确为**下界**（真实基址只抬高 `requiredPages`）；HYP-2（大分片各占一 Worker）
  明确为**上界且不代表实际调度顺序**。两者都写清"如何被实测替换"。
- **L2 改为无容差**：从 `alloc_base` 起按 `allocs[]` 逐条回放，`grow_events` 的 `from_pages → to_pages` 与
  `wasm_after` 必须**逐 Worker、逐事件精确相等**；首个不符的 `(worker, task_id, alloc_index)` 即判失败。
  为此 `worker_task` 新增 `allocs[]` 与 `grow_events[]` 两个字段（长度 ≤ 6，成本可忽略）。
- **删除跨量纲相加**：删掉 `776 + 2351 = 3127` 对 2936 的 6.5%；新增"在途字节 / WASM 容量 / Working Set
  三者不可互加"的硬约束，L3 残差改为**区间**（WASM 容量的 `[0, capacity]` 作上下界）。
- **自查发现的三处（评审未提，但同样影响结论）**：
  1. **单次 `+2160 MiB` 不可代表段增量**：三个 run 的 tauG1 段增量是 **+2160 / +2487 / +2636**（均值 2428，±10%），
     p16 是 +194 / +207 / +238（均值 213）。模型 2351 落在 p18 区间内（**0.97×，低于均值**），p16 为 **2.8×**。
     → **"模型是上界"不成立**（方向相反）；且 p18 的离散（476 MiB）**大于**模型与均值之差（−77 MiB），
     **该比较不能判定模型对错**，只能判定"同量级"。M4.1 的 +2160 是 r1 读数。
  2. **phase 2 是四个 section 共用容量**（`verifyLagrangeEvaluations` 调 4 次，只有 tauG1 多跑 `power+1`）：
     r1 实测 tauG1 +2160 之后，tauG2 / alphaTauG1 / betaTauG1 只各 +266 / +230 —— 容量被复用，不是四次独立增长。
     若按四次推会得到约 10 GiB，与实测峰值 3738 MiB 冲突。
  3. **`betaG2` 闭合**：`processSectionBetaG2`（`:316-338`）读 192 B 后 `fromRprLEM`/`toRprUncompressed`，
     **无 MSM、无 Worker、无 WASM 分配**，上界 < 1 KiB，判为 0（原写"疑似 < 1 MiB"）。
- **未做**：不改依赖、不改计算逻辑、不跑新测量、不跑 p20/p21；`m1-m2-frozen` 未动。
- **下一步**：等 A.2 评审通过即进入 M5-B。**A.2 是本项目最后一次静态设计校准**，此后所有数字来自探针或明确标注为边界假设。

---

## M5-B｜探针建成：vendor 副本 + 24 处补丁 + 三模式驱动（2026-11-09）

- **触发**：M5-A.2 评审通过，但要求"M5-C 之前 L1/L2 必须真正可执行，而不是只写在文档里"。
  本轮只做**测量工具**：不碰算法、不跑 p16/p18、不改 `node_modules`。
- **形态**：不修改 `node_modules`。`scripts/m5_build_vendor.cjs` 把 `node_modules/ffjavascript` 整包复制到
  `vendor/ffjavascript-0.3.1-m5/`，在副本的 `build/main.cjs`（`exports["."].node.require` 指向的唯一入口，
  Worker 源码由 `thread.toString()` 从同一 bundle 生成）上打 **24 处断言式补丁**：每处先断言锚点唯一命中，
  否则构建失败退出。产出 `M5_MANIFEST.json`（before / after / runtime / patch 四个 sha256）与
  `patches/m5-instrumentation.patch`（14,097 B）。
  - `build/main.cjs`：`40128293…` → `efd3ed81d15596c517e12eb09ce1530b6a08270d74501e4d2af689d0d0ddb5db`；
    `build/m5_runtime.cjs`：`fa6960a8…`。
- **开关与自证**：`scripts/m5_hook.cjs` 作 `--require` 钩子，用 `Module._resolveFilename` 把 `ffjavascript`
  重定向到 vendor；`M5_CONFIG` 未设时**完全不动解析**（pristine 路径）。自证硬门：
  `require.resolve('ffjavascript')` 必须等于 vendor 路径且不含 `node_modules`，否则 `process.exit(3)`；
  每次运行首条 JSONL 写入 `resolved + sha256 + trace=ON/OFF`。
  - **Worker 线程会继承 `process.execArgv`**（含 `--require`），所以钩子开头必须
    `if (require('worker_threads').isMainThread === false) return;`，否则每个 Worker 都打开同一个 JSONL，
    实测刷出 100+ 行重复 `[m5] resolved=`。
- **上下文绑定**（评审缺口 ③）：不再依赖"读全局"。`queueAction(actionData, transfers, ctx)` 在**入队时**
  分配 `task_id` 并绑定 `ctx`；`_multiExp` / `_multiExpChunk` / `batchConvert` / `_fft` / `*Join*` /
  `batchLEMtoU` 各自在调用点构造 `ctx`（`call_id / site / kind / group / n_points / ...`），
  `ctx === undefined` 时记 `site:'unlabeled'`——**记录而非丢弃**。MSM / BatchConvert / FFT 各发独立
  `*_plan` 事件，与 `task_send` / `worker_task` 用 `call_id` 对齐。
- **事件模型**：`provenance` / `anchor` / `task_send` / `worker_task` / `task_done` / `msm_plan` /
  `batch_plan` / `fft_plan` / `fft_assembly` / `summary`。`worker_task` 带 `allocs[]`（长度 ≤ 6）与
  `grow_events[]`（`at_alloc / len / from_pages / to_pages / top`），供 L2 无容差回放。
- **门槛脚本（可执行，不是文档）**：
  - `scripts/m5_check_l1.cjs`：按顺序逐调用比 `kind` 与 `n_points / s_scalar / s_in / s_out / bit_chunk /
    n_bit / chunk_size / points_in_chunk / n_chunks`，并用 `task_send` 计数比 `n_tasks`；
    缺 `provenance` 行则拒绝评分。
  - `scripts/m5_check_l2.cjs`：从 `alloc_base` 起按 `allocs[]` 回放，逐条比 `grow_events[]` 与 `wasm_after`，
    并校验 `alloc_top`；**零容差**，首个不符定位到 `(worker, task_id, alloc_index)`。
- **三模式驱动**：`scripts/measure_m5.ps1 -Mode pristine|vendor|trace`，委托 `measure_snarkjs.ps1`，
  从而 Windows 口径与 M4.1 完全一致。`pristine` = M4.1 基线；`vendor` = 加载补丁但 `M5_TRACE=0`（测扰动）；
  `trace` = 出 JSONL。这三者是 M5-C 扰动预算的对照基础。
- **静态账本重写**（评审缺口 ①②）：`scripts/m5_budget.cjs` 从"每次调用独立估算 + 排序取最坏"改为
  **顺序逐 Worker 容量池模型**（`newPool / replayOn / dispatchTasks / buildPlan`）；`--operation plan`
  输出 445 次调用（p18）的完整执行计划，G1 / G2 与所有实际执行的 power 全覆盖。`phase1` 与
  `prepared_verify` 两个子命令改为**从同一 plan 取数**，删除了旧的 `phase1Ledger` / `verifyPowerLedger`
  ——它们是"每 section 独立估算"的来源，会与 plan 给出互相矛盾的数字（同一份文档里出现两套页数）。
- **本轮踩到并修掉的 6 个实现缺陷**（均为"看起来对"的错，记录以备复查）：
  1. `/tmp` 在 Windows 上不可 `require` → 计划文件改写到 `results/raw/_m5_plan_*.json`。
  2. `RUNTIME_SRC` 模板字符串里的反引号提前闭合 → 改用括号。
  3. 补丁锚点不唯一（`tm.queueAction(task)` 后接 `await Promise.all` 的片段出现 2 次）→ 扩大锚点至含唯一前缀。
  4. `M5.ingest` 收到的是 snapshot，而函数内部又取 `snap.out` → p10 冒烟在 `pairingEq` 读 `undefined`；
     改为传入整条消息、内部取 `payload.out`。
  5. Worker 重复打开 JSONL（见上）。
  6. **任务数不符**：L1 首次 FAIL 在 `#67 msm tauG1.p11.resTau: tasks expected 8, observed 10`。
     根因是 `_multiExpChunk` 在 `engine_multiexp.js:53-54` **按分片点数重算** `bitChunkSize`，与 `_multiExp`
     外层值不同（2048 点被 `MIN_CHUNK_SIZE` 切成 2×1024，内层 `pTSizes[10]=7` → 5 个位块）。
     计算器改为按每个 `chunkPts` 单独算位块数，连带修正 p18 的 tauG1 任务数 36→39、tauG2 38→40、
     首轮分布 18/10→19/9 与 19/9→20/8、tauG2 池增量 92.75→96.1 MiB。
- **未做**：不跑 p16/p18 的 trace（留给 M5-D）；不写优化代码；`m1-m2-frozen` 未动。

---

## M5-C｜p10 冒烟：L1 / L2 双 PASS，`alloc_base` 实测 102,328 B（2026-11-09）

- **命令**：`measure_m5.ps1 -Mode trace -Power 10` → `snarkjs powersoftau verify` 的 `prepared_verify @ 2^10`，
  exit 0、**2,082 ms**、**30,537 条事件**。
- **事件构成**：`provenance 1 / anchor 1 / task_send 10,084 / worker_task 10,084 / task_done 10,084 /
  batch_plan 94 / msm_plan 98 / fft_plan 45 / fft_assembly 45 / summary 1`；
  `provenance` 自证指向 `vendor/ffjavascript-0.3.1-m5`，未回落到 `node_modules`。
- **L1 PASS**：237/237 次调用按顺序全部匹配（`kind` + 9 个字段），`task_send` 计数与计划一致；
  其中 24 个任务为 `unlabeled`（占 10,084 的 0.24%）。
- **L2 PASS（零容差）**：28 个 Worker、10,084 个任务，从 `alloc_base` 起逐条回放，`grow_events[]` 与
  `wasm_after` **全部一致，0 fails**；p10 全程 `maxpages = 25`（phase 1 的 G1 分片远小于 25 页，不扩容）。
  这也顺带证实账目 D：94 次 batchconvert 调用在 p10 上 0 次 grow。
- **HYP-1 被推翻**：10,084 个任务的 `alloc_base` **全部 = 102,328 B**，不是 0。用该基址重算：

  | 量 | 基址 0（A.2 的假设） | 基址 102,328 B（实测） |
  | --- | ---: | ---: |
  | phase-1 池（p18） | 1,176 页 = 73.5 MiB | **1,204 页 = 75.3 MiB**（28 × 43） |
  | `resLagrange@p19` 首轮 | 27×988 + 1×549 | **19×989 + 9×551** |
  | `tauG2 resLagrange@p18` 池增量 | 1,539 页 = 96.2 MiB | **1,538 页 = 96.1 MiB** |
  | batchconvert 冷启动 `@2^19` | 28 页 | **30 页 = 52.5 MiB** |

  幅度都是整页级，方向与 A.2 的判断一致（基址只抬高 `requiredPages`），但**页数本身就是 L2 的判据**，
  所以必须在模型里显式存在。`docs/M5_PROBE_DESIGN.md` 的 §1、§5.1–§5.6、§5.8 已按实测基址全部重算，
  §5.6 的模型段增量随之从 2351.3 / 591.5 MiB 改为 **2,396.5 / 594.2 MiB**（对实测均值 0.99× / 2.79×）。
- **`unlabeled` 24 个任务的定性**：签名均为 `allocs = [144, 288, 288, 20,448, 576]`，即 3 点 G1 MSM
  （`timesScalar` 路径），来自 snarkjs 在主线程内联构造的 task（`cli.cjs:3555+`），不经过任何 `queueAction`
  调用点，因此没有 `site`。属"必须记录而非丢弃"的正常类别，L1 只校验其存在与可回放，不计入逐调用比对。
- **曲线只有一个 ThreadManager**：`engine.js:14` 只调一次 `buildThreadManager`，G1 / G2 / Fr 共用 `curve.tm`，
  按 worker 号聚合不会串池——这是 L2 能逐 Worker 对账的前提。
- **未做**：p16 / p18 的 trace 尚未跑。
- **下一步**：M5-D 在 p16 / p18 上做 pristine-vs-trace 交错对照。

---

## M5-C.1｜扰动预算：三模式各 5 次（2026-11-09）

- **目的**：在跑 p16/p18 之前先回答"探针本身会不会改变被测对象"。产物在 `results/raw/m5c/`。
- **命令**：同一 fixture、同一命令行，只改 `-Mode`（`pristine` / `vendor` / `trace`），各 `-Repeats 5`。

  | 模式 | peak WS（MiB） | 中位 | 耗时中位 (ms) |
  | --- | --- | ---: | ---: |
  | pristine | 613.5 / 554.4 / 555.1 / 556.9 / 613.1 | 557 | 1,885 |
  | vendor | 626.4 / 625.1 / 589.4 / 589.3 / 565.7 | 589 | 1,913 |
  | trace | 622.6 / 565.2 / 628.3 / 595.4 / 570.5 | 595 | 2,067 |

- **结论 1（可主张）**：换 bundle 免费。`pristine` 与 `vendor` 的耗时中位差 28 ms（1.5%）。
- **结论 2（可主张）**：写 JSONL 约 **+9%** 墙钟（trace 五次全部 ≥ 1,940 ms，其余两组 4/5 ≤ 1,974 ms）。
  任何 trace-vs-pristine 的时间比较都必须先扣掉这个系统性偏差。
- **结论 3（必须是负结论）**：**peak WS 无法判定扰动**。三种模式区间几乎完全重合（554–628 MiB），
  而同一模式内的极差已有 59–63 MiB（`pristine` 自身出现 555 与 613 两个簇）。
  模式之间的差 < 模式之内的差 ⇒ **p16/p18 的归因不得以 peak WS 为主判据**，主判据只能是逐 Worker 的
  `allocs / grow_events / wasm_after`。这也回溯说明 M4.1 把三次读数的极差称为"±10% 噪声"是过强表述。
- **可复现性**：五次 trace 的 L1（237/237 调用）与 L2（10,084 任务、0 fails）全部 PASS，
  说明探针输出本身稳定，peak WS 的离散来自被测进程。
- **顺手修掉的一个统计 bug**：`measure_m5.ps1` 用
  `Get-Content -ReadCount 0 | Measure-Object -Line` 数事件行数，`-ReadCount 0` 返回**单个数组对象**，
  于是 30,537 行的 JSONL 被报成 `events: 1`（清单里的数字对、文件本身没错）。  改为在文件句柄上
  逐行 `ReadLine()` 计数后，清单显示 30,537。

---

## M5-D｜p16 / p18 交错对照：静态账本被逐项检验（2026-11-09）

- **设计**：每档 3 对 `pristine` / `trace` **交错**执行（`-RunTag _a$k` / `_b$k`），使漂移在两个模式间共享。
  产物在 `results/raw/m5d/`（16 份 measurer JSON + 6 份 JSONL，每份 50,178 / 60,960 事件）。
- **门槛**：p16 L1 360/360 调用、16,582 任务；p18 L1 445/445 调用、20,145 任务；两档 L2 全部 0 fails
  （`memory.grow` 事件 110 / 180 条逐条回放相等，`alloc_base` 全为 102,328 B）。
- **探针扰动复核**：p16 trace 1,474–1,591 vs pristine 1,503–1,551 MiB（区间重叠）；
  p18 trace 3,691–3,763 vs pristine 3,724–3,781 MiB（区间重叠）。耗时 p18：trace 57.2–65.5 s，pristine 58.2–62.8 s。
  **p10 上的 +9% 写盘成本在 60 s 级负载上被摊薄**，与"固定成本"的解释一致。
- **本轮的绝对耗时比 M4.1 慢 1.8×**（p16 10.2–11.8 s → 18.5–18.9 s；p18 30.7–40.2 s → 57.2–65.5 s）：
  同一命令行、同一 node，说明这是机器/负载的跨会话差异。**跨会话只能比同会话内的 A/B，不能比绝对秒数。**

---

## M5-E｜归因报告：两个状态量精确命中，"同时在场"不成立（2026-11-09）

> **本节标题已被 M5-E.1 撤回**，保留原文仅为留痕。作废的是三处：`send_bytes` 的口径（MSM 差一个 Jacobian，
> 不能称"精确命中"）、"同时在场不成立"这句判断（grow 时间戳记在任务完成时，当时并没有真实时间戳），
> 以及峰值时刻的残差（§10.9 禁止在该时刻做减法）。仍成立的是容量池模型与逐 Worker 分布。
> 现行结论见下方 **M5-E.1** 条目与 `docs/M5_ATTRIBUTION.md`。

- **文档**：`docs/M5_ATTRIBUTION.md`。分析器 `scripts/m5d_attribution.cjs` 把四个量放到同一时钟上
  （在途 / 容量 / Worker JS 堆 / WS），残差以**区间**给出。
- **精确相等的两项**：
  - 在途峰：p18 **987.4 MiB**（模型 987.4），峰值时刻 **100%** 来自 `tauG1_19_transformed`；p16 **265.1**（模型 265.1）。
  - 容量终值：p18 **25,288 页 = 1,580.5 MiB**（模型 25,288），逐 Worker **20×1044 + 8×551**；
    p16 **6,826 页 = 426.6 MiB**，逐 Worker **22×276 + 2×153 + 4×112**。与模型分布**逐项相等**。
- **不成立的那一项**：在途峰发生在 t≈30.7 s，那一刻容量池只有 **778.3 MiB**（终值 1,580.5）；
  容量到终值时在途已回落到 0。所以"在途 + 容量 ≈ 峰值"在时间上不成立。
- **残差（区间，不归因）**：
  - 在途峰时刻：WS 3,260–3,368 MiB，减在途 987.4 与"当时容量"778.3 后余 **1,494–1,603 MiB**；
    若容量按终值计，余 **692–791 MiB**。区间宽度全部来自"扩容何时可见"。
  - 运行结束（在途 = 0）：p18 残差 **853–875 / 1,397–1,452 / 1,099–1,133 MiB**，三次极差约 **600 MiB**，
    而探针量三次完全相同 ⇒ **这一项是进程级可变开销，不能归给任何固定机制**；可主张的只是下界
    **≥ 0.85 GiB（p18）/ ≥ 0.79 GiB（p16）**。起点基线 WS 为 439.9–443.3 / 437.9–444.6 MiB。
- **H1 被排除为主因**：p18 的 FFT 在途 ≤ 16 MiB，占在途峰 < 2%。
- **没做的事**：不写优化代码、不改依赖、不跑 p20/p21、`m1-m2-frozen` 未动。
- **下一步（若要继续）**：把 `grow_events` 的时间戳下移到 alloc 内部（收紧"容量何时可见"）；
  用 `-HeapSampleMs` 采 `heap_sample.array_buffers`，把结束残差拆成主线程缓冲 / FastFile 页池 / V8 未回收。

---

## M5-E.1｜口径修正与时间戳补强：一个结论被推翻（2026-11-09）

- **触发**：M5-E 评审指出三处问题，其中两处会直接影响结论：①`send_bytes` 把 `ALLOC`/`GET` 也算成"发送"；
  ②`memory.grow` 的时间戳记在任务完成时，因此"在途峰时容量只有 778.3 MiB"是"主线程已收到报告"的容量，
  不是真实容量。评审要求先修口径再谈优化。
- **P0-1 三种字节量拆开**：`payloadBytes()` 不再返回一个数，而是
  `{clone: ALLOCSET+SET, alloc: ALLOCSET+ALLOC, get: GET}`；`task_send` 改发
  `clone_buffer_bytes / wasm_alloc_bytes / worker_output_bytes`。`wasm_alloc_bytes` 必须把 `ALLOCSET` 算进去，
  因为 `allocBuffer()` = `alloc(byteLength)` + `setBuffer()` —— 这一步最初漏了，被 L2 的交叉校验当场抓出
  （`task_send.wasm_alloc_bytes 21312 != sum(allocs) 21744`，差 432 = 两个 `ALLOCSET`）。
- **量级**（p18 全程按任务累加）：MSM 9,960.6 vs 旧 9,964.4（1.00×，只差一个 Jacobian，所以在 987.4 MiB 上看不出）；
  batch 304 vs 912（**3.00×**）；FFT 480.2 vs 1,040.1（**2.17×**）。
- **P0-2 grow 时间戳**：`M5_HR = () => String(process.hrtime.bigint())` 内联进 worker，
  `grow_events[]` 增 `t_hr`，`anchor` 增 `t0_hr`，任务增 `t_hr_start/t_hr_end`。`hrtime.bigint()` 跨 worker 线程同源，
  所以三条时间线可以放在一根轴上。
  - **在 `alloc()` 里只取时间戳、不拼字符串、不写盘**；p18 全程只有 180 次。
  - 容量因此变成精确阶梯函数 `C(t) = 700 页 + Σ{grow : t_grow ≤ t}`。
- **结论被推翻**：在途峰（p18 t=21.7 s）那一刻 `C = 1,484.4 MiB`，是终值 1,580.5 的 **93.9%**（p16：404.4 / 426.6 = 94.8%）。
  **在途与容量确实同时到顶**。M5-E 的 778.3 MiB 比真实值低 **706 MiB**，它统计的是"已完成任务的增长"。
  "把两者相加当峰值预测"这个禁令仍然有效，但理由不是"不同时"，而是它们在峰值时刻同时处于高位。
- **P1 残差口径**：峰值时刻不再算残差，只同刻并列。结束残差只在 `in-flight = 0` 的时刻算，且"结束"必须
  以**最后一个任务完成**为界——snarkjs 返回后 ThreadManager 被销毁，采样器还会轮询 200–300 ms，
  WS 从 2,714 掉到 207 MiB，用 `series` 末元素会得到负残差。修正后 `WS(end) − C(final)` =
  p18 **829 / 957 / 1,184 MiB**、p16 **1,111 / 1,147 / 1,218 MiB**。
- **P1 门槛补强**：
  - L1 增加 `site`（经 plan 的 `probe_site` 映射）、`group`、`s_g`。旧 L1 不比 `site`，
    而 M5-E 的"在途峰 100% 来自 `tauG1_19_transformed`"完全依赖 `site` —— 这是一个真实的盲区。
  - 把 FFT 纳入任务数比对之前先手工对了一遍，发现计算器的 `fftTasks()` 只算了 mix 阶段，
    任务数少 2–4 倍（p8：32 vs 112，p10：32 vs 112）。按 `nChunks + (bits-l2Chunk)×nChunks/2` 补上后
    不再需要把 fft/fftjoinext 排除在 H2 之外，445/445 全对。
  - L2 增加逐 Worker **容量历史连续性**（`wasm_after(k) == wasm_before(k+1)`，28 条链全成立）、
    `alloc_base` 恒定、`grow_events[].len/top` 对账，以及
    `clone_buffer_bytes == allocset+set` 与 `wasm_alloc_bytes == sum(allocs)` 的双向交叉校验。
- **P2 清理**：删除 `m5_budget.cjs --json` 里调用已移除函数的旧分支（改为从 plan 派生）；
  删除死代码 `msmCall()`；`replayWorkerMemory()` 的基址由 0 改为实测 102,328 B（`ALLOC_BASE_MEASURED`）；
  删除 `scripts/m5d_attribution.cjs`（它的在途定义与容量时间线都错，由 `m5e_attribution.cjs` 取代）。
- **重跑**：p16 / p18 各 3 对交错（`results/raw/m5e/`），探针事件 50,178 / 60,960。
  L1 360/360、445/445；L2 16,582 / 20,145 任务、110 / 180 次 grow、0 fails；字节交叉校验 100%。
  p10 三模式各 5 次重测：`+2.3%`（换 bundle）/ `+8.9%`（写 JSONL），peak WS 仍不可分辨。
- **新增脚本**：`scripts/m5e_inflight.cjs`（在途离线重算，可直接跑 M5-D 旧日志，双窗口）、
  `scripts/m5e_attribution.cjs`（三线同轴 + 精确 C(t) + 结束下界）。
- **降级**：FFT 从"已排除为主因"改为"Worker 消息缓冲比 MSM 小两个数量级，但主线程副本与驻留生命周期未归因"。
- **没做的事**：不写优化代码、不改依赖、不跑 p20/p21、`m1-m2-frozen` 未动。
- **下一步**：残差仍未拆开。要拆它需要 `-HeapSampleMs` 时间序列 + 主线程 `array_buffers` 的寿命归因，
  而不是继续在静态模型上迭代。

---

## M5-E.2｜口径与时间线校准（2026-11-09，单轮验证）

- **触发**：M5-E.1 评审确认 `d375e41` 的探针确实把三种字节口径拆开、并补了 Worker 内部的 grow 时间戳，
  且 M5-E.1 撤回 M5-E"两者不同时在场"的结论**成立**；但评审又提出七处需修正（A–G）才能冻结归因报告。
- **范围边界（与用户确认）**：修完七处后，p16 / p18 **各只跑一轮必要验证**（`_e2_r1`），
  不扩展 power、不动算法、不写优化代码。
- **探针改动（对应评审项）**：
  - **A. 时间线对齐（epoch alignment）**：Windows `.NET Stopwatch`（采样器）与 Node
    `process.hrtime.bigint()`（探针）没有共同原点。新增 `start_epoch_ms`（timeline）+ `t0_epoch_ms`（anchor），
    把两组相对时钟换算到绝对 epoch 毫秒；探针侧标 `ws_alignment=epoch-aligned`。
  - **B. grow 时间戳前/后拆分**：`grow_events[]` 由单个 `t_hr` 改为 `t_hr_before`（调用 `memory.grow` **前**）、
    `t_hr`（=before，向后兼容）、`t_hr_after`（**后**）。L2 同时校验"落在任务窗口内"与"逐 Worker 单调"。
  - **C. WASM 缓冲脱钩保护**：`memory.grow()` 之后旧 `memory.buffer` 视图被**分离**，读 `u32[0]` 会得到
    `undefined`。改为在 grow **之前**先 `m5top = u32[0]` 捕获页顶。
  - **D. FFT chunks 计数顺序**：`ffd()` 在 `delete chunks[i]` **之前**计 chunks 数，避免少算；
    `fft_assembly` 事件补 `t_hr_start` / `t_hr_end`。
  - **E. 主线程 `_fft` 取时修复**：`_fft` 是模块级、跑在主线程，看不到 Worker 作用域的 `M5_HR`；
    改用 `process.hrtime.bigint()` 直接取时，才能和 Worker 内 grow 时间戳放同一根轴。
  - **F. PATCHES 计数修正**：`scripts/m5_build_vendor.cjs` 的 `PATCHES` 实为 **25** 处
    （P1–P22 后接 P24@731、P23@780、P24@794），文档原写"24"已改正。
  - **G. 运行标签统一**：M5-E.1 的 `_e1i_a1` / `_e1i_b1` 交错标签全部统一为单轮 `_e2_r1`，
    归因报告改写为"单轮验证运行（r1）"口径，不再并列三对。
- **L1 / L2 / 归因重跑（各一轮）**：
  - p18：探针事件 60,960；L1 445/445 调用、20,145 任务；L2 180 次 grow 逐条回放相等、0 fails、
    字节双向交叉校验 100%、`alloc_base` 全为 102,328 B。
  - p16：探针事件 50,178；L1 360/360 调用、16,582 任务；L2 110 次 grow 全部相等、0 fails、交叉校验 100%。
- **r1 关键数字**：
  - **p18**：在途峰 **987.4 MiB** @ t=14,805 ms（worker）/ 14,772 ms（post）；
    `C(t_peak)=1,465.5 MiB = 92.7%` 的 `C(final)=1,580.5 MiB`；最后一次 grow @ t=20,172 ms
    （在途峰后 **5,367 ms**）；`WS(end)−C(final)=269.8 MiB`（WS(end)=1,850.3，基线 −178.6）；
    clone 10,744.8 / WASM 11,051.2（+306.4）/ out 785.8 MiB；FFT 在途 13.5 MiB；
    `fft_assembly 16+16+16=48 MiB`；`chunks_bytes 16 MiB`（M5-E.1 误为 0）。
  - **p16**：在途峰 **265.1 MiB** @ t=4,210 ms（worker）/ 4,201 ms（post）；
    `C(t_peak)=400.9 MiB = 94%` 的 `C(final)=426.6 MiB`；最后一次 grow @ t=6,305 ms
    （在途峰后 **2,095 ms**）；`WS(end)−C(final)=485.7 MiB`（WS(end)=912.4，基线 40.8）；
    clone 3,025.2 / WASM 3,103.3（+78.1）/ out 197.5 MiB；FFT 在途 3.4 MiB；
    `fft_assembly 4+4+4=12 MiB`；`chunks_bytes 4 MiB`。
- **措辞变更（对应评审七处）**：
  - §0 结论：在途峰不再写"模型=实测 100%"，改为单一标量 987.4 / 265.1 MiB；
    同时性由"同时到顶"改为"**高度重叠，但各自极大值不在同一瞬间**"（92.7% / 94%，
    峰值后仍有 5.4 s / 2.1 s 才发生最后一次 grow，706 MiB 的差距正来自这段未闭合的扩容）；
    字节总量明确 `clone ≠ WASM`（10,744.8 vs 11,051.2，+306.4 / 3,025.2 vs 3,103.3，+78.1），
    out 785.8 / 197.5；残差只给单轮 269.8 / 485.7；FFT 13.5 MiB（非 14），chunks 0→16 MiB。
  - §7 H1：FFT 在途 13.5 / 3.4 MiB，主线程副本合计 48 / 12 MiB；H4：p18 结束残差下界 269.8 MiB（0.26 GiB），
    明确"仅作下界、不跨会话比绝对值"。
  - §8 运行标签 `_e1i_*` → 单轮 `_e2_r1`；"24 处断言式补丁" → "25 处"。
- **没做的事**：不写优化代码、不扩 power、不跑 p20/p21、`m1-m2-frozen` 未动；原始 trace 仍留本地，
  只入库 `.md` 归因（遵守 `.gitignore`）。
- **入库产物**：`scripts/` 探针改动、`vendor/ffjavascript-0.3.1-m5/`（重建）、
  `patches/m5-instrumentation.patch`、`M5_MANIFEST.json`、
  三份文档（`M5_ATTRIBUTION.md` / `M5_PROBE_DESIGN.md` / `EXPERIMENT_LOG.md`）、
  `results/processed/m5e_p1{6,8}_r1.md`。

---

## 冻结声明｜SRS 内存优化分支止于 M5-E.2（2026-11-09）

- **决定**：本分支（`experiment/m5-attribution`）于 **M5-E.2** 处**阶段性停止 / 冻结**。
  M5 的全部成果（探针、`L1`/`L2` 校验、单轮归因、三份文档）已入库并推送（`941c38f`），
  由标签 **`m5-freeze`** 锁定，**不再变更**。
- **不再做的事**：不再为"产出一个优化结果"而硬做下一步。具体红线：
  不写优化代码、不扩 power（不跑 p20/p21）、不动 `m1-m2-frozen`、不追加静态模型迭代、
  不做跨会话绝对秒数比较。
- **保留的可主张结论（来自 M5-E.2 单轮 r1）**：
  - 在途与容量**高度重叠但各自极大值错开**（p18 `C(t_peak)=92.7%` 终值，末次 grow 在峰值后 **5.4 s**；
    p16 `94%`，**2.1 s**）。M5-E"两者不同时在场"的判断已撤回，精确表述为"同处高位、非同刻达峰"。
  - 三种字节量**严格分开、互不相加**：`clone ≠ WASM`
    （p18 10,744.8 vs 11,051.2，+306.4；p16 3,025.2 vs 3,103.3，+78.1）；`out` 为 `GET` 实际拷贝
    （785.8 / 197.5 MiB）。
  - 结束残差只作**单轮下界**：p18 `WS(end)−C(final)=269.8 MiB`、p16 `485.7 MiB`，**不跨会话比绝对值**。
  - FFT 在途 13.5 / 3.4 MiB、主线程副本 `16+16+16=48` / `4+4+4=12 MiB`——**次要且未归因**，仅排除其为主因。
  - 主判据只能是逐 Worker 的 `allocs / grow_events / wasm_after`；**peak WS 跨会话不可比**（模式内极差 > 模式间差）。
- **未解问题（留作未来，不强行推进）**：
  - 结束残差仍未拆开，需 `-HeapSampleMs` 时间序列 + 主线程 `array_buffers` 寿命归因。
  - 扩容"何时对主线程可见"仍有 ±25 ms 轮询偏差，残差区间宽度来自此而非固定机制。
- **边界纪律**：所有数字要么来自探针，要么明确标注为"边界假设"；原始 trace 留本地，
  仅 `.md` 归因入库（遵守 `.gitignore`）。
