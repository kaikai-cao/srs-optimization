# srs-optimization

Research and engineering of compact, memory-efficient SRS representations for Groth16 and pairing-based SNARKs.

> 当前状态：**M1 / M2 已冻结**（2026-11-06），M2-B 为 R1–R4 修订版。
> 已完成：`.ptau` 容器全量审计（M1）、五类参数配对关系验证（M2-A）、
> 奇偶次幂 / 前半部分 / 间隔采样的恢复实验（M2-B，负面结果）。
> `crates/srs-stream` 仍为占位空壳；**未启动 M3，未跑 Power 21**。
> 详见 `docs/EXPERIMENT_LOG.md` 与各专题文档。

## 研究边界

- 曲线：BLS12-381；协议：Groth16；对象：**Phase 1 Powers of Tau 通用 CRS**，最大容量 $N = 2^{21} = 2{,}097{,}152$。
- 五类群元素：$P_i=[\tau^i]G_1$、$Q_i=[\tau^i]G_2$、$A_i=[\alpha\tau^i]G_1$、$B_i=[\beta\tau^i]G_1$、$B_2=[\beta]G_2$。
- 不研究 Sapling 电路专用参数；不把 Phase 2 的 Lagrange Evaluations（Sections 12–15）混入 Phase 1 原始 CRS 统计。

## 三条必须区分的收益

| 结果 | 存储压缩 | 内存优化 |
| --- | --- | --- |
| 实际减少群元素数量 | 是 | 通常是 |
| 不减少元素，只分块读取 | 否 | 是 |
| 数据放在其他服务器、本地按需获取 | 本地存储减少，系统总存储未必减少 | 是 |

## 必须坚持的原则

1. 不预设压缩方案可行。奇偶幂次、前半部分递推、间隔采样都必须完成「仅凭公开压缩文件逐点恢复」的测试；恢复不出 $G_1$ 点即判失败。
2. 不混淆不同层次的 CRS：Phase 1 通用 Powers of Tau ≠ Sapling 电路专用参数 ≠ Phase 2 Lagrange 参数。
3. 不把 mmap、分块读取、标准压缩、流式 MSM 等工程手段包装成密码学创新，必须与已有工作对照。
4. 正确性优先于性能：群元素一致性 → Setup 正确性 → 最终 Proof 验证。
5. 所有实验保留代码、配置、依赖版本、输入文件哈希与原始测量数据。
6. **不泄露陷门**：正式数学实验的 $\tau,\alpha,\beta$ 由 OS 熵生成且从不落盘；固定种子只允许出现在单元测试中。

## 目录结构

```
crates/ptau-audit     Phase 1 .ptau 容器审计：Section 扫描 / Header / 五类参数 / Contribution / SHA-256 / 异常测试
crates/srs-relations  代数关系验证 + 三进程压缩恢复实验（lib + 两个 bin）
crates/srs-stream     分块读取、流式 MSM 与峰值内存测试（占位，M4 起实现）
scripts/run_m2b.sh    M2-B 三进程编排：gen -> recover -> eval
data/fixtures/        测试用 .ptau（不入库）
results/raw/          原始测量数据：audit-*.json、m2_results.json、m2b/ 公开/恢复/oracle 文件（不入库）
results/processed/    整理后的结果（不入库）
docs/                 EXPERIMENT_LOG / CRS_STRUCTURE / ALGEBRAIC_RELATIONS / COMPRESSION_EXPERIMENTS
```

## 复现

```bash
# M1：扫描任意 Phase 1 .ptau（零 Cargo 依赖）
cargo run -p ptau-audit -- data/fixtures/pot10_0001.ptau --json results/raw/audit.json --negative-tests

# M2-B：三个独立进程（gen -> recover -> eval）
bash scripts/run_m2b.sh

# 全量自检
cargo fmt --all -- --check
cargo test --workspace
```

`scripts/run_m2b.sh` 每次运行都会产生一份**新的 OS 熵**公开数据集；引用某次实验时以
`public_dataset_sha256` 与 `results/raw/m2_results.json` 为准，不要用种子复现。

## 数据与产物

`*.ptau`、`*.bin`、`*.zkey`、`*.wtns` 一律不提交 GitHub；只提交代码、配置、输入文件哈希与实验报告。
`data/fixtures/`、`results/raw/`、`results/processed/` 仅保留 `.gitkeep` 以固定目录结构。

测试 CRS 仅用于实验，**不得用于生产证明，也不属于任何真实可信仪式的结果**。
M2-B 的恢复失败结论只否定本轮实际实现的恢复方法，不宣称证明所有代数压缩都不可能。
