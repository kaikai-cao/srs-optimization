# srs-optimization

Research and engineering of compact, memory-efficient SRS representations for Groth16 and pairing-based SNARKs.

> 当前状态：**M0 工程初始化**（对应实验计划第十一部分）。
> 仓库只包含目录骨架、依赖锁定、`.gitignore` 与测试 CRS 生成所需配置。
> `ptau-audit` / `srs-relations` / `srs-stream` 目前是 `cargo new` 生成的空壳，**尚未实现任何解析、代数或 MSM 代码**。

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

## 目录结构

```
crates/ptau-audit     Phase 1 .ptau 容器结构审计（读取/统计/校验，不做压缩）
crates/srs-relations  五类参数的代数关系与压缩假设验证
crates/srs-stream     分块读取、流式 MSM 与峰值内存测试
scripts/              生成/验证/基准脚本（按里程碑逐步实现）
configs/              实验配置（M0 之后建立）
data/fixtures/        测试用 .ptau（不入库）
results/raw/          原始测量数据（不入库）
results/processed/    整理后的结果（不入库）
docs/                 结构、代数、实验设计与结果文档
```

## 数据与产物

`*.ptau`、`*.bin`、`*.zkey`、`*.wtns` 一律不提交 GitHub；只提交代码、配置、输入文件哈希与实验报告。
`data/fixtures/`、`results/raw/`、`results/processed/` 仅保留 `.gitkeep` 以固定目录结构。

测试 CRS 仅用于实验，**不得用于生产证明，也不属于任何真实可信仪式的结果**。
