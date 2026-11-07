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
- **FastFile 页面池实测（非估算）**：p16 1690 页 × 8 KiB = 13.2 MiB；p18 6759 页 × 8 KiB = 52.8 MiB。
  每次 `capacity == held` 且 `avBuffs = 0`（峰值时所有已分配页缓冲都是活映射页，不存在“仅容量”虚增）。
  池随输入 O(N) 线性增长（4× 数据 → 4× 池），但仅占峰值 0.79% / 1.45%。
  **M3 的 422 MiB 只适用于 `prepare_phase2` 的 384 MiB 单次读入，不适用于 prepared_verify**——实测已证实。
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
