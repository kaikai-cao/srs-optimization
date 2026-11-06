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
