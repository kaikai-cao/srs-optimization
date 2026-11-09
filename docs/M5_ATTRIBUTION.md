# M5 归因报告（M5-E.1，取代 M5-E）

本文件回答一个问题：**p16 / p18 的 `prepared_verify` 峰值工作集，有多少能被逐 Worker 的分配史解释。**

数据来自 `results/raw/m5e/` 下 p16 / p18 各 3 次 `pristine` + 3 次 `trace` 交错运行（探针 v2，M5-E.1）。
每次 trace 都过 L1（调用序列 + `site`/`group`/`s_g` 身份）与 L2（逐 Worker 零容差回放 + 容量历史连续性）。
汇总在 `results/processed/m5e_p1{6,8}_r{1,2,3}.md`（入库；同名 `.json` 留在本地，`.gitignore` 只豁免 `.md`）。

> **与 M5-E 的关系**：容量池模型仍然站得住（页级整数、逐 Worker 分布逐项相等）；在途峰值也能复现到
> 0.1 MiB，但两者差一个 Jacobian 输出，**不能称为逐字节相等**（§2）。M5-E 最重要的那句话
> ——"在途峰值与容量峰值不同时发生"——**是错的**，原因是它把 `memory.grow` 的时间记成了任务完成时间。
> 加上真实 grow 时间戳后，在途峰值那一刻容量已达终值的 **93.9%（p18）/ 94.8%（p16）**，两者**确实同时在场**。
> 同时，`send_bytes` 把三种不同口径的字节加在了一起，本文件全部重算。

---

## 0. 结论摘要

1. **在途峰值（结构化克隆字节）是 932.6–987.4 MiB（p18）/ 244.6–265.1 MiB（p16），区间只来自窗口定义**。
   下端 = 只在 Worker 真正执行该任务期间计入（`t_hr_start..t_hr_end`）；上端 = 从 `postMessage` 到主线程收到回复
   （包含排队期）。峰值 100% 来自 `tauG1_19_transformed`（p16 为 `tauG1_17_transformed`）。
   静态账本给的是上端 987.4 / 265.1，与实测吻合到 0.1 MiB；但**不能称为逐字节相等**——MSM 路径上每任务还差
   一个 Jacobian 输出（G1 144 B / G2 288 B，28 任务共 4,032 B），在一位小数下不可分辨。而且它是上端，不是唯一值。
2. **容量终值精确命中，逐 Worker 分布也精确命中**：p18 **25,288 页 = 1,580.5 MiB**（20×1044 + 8×551），
   p16 **6,826 页 = 426.6 MiB**（22×276 + 2×153 + 4×112）。L2 在 20,145 / 16,582 个任务、180 / 110 次
   `memory.grow` 上零容差通过，并且**逐 Worker 的 `wasm_after(k) == wasm_before(k+1)` 全部成立**（28 条完整链）。
3. **在途与容量同时到顶，"不同时"的说法撤回**：p18 在途峰在 `t = 21.7 s`，那一刻 `C(t) = 1,484.4 MiB`，
   为终值的 **93.9%**；p16 在 `t = 6.9 s`，`C(t) = 404.4 MiB`，为终值的 **94.8%**。
   剩余的 6–5% 是在途回落之后由 `tauG2` 的 `resLagrange @ 2^18` 补上的（那时仍有 760 MiB 在途）。
   M5-E 写的 778.3 MiB 是"主线程已收到增长报告"的容量，比真实容量低 **706 MiB**。
4. **口径修正后的三个字节量必须分开读**：p18 全程 clone 10,745 MiB、Worker WASM 分配 10,745 MiB、
   Worker 回传 486 MiB；M5-D 的 `send_bytes` 把 `ALLOC` 与 `GET` 也算进"发送"，使 batch 路径虚高 **3.0×**、
   FFT 路径虚高 **2.2×**。MSM 路径只差一个 Jacobian（每任务 144/288 B），所以 987.4 这个数**看起来**没变。
5. **结束残差只能给下界，而且下界比 M5-E 报的更宽**：在最后一个任务完成的时刻（`in-flight = 0`，
   Worker 池尚未销毁），`WS(end) − C(final)` = p18 **829 / 957 / 1,184 MiB**、p16 **1,111 / 1,147 / 1,218 MiB**。
   这是"不可能属于 Worker WASM 地址空间"的部分；它**不等于**碎片，也不**等于**泄漏。
6. **FFT 不再是"已排除"，只是"次要"**：p18 的 FFT 在途峰值 **14 MiB**（旧口径 42 MiB），
   占在途峰的 1.5%；但 `_fft` 内部还有 16 MiB 输入副本 + 16 MiB 输出，且这段生命周期**没有被建模**。
   正确的说法是：**FFT 的 Worker 消息缓冲区比 MSM 主路径小两个数量级，但它的主线程副本与驻留生命周期尚未归因。**

---

## 1. 数据与门槛

| 项 | p16 | p18 |
| --- | ---: | ---: |
| fixture | `pot16_final.ptau` | `pot18_final.ptau` |
| 运行次数 | 3 pristine + 3 trace（a/b 交错） | 同左 |
| 探针事件 | 50,178 / 次 | 60,960 / 次 |
| 任务数 / 调用数 | 16,582 / 360 | 20,145 / 445 |
| `memory.grow` 事件 | 110 | 180 |
| `alloc_base` | 102,328 B（每个任务的每个 Worker 一致） | 102,328 B |
| L1（几何 + 身份） | PASS 360/360，`site` 360/360，`group`/`s_g` 148/360 | PASS 445/445，`site` 445/445，`group`/`s_g` 194/445 |
| L2（回放 + 连续性） | PASS，0 fails，28 条历史链 | PASS，0 fails，28 条历史链 |
| L2 字节交叉校验 | 16,582/16,582 | 20,145/20,145 |
| peak WS，pristine | 1,636.5 / 1,656.9 / 1,571.0 | 3,687.0 / 3,640.5 / 3,883.8 |
| peak WS，trace | 1,646.2 / 1,616.0 / 1,625.0 | 3,675.6 / 3,861.1 / 3,741.1 |
| 耗时，pristine | 12.7 / 13.7 / 13.8 s | 42.6 / 43.4 / 42.5 s |
| 耗时，trace | 13.3 / 13.4 / 13.9 s | 42.8 / 43.3 / 60.5 s（一次离群） |

`group` / `s_g` 只在 MSM 调用上可比（batch 与 fft 的计划事件不带群信息），所以分母是 MSM 调用数。
`alloc_base` 与 `site` 的比对是 L1 的新增项：M5-E 的"在途峰 100% 来自 `tauG1_19_transformed`"依赖 `site`，
而旧 L1 不比 `site`、`group`、`s_g`，一个 section 或群组的错标可以静默通过。

**peak WS 用哪个口径**：本表取 `peak_working_set_mib`（进程报告的峰值工作集），不是采样序列的最大值
`current_ws_max_mib`——25 ms 轮询会漏掉尖峰，两者相差 3–34 MiB（trace p16 r2 差 12.8，p18 a3 差 34.0）。
§3 与 §5 里的 `WS(t)` 则是**采样值**，因为它们要与同刻的 `C(t)` 对齐；三个口径不要互相代入。

**探针扰动**：两档的 trace 与 pristine 的 peak WS 区间完全重叠、耗时的中位数差 < 3%。
p10 上单独测得的写盘成本仍是 **+8.9%**（见 `M5_PROBE_DESIGN` §5.9），在 13 s / 43 s 的运行里被摊薄。
本文件的归因不依赖"探针无扰动"，而依赖探针事件的完备性——那是 L1/L2 可以证明的。

---

## 2. 三种字节量，不能相加

旧探针的 `payloadBytes()` 把 `ALLOCSET`、`SET`、`ALLOC`、`GET` 四个命令的长度加成一个 `send_bytes`。
其中只有前两个是真正被结构化克隆过去的缓冲区：

| 命令 | 跨线程克隆 | Worker WASM 分配 | Worker 回传 |
| --- | :---: | :---: | :---: |
| `ALLOCSET var, buff` | ✔ `buff.byteLength` | ✔ `buff.byteLength`（`allocBuffer` = `alloc` + `set`） | |
| `SET var, buff` | ✔ `buff.byteLength` | | |
| `ALLOC var, len` | | ✔ `len` | |
| `GET out, var, len` | | | ✔ `len`（真实副本是 `out_bytes`） |

因此：

```
clone_buffer_bytes = ALLOCSET + SET          # 主线程交出去的那份
wasm_alloc_bytes   = ALLOCSET + ALLOC        # Worker 线性内存里的预留
worker_output_bytes= GET                     # 回传请求；真实拷贝 = out_bytes
```

`wasm_alloc_bytes` 必须与 `sum(worker_task.allocs)` 相等——两者由完全独立的代码路径产生
（主线程扫命令 vs Worker 侧 `alloc()` 计数），L2 现已把它当作硬门，20,145 / 16,582 全部相等。

修正的量级（p18 全程，按任务累加，不是峰值）：

| kind | 任务 | clone | 旧口径 | 虚高 |
| --- | ---: | ---: | ---: | ---: |
| msm | 10,957 | 9,960.6 MiB | 9,964.4 MiB | 1.00× |
| batch | 3,792 | 304 MiB | 912 MiB | **3.00×** |
| fft | 5,372 | 480.2 MiB | 1,040.1 MiB | **2.17×** |

MSM 只差一个 Jacobian（每任务 144 B / 288 B），所以在 987.4 MiB 的量级上"看起来没变"——
这正是 M5-E 没有察觉的原因。batch 与 FFT 的任务是 `ALLOC + SET + GET` **同一个缓冲区**，
三个长度相加刚好是 3× 与 2.17×。

---

## 3. 三条时间线在同一个时钟上

`memory.grow` 的时间戳现在记在 `alloc()` 内部（`grow_events[].t_hr`），与主线程共用
`process.hrtime.bigint()`（跨 Worker 线程同源，原点写在 `anchor.t0_hr`）。
于是容量不再是"按任务近似"，而是一条**精确的阶梯函数**：

```
C(t) = 28 × 25 pages × 64 KiB + 64 KiB × |{ g : t_grow(g) ≤ t }|
```

p18 首次运行（`_e1i_b1`）的同刻读数：

| 时刻 | 事件 | in-flight (clone) | C(t) | WS(t) |
| --- | --- | ---: | ---: | ---: |
| 21,564 ms | post 窗口在途峰 | 987.4 MiB | 1,484.4 MiB | 3,425 MiB |
| 21,738 ms | worker 窗口在途峰 | 932.6 MiB | 1,484.4 MiB | 3,425 MiB |
| 31,252 ms | 最后一次 `memory.grow` | 760.0 MiB | 1,580.5 MiB | 3,278 MiB |
| 42,519 ms | 最后一个任务完成（`in-flight` 归零） | 0 | 1,580.5 MiB | 2,814 MiB |
| 42,559 ms | 归零后 40 ms 的采样点（§5 取此点） | 0 | 1,580.5 MiB | 2,764 MiB |

p16 同口径：在途峰 6,902 ms，`C(t) = 404.4`（终值 426.6），WS 1,266 MiB；
最后一次 grow 在 9,719 ms，当时仍有 220 MiB 在途。

三次运行的**探针量完全相同**（在途、容量、grow 次数、逐 Worker 页数），只有 WS 每次不同
（**在途峰时刻**的 WS：p18 3,425 / 3,394 / 3,428 MiB，p16 1,266 / 1,284 / 1,319 MiB）。
这个对比本身就是结论：WS 的波动来自被测进程，而不是探针记录的内容。

---

## 4. 同时性：修正后成立

M5-E 说"在途峰时容量只有 778.3 MiB，所以两者不同时在场"。778.3 MiB 是把 grow 记在**任务完成**时刻
得到的——它统计的是"主线程已经收到增长报告"的容量。真实容量在 21.7 s 时已经是 **1,484.4 MiB**：

| power | in-flight 峰 | C(t_peak) | C 终值 | C(t_peak)/C 终值 |
| --- | ---: | ---: | ---: | ---: |
| p18 | 932.6（post 987.4） | **1,484.4** | 1,580.5 | **93.9%** |
| p16 | 244.6（post 265.1） | **404.4** | 426.6 | **94.8%** |

所以正确的表述是：

> 在途峰值与容量峰值**同时发生**。容量在那一刻已达终值的 94%，剩下的 6% 由 `tauG2` 的
> `resLagrange @ 2^18` 在在途回落过程中补上——补的时候仍有 760 MiB 在途。

这也解释了 M5-E 为什么得出相反结论：它把 706 MiB 的容量记到了错误的时间点上。
**"把在途与容量相加当峰值预测"这个做法仍然是错的**，但错的原因不是"不同时"，
而是二者在峰值时刻**同时**处于高位、相加会重复计算同一批 Worker 的地址空间与其中的缓冲区。

---

## 5. 结束残差：只能给下界

`in-flight = 0` 的时刻只有一个，就是最后一个任务完成之后、Worker 池被销毁之前。
采样器在 `terminate()` 之后还会继续轮询，那几百毫秒里 WS 从 2,714 掉到 207 MiB，必须排除。
选取规则是"最后一个任务完成时刻之后 60 ms 窗口内的最后一个样本"（25 ms 轮询，实际落在 +40 ms）；
之所以不取完成那一刻，是因为轮询不一定正好落在该毫秒上。

下表每个数都可在 `results/processed/m5e_p1{6,8}_r{1,2,3}.md` 第 4 节逐项核对。

| power | WS(end) | C(final) | **WS(end) − C(final)** | 减掉进程基线 |
| --- | ---: | ---: | ---: | ---: |
| p18 r1 | 2,764.0 | 1,580.5 | **1,183.5** | 743.3 |
| p18 r2 | 2,537.1 | 1,580.5 | **956.6** | 511.7 |
| p18 r3 | 2,409.7 | 1,580.5 | **829.2** | 389.0 |
| p16 r1 | 1,645.0 | 426.6 | **1,218.3** | 777.3 |
| p16 r2 | 1,537.8 | 426.6 | **1,111.2** | 669.5 |
| p16 r3 | 1,573.2 | 426.6 | **1,146.6** | 706.6 |

读法：

- 这是**下界**。Worker WASM 的驻留页不可能超过它的地址空间容量，所以
  `WS − C(final)` 只可能低估"不属于 Worker WASM"的部分。
- 它**没有名字**。主线程持有的大缓冲（`buffG`、`buff_r`、`BigBuffer` 页、FastFile 缓存）、
  未回收的 V8 堆、snarkjs 自己的中间数组都在这一个数里。
- 三次之间相差 354 MiB（p18）而探针量完全相同 ⇒ 其中有相当一部分是进程级可变开销，
  **不能归给某个固定机制**。

M5-E 报的 "≥0.85 GiB / ≥0.79 GiB" 与新值同量级（p18 0.81–1.16 GiB、p16 1.09–1.19 GiB），
但当时的口径把残差算在了**在途峰**上，那是错的；现在只在 `in-flight = 0` 的时刻计算。

---

## 6. FFT：从"排除"降级为"次要但未归因"

| 量 | p18 | p16 |
| --- | ---: | ---: |
| FFT 在途峰（clone，新口径） | 14 MiB | 2.6 MiB |
| FFT 在途峰（旧 `send_bytes`） | 42 MiB | 10.5 MiB |
| `_fft` 主线程一次性副本（`fft_assembly`） | 16 MiB 输入 + 16 MiB 输出 | 4 + 4 MiB |
| 在途峰中的占比 | 1.5% | 1.1% |

Worker 消息缓冲区确实比 MSM 主路径小两个数量级，这一条成立。
但"排除 FFT 对 Working Set 的贡献"**不成立**：`_fft` 在**主线程**上还有
`buff`（输入）、`chunks[]`（分片结果）、`buffOut`（输出）三份数据，生命周期跨越整个 FFT 调用，
本文件的在途量**不包含**它们。它们的驻留时间与峰值叠加方式尚未建模。

---

## 7. 四个假设的重判

| 假设 | 判定 | 依据 |
| --- | --- | --- |
| **H1**：FFT 输入副本是 Working Set 主因 | **主因不成立，贡献未定量** | FFT 在途 14 MiB，主线程副本合计 32 MiB；相对 1.5–3.4 GiB 的 WS 是 1–2% |
| **H2**：Worker 容量 ≈ 2× 首个大分片，结束后不回落 | **成立** | 首个 tauG1 大分片轮：19 个 Worker @**989 页** = `floor((102,328 + 2×32,356,032)/65,536)+1`，另 9 个 @551；L2 逐 Worker 精确复现，且连续性证明不回落 |
| **H3**：并发度是峰值的一阶因素 | **成立但已被容量模型吸收** | 在途峰 = Σ(前 28 个任务的 clone)，与并发度线性相关；容量池也按 Worker 数线性 |
| **H4**：`prepare_phase2` 的峰值主体无法由单次分配解释 | **本题未检验** | p18 结束时 0.81–1.16 GiB 的容量外残差给出了同类现象的下界 |

---

## 8. 复现

```bash
# 1. 探针（vendor 副本，24 处断言式补丁）
node scripts/m5_build_vendor.cjs --force

# 2. 交错 A/B，3 对
pwsh -File scripts/measure_m5.ps1 -Operation prepared_verify -Power 18 \
     -InputPath data/fixtures/pot18_final.ptau -Mode pristine -Repeats 1 \
     -RunTag "_e1i_a1" -ResultsDir results/raw/m5e -LogDir results/raw/m5e/logs
pwsh -File scripts/measure_m5.ps1 -Operation prepared_verify -Power 18 \
     -InputPath data/fixtures/pot18_final.ptau -Mode trace -Repeats 1 \
     -RunTag "_e1i_b1" -ResultsDir results/raw/m5e -LogDir results/raw/m5e/logs

# 3. 门槛
node scripts/m5_budget.cjs --power 18 --operation plan --base 102328 > results/raw/_m5_plan_p18.json
node scripts/m5_check_l1.cjs --plan results/raw/_m5_plan_p18.json --jsonl <trace>.jsonl
node scripts/m5_check_l2.cjs --jsonl <trace>.jsonl

# 4. 归因（同一时钟上的三条线）
node scripts/m5e_attribution.cjs --jsonl <trace>.jsonl --run <run>.json \
     --timeline <trace>.timeline.json --out results/processed/m5e_p18_r1

# 5. 只看在途口径（可在 M5-D 的旧日志上直接跑）
node scripts/m5e_inflight.cjs --jsonl <trace>.jsonl
```

`--out` 是**前缀**，脚本写出 `<prefix>.md` 与 `<prefix>.json`。三个输入缺 `--timeline` 时
WS 相关行写成 `n/a` 而不是 0，产物第 3 行会打印 `inputs jsonl=yes run=… timeline=…`，
所以每份 `results/processed/m5e_*.md` 都能自证是由哪几个输入生成的。`.md` 入库、`.json`
与 `.jsonl` 留在本地（`.gitignore` 只豁免 `results/processed/m5*.md`）。
