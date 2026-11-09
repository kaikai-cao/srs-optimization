# M5 内存归因：探针设计与源码分配路径审计（M5-A.2）

- **状态**：A.2 修订稿（评审稿）。评审通过后才进入 M5-B 实现。
- **分支**：`experiment/m5-attribution`（未合入 `main`）。
- **基线**：`main @ 24a0dd3`；`ffjavascript 0.3.1`、`snarkjs 0.7.6`、`Node v22.22.2`、Windows、28 逻辑核。
- **本文件不含**：任何依赖改动、任何计算逻辑改动、任何新的实验数据。
- **配套工具**：`scripts/m5_budget.cjs`（纯静态算术，不插桩、不启动 snarkjs，用于复算本文件的账本）。

> 一句话定位：M4.1 测到的是"阶段区间内 Working Set 涨了 2.2 GiB"；M5 要把它拆成"哪一次分配、多少字节、活到什么时候"。
> 本文件先把源码里**必然发生**的复制点定死，再给出可被证伪的字节预算，最后定义能证实/推翻它的探针。

---

## 0. A.1 修订对照（相对 `e2bb900`）

| # | A 稿 | A.1 稿 | 依据 |
| --- | --- | --- | --- |
| 1 | 把 `tauG1` 的 MSM 当成一条 32 B 标量账目 | **拆成三条**：`processSection`（4 B）、`resTau`（4 B）、`resLagrange`（32 B） | `powersoftau_verify.js:361 / 425 / 454` |
| 2 | Phase 1 存量 **223 MiB**（按 32 B、22 bit-chunk、2 point-chunk） | **72.4 MiB**（4 B、3 bit-chunk、10 point-chunk，G2 段把 Worker 扩到 42 页） | `:361` + `:112-137` |
| 3 | "模型解释 98%，误差 2%" | **撤回**。改后模型段增量 2351 MiB 对实测 2160 MiB，**高出 8.9%** | §5.6（**"上界"身份已被 A.2 推翻**，见 §0.1 第 6 条） |
| 4 | 用"模型共存峰值"直接减"全程峰值" | **删除该比较**（不同相位不可比）。改为同窗口锚定：起始 current WS + 模型增量 | §5.6 |
| 5 | F14 写"p18 时 32 chunk × 8192 点" | **32 chunk × 16384 点**（`2^19/2^14`）；8192 是 `2^18` 的情形 | `engine_fft.js:13` |
| 6 | MB 与 MiB 混用（16.8 / 50.3） | 全文统一 **MiB**；`2^19×32 = 16 MiB`、`2^19×96 = 48 MiB` | —— |
| 7 | `prepare_phase2` 残差解释为"碎片/未释放" | 降级为**未解释残差**，不作机制断言 | §5.5、§10.6 |
| 8 | 验收门"探针值落在模型值 70%–100%" | **删除**。改为三层：切分逐字段相等 / 逐 Worker 页数对账 / 同刻四量对比 | §7.6 |

### 0.1 A.2 修订对照（相对 `dd51f3e`）

| # | A.1 稿 | A.2 稿 | 依据 |
| --- | --- | --- | --- |
| 1 | 账目只到 A（`processSection`）/ B（`resTau`）/ C（`resLagrange`） | **新增账目 D：`Fr.batchTo/FromMontgomery`**。p18 每个干净 Worker 被两次分配推到 **28 页**，28 个 Worker 合计 **49 MiB**；p16 不扩容 | `engine_batchconvert.js:23-32`；`wasm_field1.js:71` |
| 2 | HYP-1 只写"基址取 0（未实测）" | 明确为**下界假设**：真实基址只会**抬高**容量，不会降低；不参与任何"预测"表述 | §5.0 |
| 3 | HYP-2 以"大分片优先分配到不同 Worker"计算 | 明确**只用于构造上界，不代表实际调度顺序**；实际归属必须由 `worker_task.worker` 实测 | §5.0 |
| 4 | L2 允许"基址偏移的整页差" | **删除容差**。改为按事件顺序**逐 Worker 精确回放**，页数必须**逐一相等** | §7.6 |
| 5 | 同窗绝对量 `776 + 2351 = 3127` 对实测 2936，称 6.5% | **删除该相加比较**。在途字节 / WASM 容量 / Working Set 三者量纲不同，**不得相加当 WS 预测**；改为同刻并列 + 显式残差 | §5.6、§10.9 |
| 6 | 用**单次** `+2160 MiB` 代表"实测段增量"，并称模型"高出 8.9%、仍是上界" | **改为三次并列**：p18 `+2160/+2487/+2636`（均值 2428），p16 `+194/+207/+238`（均值 213）。p18 模型 0.97×（**低于**均值）、p16 2.8×（远高于），**方向相反 → "上界"不成立**；离散 ±10% 已大于模型偏差，**该比较不能判定模型对错** | §5.6；`m4_1_*_p1x_r{1,2,3}.json` 阶段标记 |
| 7 | §5.1 只列 4 个 phase-1 section | 补 **`betaG2`**（1 点，`processSectionBetaG2` 读 192 B 后 `fromRprLEM`/`toRprUncompressed`，**无 MSM、无 Worker、无 WASM 分配**） | `powersoftau_verify.js:316-338` |
| 8 | 未说明 phase 2 的四个 section 如何共享容量 | 补 M4.1 实测旁证：tauG1 段 +2160（r1）之后，tauG2/alphaTauG1/betaTauG1 只各 +266 / +230（r1），说明**容量被复用而非重新增长** | §5.6.1 |

---

### 0.2 评审勘误（M5-B 实施期补正，**不构成新修订**）

按评审裁定，A.2 直接通过，不再另开 A.3。下列五处属**文本与算术勘误**，在实施 M5-B 的同时就地改正：

| # | A.2 的写法 | 勘误后 | 依据 |
| --- | --- | --- | --- |
| 1 | 账目 D 记为"容量历史点（28 页/Worker、49 MiB）" | **独立冷启动容量预算**：本次运行 `grow` 次数 = 0、容量增量 = 0；49 MiB 只在"从 25 页起跑"时成立 | §5.4、§10.10 |
| 2 | §5.6.1 "tauG1 把 28 个 Worker 推到 988 页" | **18 个 @988 + 10 个 @549**（2 个 point-chunk：337,042 / 187,246 点） | §5.6.1 |
| 3 | "tauG2 +55 页/Worker ≈ +96 MiB" | **`18×55 + 494 = 1,484` 页 = 92.75 MiB**（单 Worker 最大页数与池增量是两个量） | §5.6.1 |
| 4 | HYP-2 = "最坏归属上界" | 首轮映射是 `processWorks()` 顺序扫描的**推论**（workers `0..C-1`），迟到任务已证明无增长 → 升级为**条件于点预测** | §5.0.1、§10.3 |
| 5 | 主线程"64 MiB 同时存活" | 降级为**假设 P-1**：`slice()` 复制是必然（16 MiB/次），四者同时存活需探针判定 | §5.4、§10.12 |

另：§5.6 结论措辞由"同量级且噪声大于信号"改为**"现有测量尚不能验证静态模型的准确性"**（三次样本不足以支持统计表述）。

---

## 1. 结论摘要（给评审的 8 条）

1. **must-fix 已修**：`snarkjs` 在三个地方喂不同宽度的标量——`processSection` 4 B、`resTau` 4 B、`resLagrange` 32 B。
   A 稿把 32 B 的位块放大（18 个 bit-chunk）套到了全部 MSM 上，导致 Phase 1 基线与"2% 吻合"两个结论都不成立。
2. **位块放大机制本身成立，但只对 32 B 路径成立**：p18 的 `resLagrange` 在 `2^19` 点上仍是 18 bit-chunk × 2 point-chunk
   = 36 任务、单任务 41.1 MiB、在途 969 MiB；而同一次 `verifyPower(19)` 里先跑的 `resTau`（4 B）只有 3 bit-chunk ×
   10 point-chunk = 30 任务、单任务 5.4 MiB、在途 146 MiB。
3. **Worker WASM 的双倍余量机制成立**（`alloc()` 把 `length` 加了两次）。但"1455 MiB"这个数字 A.2 曾写成
   "按大分片优先分配的上界"，其实**比那更强**：`processWorks()` 从 0 号 Worker 顺序取空闲
   （`threadman.js:191-198`），`_multiExpChunk()` 在 `await` 前把整批位块任务同步入队，所以**首轮 28 个任务
   就是 workers 0..27**，容量分布是确定的 `18×988 + 10×549`，不是排序取最坏。剩余任务（迟到任务）
   在 §4 被证明"任何 Worker 都吃得下"，故**总和与调度顺序无关**。唯一未定的是 `alloc_base`（HYP-1）。
4. **Phase 1 基线重算为 72.4 MiB**，驱动项不是 G1 而是 **G2 的 `tauG2` 段**（`65535×192×2 > 25 页` → 扩到 42 页）。
   扣除后的模型段增量 = 969.1 +（1454.6 − 72.4）= **2351 MiB**。
5. **单次引用 +2160 MiB 不可靠，模型也不是统一上界**（A.2 新发现）：p18 三个 run 的 tauG1 段增量分别是
   **+2160 / +2487 / +2636**（均值 2428，极差 476 = ±10%），模型 2351 落在区间内（0.97×）；
   p16 三次是 **+194 / +207 / +238**（均值 213），模型 591.5 为 **2.8×**。
   两个 power 的偏差方向相反，**所以"上界"这个身份也不成立**——三次实测的离散已经大于模型与实测的差，
   这个比较**不能用来判定模型对错**（§5.6）。
6. **原 H1（FFT 输入副本）在 `prepared_verify @ p18` 上只有约 48 MiB**（16 输入副本 + 16 分片 + 16 输出），
   相对 MSM 的 969 + 1455 可忽略；`prepare_phase2` 相反，FFT 才是主路径，但它与实测的残差目前**无法解释**，
   只能说"模型漏了东西"，不能断言是碎片。
7. **账目 D（`Fr.batchTo/FromMontgomery`）此前漏记，现已补上，但它是"冷启动预算"而非本次扩容**：
   每个 chunk 做**两次**分配（`ALLOCSET` 599,168 B + `ALLOC` 599,168 B），若从 25 页起跑会被
   `alloc()` 的双计推到 **28 页/Worker**（28 个合计 **49.0 MiB**）；但它在同一次 `verifyPower` 里
   **晚于** `resTau`，届时 Worker 已是 165 / 55 页（p18）或 42 / 25 页（p16），所以**本次 grow 次数 = 0、
   容量增量 = 0**。它必须被记录，但不得写成"49 MiB 增量"。
8. **容量池要按"单 Worker 最大页数"与"池增量"两个层次读**：tauG1 的 `resLagrange@2^19` 留下
   `18×988 + 10×549 = 23,274` 页（1454.6 MiB）；tauG2 的 `resLagrange@2^18` 把 18 个 Worker 从 988
   抬到 1043（各 +55）、把第 19 个从 549 抬到 1043（+494），**池增量 1,484 页 = 92.75 MiB**。
   写成"28 个 Worker 各 +55 页 ≈ 96 MiB"会多算 3.5 MiB 且归属错误。

---

## 2. 审计方法与事实表

逐文件逐行读 `node_modules/ffjavascript`（0.3.1）与 `node_modules/snarkjs`（0.7.6）的**实际安装内容**。

| 编号 | 位置 | 事实 | 后果 |
| --- | --- | --- | --- |
| F1 | `threadman.js:21` | `MEM_SIZE = 25` 页（1.5625 MiB） | 首次大 ALLOCSET 必然触发 `memory.grow` |
| F2 | `threadman.js:104-119` | `concurrency = os.cpus().length`，上限 64 | 本机 = **28** 个 Worker、28 份独立线性内存 |
| F3 | `threadman_thread.js:4` | `MAXMEM = 32767` 页 | 单 Worker 上限 2 GiB |
| F4 | `threadman_thread.js:44-56` | `alloc()` 判据写成 `u32[0] + length > byteLength`，而 `u32[0]` 已 `+= length` | 实际要求 `byteLength ≥ top + 2·length` → 首个大分片使容量≈2× |
| F5 | `threadman_thread.js:58-62, 86-87` | `ALLOCSET` = `alloc` + `u8.set(整个 buffer)` | 消息克隆之外**再**复制一份进 WASM |
| F6 | `threadman_thread.js:108-110` | `GET` 用 `.slice()` 拷出 | 每次 MSM 任务一个 144 B 的 G1 结果 |
| F7 | `threadman_thread.js:115-117` | 任务结束只 `u32b[0] = oldAlloc` | 不缩容；Worker 容量是**单调高水位** |
| F8 | `threadman.js:196-213` | `queueAction` → `processWorks` → `postAction`，`transfers` 未传 | 点数据走结构化克隆 |
| F9 | `threadman.js:121-140` | 启动时 `postAction(..., [copyCode.buffer])` | 全路径**唯一**的 transfer list |
| F10 | `engine_multiexp.js:112-120` | `sScalar = floor(scalars.byteLength / nPoints)`；`bitChunk = pTSizes[log2(nPoints)]`；`nBitChunks = floor((8·sScalar−1)/bitChunk)+1` | 标量宽度**直接决定**位块数：4 B→3，32 B→18 |
| F11 | `engine_multiexp.js:122-137` | `chunkSize = floor(nPoints / (concurrency / nBitChunks))`，钳在 `[2^10, 2^22]`；每个 point-chunk 起 1 次 slice，`nBitChunks` 个任务共享它 | 位块数越大，point-chunk 越大，单任务载荷越大 |
| F12 | `engine_multiexp.js:131-132` | `buffBases.slice()` / `buffScalars.slice()` | 每块 1 次真复制（不是每任务 1 次） |
| F13 | `powersoftau_verify.js:361` | `scalars = getRandomBytes(4*(n-1))` | **Phase 1 标量是 4 B**，不是 32 B |
| F14 | `powersoftau_verify.js:371-372` | 每个 64 Ki 点分片跑**两次** MSM，各 `(n-1)` 点，顺序 await | Phase 1 的在途量按单次调用算，不相加 |
| F15 | `powersoftau_verify.js:425, 439` | `buff_r = new Uint32Array(nPoints)` 再转 `Uint8Array` | **`resTau` 标量 4 B**（`:452`） |
| F16 | `powersoftau_verify.js:454, 470-474` | `buff_r = new BigBuffer(nPoints*Fr.n8)`，经 batchToMontgomery → **fft** → batchFromMontgomery | **`resLagrange` 标量 32 B**（`:482`），且同一次迭代内还有一次全域 FFT |
| F17 | `engine_fft.js:13, 109-115` | `MAX_BITS_THREAD = 14`，且 `while (nChunks < concurrency)` 继续二分 | `2^19` → **32×16384**；`2^18` → 32×8192；`2^17` → 32×4096 |
| F18 | `engine_fft.js:73` | `buff = buff.slice(0, buff.byteLength)` | 整体输入复制一份；< 1 GiB 时 `BigBuffer.slice` 返回 `Uint8Array` 副本 |
| F19 | `web-worker 1.2.0 / cjs/node.js:168-170, 222-227` | `postMessage` 直通 `worker_threads`；worker 源码走 `VM.runInThisContext` | 克隆在发送端序列化；Worker 内无模块级 `require`，但有 `process`/`WebAssembly` |
| F20 | `threadman_thread.js:8-22` | **未实测**：模块初始化后 `u32[0]` 的静态数据基址 | 本文件所有容量按基址 = 0 计算，须由 M5-B 读真值 |

**两条设计约束**（由 F19 推出）：

- Worker 探针必须写在 `threadman_thread.js` 的 `thread()` **函数体内**——该函数被 `thread.toString()` 序列化成
  data URL 送进 Worker（`threadman.js:43`），闭包外的 helper 不会跟过去。
- Worker 侧不能写文件；遥测必须随计算结果一起回传，由主线程落盘。

---

## 3. 四条独立账目（A/B/C 按标量宽度分叉，D 是 batchconvert）

| 账目 | 源码 | 标量宽度 | 点数 | 典型位块数（p18 最大迭代） | 何时发生 |
| --- | --- | ---: | --- | ---: | --- |
| **A 阶段 1** | `processSection`（`:340-396`） | **4 B** | 每分片 65536，MSM 用 `n-1` | **3** | Phase 1，四个 section（`betaG2` 另走 `:316-338`，无 MSM） |
| **B `resTau`** | `verifyPower`（`:425-452`） | **4 B** | `2^p` | **3** | 每次 `verifyPower` 的第一步 |
| **C `resLagrange`** | `verifyPower`（`:454-482`） | **32 B** | `2^p` | **18**（p=19） | 同一 `verifyPower` 的第三步，FFT 之后 |
| **D batchconvert** | `engine_batchconvert.js:23-32`（`:470,474` 调用） | **32 B 进 / 32 B 出** | `2^p` | 无（不按位块切） | `resTau` 之后、FFT 前后各一次 |

**A 稿的错误就是把 C 的参数用在了 A 和 B 上。** A/B/C 三者不可合并：位块数差 6 倍，point-chunk 数与单任务载荷全部不同。
**D 不是 MSM**，它按 `concurrency` 等分、每块**两次分配**，作用是解释 §5.4 的 28 页事件与 JS 侧 48 MiB 瞬时副本。

### 3.1 MSM 路径（按账目分支）

```mermaid
flowchart TD
    A["snarkjs powersoftau verify"] --> A1["Phase 1: processSection x4<br/>4 B 标量, 64 Ki 点分片"]
    A --> B1["Phase 2: verifyLagrangeEvaluations x4<br/>tauG1 only: verifyPower(0..18) + (19)"]
    A1 --> A2["每分片 2 次 multiExpAffine(n-1 点)<br/>bit-chunk=3, point-chunk=10, 任务 30"]
    B1 --> B2["① resTau: Uint32Array<br/>4 B, bit-chunk=3, point-chunk=10"]
    B1 --> B3["② BigBuffer(nPoints*32) → batchTo<br/>→ fft → batchFrom (账目 D)"]
    B1 --> B4["③ resLagrange: 32 B<br/>bit-chunk=18, point-chunk=2"]
    A2 --> C["_multiExpChunk → queueAction<br/>结构化克隆, 无 transfer"]
    B2 --> C
    B4 --> C
    C --> W["worker ALLOCSET → u8.set 进 WASM<br/>memory.grow 后永不缩容"]
    W --> R["GET 144 B → Promise.all → 主线程累加"]
```

### 3.2 FFT 路径（`resLagrange` 前置；`prepare_phase2` 的主路径）

```mermaid
flowchart TD
    A["BigBuffer(nPoints*32)"] --> B["_fft: buff.slice(0, byteLength)<br/>整体复制 → Uint8Array"]
    B --> C["buffReverseBits<br/>~nPoints/2 次 32 B 小切片（碎片，不是峰值）"]
    C --> D["mix 波: 32 个 task<br/>ALLOC + SET"]
    D --> E["join 波: 每轮 16 个 task<br/>ALLOCSET x2"]
    E --> F["GET 回主线程, chunks[] 全量存活"]
    F --> G["buffOut = new Uint8Array(nPoints*32)<br/>逐块 set 后 delete chunks[i]"]
    G --> H["峰值 ≈ 输入副本 + chunks[] + 输出<br/>三份同时在场（2^19 时各 16 MiB）"]
```

---

## 4. 复制点清单（C1–C11）

探针事件用这套编号做 `site` 字段。

| ID | 位置 | 复制内容 | 字节（p18 `prepared_verify`） | 逻辑寿命 |
| --- | --- | --- | --- | --- |
| C1 | `powersoftau_verify.js:443-449` | 文件 → `BigBuffer buffG` | 48 MiB（`2^19·96`） | 单次 `verifyPower`（**两次 MSM 复用同一份**） |
| C2 | `engine_multiexp.js:131` | bases slice | 30.9 / 17.1 MiB（`resLagrange` 两块） | 到 `Promise.all` 完成 |
| C3 | `engine_multiexp.js:132` | scalars slice | 10.3 / 5.7 MiB（同上） | 同上 |
| C4 | `threadman.js:186` → `worker_threads` | 结构化克隆 | 41.1 / 22.9 MiB × 18 次/块 | 单任务 |
| C5 | `threadman_thread.js:58-62` | 克隆 → WASM 线性内存 | 同上（另加 grow 余量） | **到进程结束** |
| C6 | `threadman_thread.js:108-110` | WASM → 144 B `Uint8Array` | 144 B × 36 | 单任务 |
| C7 | `powersoftau_verify.js:425` | `resTau` 标量 `Uint32Array` | 2 MiB（`2^19·4`） | 单次 `verifyPower` |
| C8 | `powersoftau_verify.js:454` | `resLagrange` 标量 `BigBuffer` | 16 MiB（`2^19·32`） | 单次 `verifyPower` |
| C9 | `engine_fft.js:73` | FFT 整体输入复制 | 16 MiB | 单次 `_fft` |
| C10 | `engine_fft.js:123-148, 170-205` | FFT 分片收发 | mix 在途 16 MiB；join 每轮 ≤ 16 MiB | 单波 |
| C11 | `engine_fft.js:225-245` | FFT 输出缓冲 + 逐块 `set` | 16 MiB | 单次 `_fft` |

> 单位口径：`2^19×32 B = 16,777,216 B ≡ 16 MiB`；`2^19×96 B = 50,331,648 B ≡ 48 MiB`。
> A 稿里的 "16.8 MiB / 50.3 MiB" 是把十进制 MB 混进了 MiB 列，已全部改正。

---

## 5. 静态账本（模型，非测量）

`scripts/m5_budget.cjs` 复现全部算术：

```
node scripts/m5_budget.cjs --power 18 --operation prepared_verify
node scripts/m5_budget.cjs --power 18 --operation phase1
node scripts/m5_budget.cjs --power 18 --operation prepare_phase2 --json
```

**两个边界假设：只定义区间端点，不是预测值**（下表给出方向与推翻方式，二者都必须在 M5-B 里被实测替换）：

| 假设 | 内容 | 方向 | 如何被替换 |
| --- | --- | --- | --- |
| **HYP-1** | Worker 初始化后 `u32[0]` 基址取 **0**（F20 未实测） | **下界**：真实基址 `b > 0` 只会把 `requiredPages` 抬高 `ceil` 量级的整页，绝不会降低 | `worker_task.alloc_base`：每个 Worker 在 `INIT` 后只读一次 |
| **HYP-2** | 首轮任务按 `queueAction` 的入队顺序落到 workers `0..C-1` | **点预测（条件于 HYP-1）**：`processWorks()` 从 0 号扫起、`_multiExpChunk` 在 `await` 前同步入队，所以首个 `C` 个任务与 Worker 编号**一一对应**；迟到任务另证"任何 Worker 都吃得下"（见 §5.0.1），故总和与运行时顺序无关 | `worker_task.worker`：逐任务记录真实 Worker 号；若首轮出现非 `0..C-1` 的映射，F8 的读法错了 |

#### 5.0.1 首轮映射为什么是确定的（A.2 之后补证）

三个源码事实合起来把"调度顺序"从假设变成推论：

1. `_multiExp` 外层按 **point-chunk** 递增（`engine_multiexp.js:128`），`_multiExpChunk` 内部对 **bit-chunk**
   同步 `queueAction`（`:57-76`），且 `await Promise.all` 在其后（`:78`）。所以入队顺序是
   `pc0·bc0 … pc0·bc17, pc1·bc0 …`。
2. `queueAction` 立即 `processWorks()`（`threadman.js:212`），`processWorks` 从 `i=0` 找第一个空闲 Worker
   （`:192-197`），`postAction` 标记 `working[i]=true`。所以前 `C` 个任务依次占满 `0..C-1`。
3. 迟到任务（第 `C` 个之后）只在其需求 ≤ 当前**最小**容量时被证明无增长。计算器对 p16/p18 的全部
   445 次调用逐一验证该条件成立（`late_provably_free = true`，0 例外），因此容量总和与"谁先空闲"无关。

> 结论：除 `alloc_base` 外，§5 的容量表已经是**点预测**，可以直接作为 L2 的无容差判据；
> 它是否成立由 `worker_task.wasm_after` 逐 Worker 判定，而不是靠"接近"。


### 5.1 账目 A：Phase 1（4 B 标量）

| section | 群 | 点数 | 64 Ki 分片 | MSM 点数 | bitChunk | 位块数 | point-chunk | 任务数 | 单任务 MiB | 在途 MiB | Worker 页 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tauG1 | G1 | 524287 | 8 | 65535 | 12 | 3 | 10 | 30 | 0.7 | 18.3 | 25 |
| **tauG2** | **G2** | 262144 | 4 | 65535 | 12 | 3 | 10 | 30 | 1.3 | 35.9 | **42** |
| alphatauG1 | G1 | 262144 | 4 | 65535 | 12 | 3 | 10 | 30 | 0.7 | 18.3 | 25 |
| betatauG1 | G1 | 262144 | 4 | 65535 | 12 | 3 | 10 | 30 | 0.7 | 18.3 | 25 |
| betaG2 | G2 | 1 | 1 | — | — | — | — | 0 | 0 | 0 | 25 |

- `betaG2` 走的是另一条函数（`processSectionBetaG2`，`:316-338`）：**只读 192 B**，`fromRprLEM` +
  `toRprUncompressed` 全在主线程完成，**没有 MSM、没有 Worker 任务、没有 WASM 分配**。
  它的内存上界是一个 `Uint8Array(192)` 加一个 Jacobian 点（< 1 KiB），**不是"约 1 MiB"的待估项，可判为 0**。
  这也是 A.1 稿唯一没有闭合的零散路径，现予闭合。

- G1 分片 `7021×96×2 = 1,348,032 B < 25 页` → **不扩容**，Worker 停在 25 页。
- G2 分片 `7021×192×2 = 2,696,064 B > 25 页` → 扩到 `floor(2,696,064/65536)+1 = 42` 页 = 2.625 MiB。
- 尾部小分片（2346 点）不扩容，所以最终 **27 个 Worker @42 页 + 1 个 @25 页**：

  `27 × 2.625 + 1 × 1.5625 = 72.4 MiB`  ← **Phase 1 基线（替代 A 稿的 223 MiB）**

> 这是 A 稿最实质的错误：223 MiB 建立在"22 个位块、2 个 point-chunk"上。4 B 标量只有 3 个位块、10 个
> point-chunk，单任务从 41 MiB 降到 1.3 MiB，扩容后的容量自然只有 42 页。

### 5.2 账目 B：`resTau`（4 B）

| p | 点数 | bitChunk | 位块数 | point-chunk | 任务数 | 单任务 MiB | 在途 MiB | Worker 页 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 19 | 524288 | 15 | 3 | 10 | 30 | 5.4 | 146.4 | 165 |
| 18 | 262144 | 14 | 3 | 10 | 30 | 2.7 | 73.2 | 83 |

`resTau@2^19` 的 165 页（10.3 MiB/Worker）**低于**同一次迭代 `resLagrange` 的 988 页，所以它不抬高最终高水位；
但它在**时间上先发生**（`:452` 在 `:482` 之前），因此决定了 tauG1 窗口**前半段的** WS 形状。
逐 Worker 看，首轮 28 个任务是 `27 × 165 页 + 1 × 55 页`（尾部 point-chunk 18,731 点），
所以"每个 Worker 都留下 165 页"也不成立——这与 §5.4 的 `28 / 55` 是同一件事。

### 5.3 账目 C：`resLagrange`（32 B，FFT 之后）

| p | 点数 | bitChunk | 位块数 | point-chunk | 任务数 | 单任务 MiB | 在途 MiB | Worker 页 | Worker 容量合计 MiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 19 | 524288 | 15 | **18** | 2 | 36 | 41.1 | **969.1** | **988** | 1454.6 |
| 18 | 262144 | 14 | 19 | 2 | 38 | 21.7 | 505.1 | 522 | 758.8 |

- 单任务 `337,042 × 128 B = 41.1 MiB`；克隆总量 `18 × 524,288 × 128 B = 1152 MiB`，**与并发度无关**。
- 988 页 = `floor(2·32,356,032 / 65536)+1`，即 61.75 MiB/Worker 的容量；容量 ≠ 驻留。

### 5.4 账目 D：`Fr.batchTo/FromMontgomery`（32 B 进出）

`verifyPower` 在 `resTau` 之后、`resLagrange` 之前，对**整个 `2^p` 标量缓冲**做两次 batchconvert
（`:470` 与 `:474`）。两者都是 `buildBatchConvert(tm, "frm_batch*", 32, 32)`（`wasm_field1.js:71`），
每个 chunk 的任务是 `ALLOCSET var0 (n×32)` + `ALLOC var1 (n×32)` —— **两次分配**，合计 `2·n·32` 字节。

| p | 点数 | chunk 数 | 每 chunk 点（末块） | ALLOCSET / ALLOC (B) | 冷启动回放后页数 | 本次实跑是否扩容 | 冷启动预算合计 |
| ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 19 | 524,288 | 28 | 18,724（18,740） | 599,168 / 599,168 | **28** | **否（0 次 grow）** | **49.0 MiB**（28 × 28 页） |
| 18 | 262,144 | 28 | 9,362（9,370） | 299,584 / 299,584 | 25 | 否 | 43.75 MiB（28 × 25 页） |
| 17（p16 的最大档） | 131,072 | 28 | 4,681（4,685） | 149,792 / 149,792 | 25 | 否 | 43.75 MiB |

回放口径（`threadman_thread.js:44-56`，基址 0、初始 25 页 = 1,638,400 B）：

1. `ALLOCSET` 后 `top = 599,168`，判据 `top + 599,168 = 1,198,336 < 1,638,400` → **不扩容**；
2. `ALLOC` 后 `top = 1,198,336`，判据 `top + 599,168 = 1,797,504 > 1,638,400` →
   `requiredPages = floor(1,797,504 / 65,536) + 1 = **28**`。

**28 页完全由 F4 的双计造成**：若不双计，只需 `floor(1,198,336 / 65,536) + 1 = 19` 页。

**但它不是本次运行中真实发生过的一次扩容**——`batchToMontgomery` 在同一次 `verifyPower` 里晚于 `resTau`，
那时 Worker 的容量早已远超 28 页：

| power | 同迭代 `resTau` 之后的逐 Worker 页数 | batchconvert 需要 | 实际 grow 次数 |
| ---: | --- | ---: | --- |
| 18 | 27 个 @165 页、1 个 @55 页 | 28 | **0**（28 < 55） |
| 16 | 27 个 @42 页、1 个 @25 页 | 25 | **0**（25 = 25，判据 `>` 不成立） |

所以账目 D 的正确记法（按评审裁定改写）是：

> **独立冷启动容量预算**：若 Worker 从初始 25 页执行 BatchConvert，p19 需要 28 页/Worker，合计 49.0 MiB。
> 实际 `prepared_verify` 中该阶段发生在 `resTau` 之后，**不触发新的 WASM 扩容**，因此本阶段容量增量为 **0**。
> M5-B 以逐 Worker 的 `wasm_before / wasm_after` 验证这一条（有 grow 事件即视为该判断被推翻）。

它只有在两种条件下才变成约束：① `alloc_base` 远大于 0（HYP-1 被推翻，见 §8 步骤 3）；
② `resTau` 路径被改造或去除（M6 的候选场景，本轮明令不碰）。

主线程侧（`engine_batchconvert.js:20,22-30,35,40-46`）：`BigBuffer.PAGE_SIZE = 1 GiB`（`bigbuffer.js:2`），
16 MiB 的 `buff_r` **只占一个页**，`slice()` 走 `this.buffers[0].slice(...)`，即 `Uint8Array.prototype.slice`
——**必然复制**，累计复制量 = 16 MiB。但"输入 16 + 分片 16 + GET 16 + 输出 16 = 64 MiB 同时存活"
**不能只从源码推出**：`chunks` 是 28 个 `Promise.all` 同时挂着的，GET 结果与输出缓冲的存活窗口是否重叠
取决于 V8 何时回收已被 `set()` 消费的分片。

> 因此该 64 MiB 记为**峰值假设 P-1**，由 `fft_assembly` / `batchconvert_copy` 事件与 `heap_sample.array_buffers`
> 在 M5-D 判定；**不作为既成事实引用**。可确定的只有两点：每次调用至少新增一份 16 MiB 分片副本（累计 16 MiB/次），
> 输出缓冲 16 MiB 必然与输入共存。


### 5.5 其他项（p18）

| 项 | 值 | 依据 |
| --- | ---: | --- |
| Fr FFT @`2^19`（`resLagrange` 前置） | 32×16384，在途 16 / Worker 43.8 / 输入副本 16 / 输出 16 MiB | F17, F18 |
| Fr batchTo/FromMontgomery @`2^19` | 见 **§5.4 账目 D**（28 页、49 MiB、不抬高水位） | `engine_batchconvert.js:23-32` |
| FastFile 页池 | 52.8 MiB（`2^19×192 B` 的 G2 读，M4.1 已测） | — |

`prepare_phase2`（对照，不同操作，由 `--operation prepare_phase2` 输出）：p18 最大 ifft 为 32×16384 点，
在途 72 / Worker 容量 190.8 / 装配（输入副本 48 + `chunks[]` 72 + 输出 48 = 168）MiB，模型合计 **≈ 431 MiB**；
M3 实测峰值 1610 MiB，**差额约 1180 MiB 目前无法归属**（见 §10.6）。这个差额不用于支撑任何机制断言。

### 5.6 增量对账（只用增量；不跨量纲相加去"预测 WS"）

M4.1 的记录里"`+2160 MiB`"是"phase-2 起始标记 → tauG2 标记"之间 `current WS` 的变化，**它本身是一个增量**，
所以只能与**同性质的增量**对话，不能用它去比模型的"共存绝对值"，更不能把模型的几个量相加后宣称
"这就是 WS 预测值"。

**先把单次引用换掉**：三个 run 的同一段增量（`results/raw/m4_1_prepared_verify_p1x_r{1,2,3}.json` 的阶段标记）如下。

| 量 | p16 | p18 |
| --- | ---: | ---: |
| 实测段增量 r1 / r2 / r3 | +194 / +207 / +238 | +2160 / +2487 / +2636 |
| 实测均值（极差） | **213**（44） | **2428**（476，±10%） |
| 模型：`resLagrange` 在途（JS 字节） | 265.1 | 969.1 |
| 模型：`resLagrange` Worker 容量（WASM 地址空间） | 398.8 | 1454.6 |
| 模型：减去 Phase 1 基线（72.4） | −72.4 | −72.4 |
| **模型段增量（两者之和）** | **591.5** | **2351.3** |
| 模型 / 实测均值 | **2.8×** | **0.97×** |
| 模型落在实测区间内？ | 否 | **是**（2160–2636） |

**三条必须写死的读法**：

1. **"模型是上界"这个身份不成立**：p18 的模型 **低于**均值（0.97×），p16 的模型 **高于**均值（2.8×）。
   方向相反，说明这两档的主导项不同（p16 由固定开销与未写满的容量主导，p18 由在途与真实扩容主导），
   而不是"模型统一保守"。
2. **现有测量尚不能验证静态模型的准确性**：p18 的模型值落在三次观测范围内（2160–2636），p16 的模型值约为
   实测均值的 **2.8 倍**。不同规模下的偏差方向与幅度不同，且 p18 三次的极差 476 MiB **大于**模型与均值的
   差（−77 MiB）。因此现阶段**撤回模型上界判断与精度判断**，不写"吻合 x%"、不写"偏高 x%"，
   后续以逐 Worker 遥测与同刻内存指标为准。
   （三次样本不足以支持"噪声"这类统计表述，故本文件不再使用"噪声大于信号"的说法。）
3. **分子是两种不同东西的和**：在途字节是 JS 堆/`arrayBuffers` 的真实副本；容量增量是 WASM 线性内存的
   **地址空间**，扩了不等于写过、更不等于驻留。相加隐含"两者同时驻留且全部计入 WS"的假设。
   分母 `current WS` 又是操作系统在某一采样点的驻留页集合，既不含未触碰的 WASM 页，也可能滞后于
   V8 尚未回收的 ArrayBuffer。**三者只能并列，不能相加。**

因此：**不在本文件里做任何"模型吻合 WS"的断言**。§5.4 的账目与 §5.3 的在途量只在 §7.6 的 L3
（同刻并列四个量 + 残差区间）里才有意义。A.1 稿的 `776 + 2351 = 3127` 对 2936 的 6.5% 比较**已删除**。

仍成立的一条读法：**p16 的 1627 MiB 与全程峰值 1657 MiB 接近纯属巧合**——p16 的全程峰值出现在 tauG1
窗口**之外**。这正是"不能拿全程峰值比同窗模型"的实例。

### 5.6.1 phase 2 的四个 section **共用容量**，不是四次独立增长

`verifyLagrangeEvaluations` 在一次 phase 2 里被调用 **4 次**（`:271-282`）：`tauG1`(G1, section 2)、
`tauG2`(G2, 3)、`alphaTauG1`(G1, 4)、`betaTauG1`(G1, 5)。只有 `tauSection == 2` 会多跑一次
`verifyPower(power+1)`（`:406-409`），所以**只有 tauG1 的最大迭代到 `2^19`，其余三个到 `2^18`**。

如果按"四个 section 各涨 2351 MiB"推，p18 会到约 10 GiB —— 实测不是这样：

| section 起点标记（r1） | current WS | 相对上一段 |
| --- | ---: | ---: |
| phase-2 tauG1 开始 | 776 MiB | — |
| phase-2 tauG2 开始 | 2936 MiB | **+2160** |
| phase-2 alphaTauG1 开始 | 3202 MiB | +266 |
| phase-2 betaTauG1 开始 | 3432 MiB | +230 |
| 全程峰值（r1 / r2 / r3） | 3738 / 3894 / 3721 MiB | — |

原因是 **WASM 容量单调且不缩容**（F7）：tauG1 已经把容量池推到 1454.6 MiB，后面三段的需求
（tauG2 的 1043 页、G1 @`2^18` 的 522 页）**只补增量、不重新分配**。

**A.2 稿在这里写错了两处，现按源码逐 Worker 更正**：

1. "28 个 Worker 都到 988 页"不成立。p18 的 `resLagrange@2^19` 是 18 个位块 × **2 个** point-chunk
   （337,042 点 + 187,246 点），首轮 28 个任务 = **18 个大分片 + 10 个尾部分片**，所以是
   **18 个 Worker @988 页、10 个 @549 页**（`18×988 + 10×549 = 23,274` 页 = **1454.6 MiB**）。
2. 因此 tauG2 的容量增量不是"28 × 55 页 ≈ 96 MiB"。tauG2@`2^18` 是 **19 个位块 × 2 个** point-chunk
   （177,852 点 → 1043 页；84,292 点 → 494 页），首轮 19 个大分片落在 workers `0..18`：

   | Worker | 之前 | 首轮接到 | 之后 | 增量 |
   | ---: | ---: | ---: | ---: | ---: |
   | 0–17（18 个） | 988 | 1043 页大分片 | 1043 | **+55** |
   | 18（1 个） | 549 | 1043 页大分片 | 1043 | **+494** |
   | 19–27（9 个） | 549 | 494 页尾部分片 | 549 | 0（494 < 549） |

   `Δ池 = 18 × 55 + 494 = 1,484` 页 = **92.75 MiB**（`1,484 × 64 KiB = 97,255,424 B`）。
   对照：若按"28 个 Worker 各 +55 页"计会得到 1,540 页 = 96.25 MiB，**多算 3.5 MiB 且归属错误**。

> 对 M5 的直接含义：`resLagrange` 的容量账目要分两层看——**单 Worker 最大页数** 988 → 1043（tauG2 更高），
> 而**容量池增量**只有 +92.75 MiB。两者不可混用；L2 必须逐 Worker 核对 `988/549/1043/494` 这四个值。
> 实测 +266 MiB（r1，tauG2 段 WS 增量）与 92.75 MiB 不是同一量纲：前者含新触碰的页与页池，
> 后者只是线性内存容量，**不得相互解释**。


### 5.7 外推

A 稿的 p19–p21 外推表**删除**。理由：模型在 p16 上差 2.8×，用它外推两档之外没有意义，
且 M3 已撤回同类估算。只保留定性陈述：`prepared_verify` 的单次分配量随 `N` 线性增长，
Worker 容量由"最大 point-chunk"决定、在并发度固定时同样随 `N` 增长，因此 p20 以上在本机（31.7 GiB）
存在风险；**要报 p19+ 的数必须实测**。

---

## 6. 可检验假设

阈值全部改为**绝对量**，不再使用百分比区间。

| 假设 | 内容 | 证实证据 | 推翻条件 |
| --- | --- | --- | --- |
| **H-A** | p18 tauG1 段的增长主要来自 `resLagrange` 的克隆在途 | `task_send` 在途时间序列的峰 ≥ 800 MiB，且与 WS 上升同相位 | 在途峰 < 500 MiB |
| **H-B** | Worker 容量 ≈ 2× 首个大分片（`alloc()` 双计），任务结束后不回落 | 逐 Worker 回放得 988 页（`alloc_base` 用实测值代入后**精确相等，无容差**）；`grows ≥ 1`；结束后采样不下降 | 回放页数与实测不符（F4 读错或命令流漏记）或扩容后回落 |
| **H-C** | p18 `prepared_verify` 中 FFT + FastFile 合计 < 160 MiB | C9–C11 记账 + 页池快照 | 合计 > 300 MiB |
| **H-D** | `prepare_phase2` 的峰值主体**无法**由任何单次分配解释 | `arrayBuffers` 高水位 ≫ 探针在途量，且差额随时间累积 | 探针能逐项对上 ≥ 80% 的高水位 |

H-D 只声称"模型不足"，**不预设**机制是碎片、未释放还是未统计的外部内存。

---

## 7. 探针规格（M5-B）

### 7.1 形态、开关与**自证**

- **不修改 `node_modules`**：`npm pack ffjavascript@0.3.1` 取固定 tarball（记录 sha256），解到
  `vendor/ffjavascript-0.3.1-m5/`，在副本上打 `patches/m5-instrumentation.patch`。
- `scripts/m5_resolve_hook.cjs` 用 `Module._resolveFilename` 重定向，与 M4 的 `--require` 机制一致。
- 开关：`M5_TRACE=1` 激活；`M5_OUT=<path>.jsonl` 指定输出；缺省时走与原版相同的代码路径与返回值形状。
- **自证（新增，防"以为插桩了其实没有"）**：每次运行的第一条 JSONL 必须是

  ```json
  {"ev":"provenance","resolved":"<绝对路径>","sha256":"<副本实现文件的哈希>",
   "patch_sha256":"<patch 的哈希>","ffjavascript_version":"0.3.1","node":"v22.22.2"}
  ```

  并把 `require.resolve('ffjavascript')` 的实际返回值打到 stdout。
  **若 `resolved` 指向 `node_modules/ffjavascript`，整次运行作废**（脚本非零退出）。
- Worker 内的开关同样读 `process.env.M5_TRACE`（`worker_threads` 默认继承父进程 env）；`M5_OUT` 在 Worker 内无效。

### 7.2 遥测通道（不打断原有 Promise 协议）

Worker 现有协议是 `self.postMessage(runTask(data))`（`:17-25`），主线程 `getOnMsg` 直接 `resolve(data)`
（`threadman.js:145-158`）。**额外 `postMessage` 一条遥测会被当成任务完成**——必须避免。

```js
// threadman.js:145-158
let payload = data;
if (payload && payload.__m5) {      // 仅 M5_TRACE=1 存在
    tm.m5.ingest(payload.__m5, i);
    payload = payload.out;          // 对外形状与 ctx.out 完全一致
}
tm.working[i] = false;
tm.pendingDeferreds[i].resolve(payload);
tm.processWorks();
```

```js
// threadman_thread.js, runTask() 末尾（:117 return ctx.out）
return M5_ON ? { __m5: snapshot, out: ctx.out } : ctx.out;   // 关闭时零差异
```

### 7.3 任务上下文**在调用点显式绑定**（A.2 修正：不是只绑 MSM）

`processWorks()` 是延迟调度的：任务若在发送时刻读"当前全局状态"，它的 `site` 可能已被下一次调用覆盖。
A.2 只描述了 `_multiExp` 内部生成 `call_id`，那不足以覆盖 `batchConvert` / `_fft` / `_fftJoinExt` /
`fftJoin` / `fftFinal` / `batchLEMtoU`——它们同样走 `queueAction`，同样会延迟调度。

因此改为**每个引擎入口各自建 ctx，逐层下传，入队时绑到任务上**：

```js
// engine_multiexp.js:91-137
const ctx = m5.call('msm', {group: groupName, n_points: nPoints, s_scalar: sScalar,
                            bit_chunk: bitChunkSize, n_bit: nChunks});
for (let i = 0; i < nPoints; i += chunkSize) {
    const sub = m5.derive(ctx, {pc_idx: i / chunkSize, points: n});
    opPromises.push(_multiExpChunk(buffBasesChunk, buffScalarsChunk, inType, logger, logText, sub));
}
// _multiExpChunk -> G.tm.queueAction(task, undefined, m5.derive(sub, {bc_idx: i}))
```

- `m5.call()` 分配 `call_id` 并发一条 `*_plan` 事件；`m5.derive()` 只继承 `call_id` 与已定字段，不读全局。
- `queueAction(actionData, transfers, ctx)` 第三参可选。`ctx` 为 `undefined` 时记 `site:'unlabeled'`
  ——**snarkjs 自己在 `groth16_prove.js` / `zkey` 路径里内联构造的 task 属于这一类，必须被记录而不是被丢弃**。
- `task_send` / `worker_task` 都只带这份 ctx 的拷贝，因此 `task_send ↔ worker_task ↔ *_plan` 用 `call_id` 对齐。
- `batchConvert` 与 `_fft` 各自发**独立的 `batch_plan` / `fft_plan`**，字段含 `chunk_idx`、`chunk_points`、
  `points_in_chunk`、`n_chunks`，使 L1 能逐任务核对"这个任务属于哪个 chunk"。


### 7.4 事件模型（JSONL）

| 事件 | 触发点 | 关键字段 |
| --- | --- | --- |
| `provenance` | 启动 | `resolved, sha256, patch_sha256, ffjavascript_version, node` |
| `anchor` | 启动 | `epoch_ms, hr_ns, concurrency, page_bytes:65536, allocator_base_assumed` |
| `msm_plan` | `_multiExp` 入口 | `call_id, site, group, p, n_points, s_scalar, bit_chunk, n_bit, n_point_chunk, chunk_pts[]` |
| `batch_plan` | `batchConvert` 入口 | `call_id, site, n_points, s_in, s_out, n_chunks, chunk_points[]` |
| `fft_plan` | `_fft` 入口 | `call_id, op, p, n_points, bits, points_in_chunk, n_chunks, copy_bytes` |
| `task_send` | `postAction` | `task_id, call_id, worker, site, send_bytes, inflight, queue_depth, ts` |
| `task_done` | `getOnMsg` | `task_id, worker, svc_ms, inflight_after` |
| `worker_task` | worker `runTask` 末尾 | `worker, task_id, call_id, alloc_base, wasm_before, wasm_after, alloc_top, grows, allocs[], grow_events[], allocset_bytes, get_bytes, w_heap_used, w_external, w_array_buffers` |
| `heap_sample` | 主线程 200 ms | `rss, heap_used, external, array_buffers` |
| `fft_assembly` | `_fft` 末尾 | `copy_bytes, chunks_bytes, out_bytes` |

`allocs[]` / `grow_events[]` 是 A.2 新增的两个字段，作用是让 L2 能**精确回放**而不需要任何容差：

- `allocs[]`：按命令顺序列出本任务每个 `ALLOC` / `ALLOCSET` 的字节数（`len` 或 `buff.byteLength`）。
  MSM 任务是 `[bases, scalars, jac]`，batchconvert 是 `[n·sIn, n·sOut]`，FFT mix 是 `[sMid·pts]`。长度 ≤ 6，追加成本可忽略。
- `grow_events[]`：`[{at_alloc: i, from_pages, to_pages}]`，在 `alloc()` 内部记录 `memory.grow` 的实际前后页数。
- 二者加 `alloc_base` 与 `wasm_before`，即可从 `alloc_base` 起逐条重放，**页数必须逐一相等**（§7.6 L2）。

字段口径（四条，容易搞错）：

- `wasm_bytes` 是**容量**（`memory.buffer.byteLength`），不是驻留字节，**不能与 WS 相加**。
- 主线程 `arrayBuffers` 已含在 `external` 内，**不可累计**；`rss` 是整进程值（含所有 Worker）。
  Worker 只上报本 isolate 的堆字段，进程级 RSS 只由主线程采一次。
- `send_bytes` 是**单份**逻辑载荷；序列化副本与反序列化副本是同一载荷的两个瞬间，只记一次，用 `inflight` 描述重叠。
- `alloc_base` 用来**推翻或确认 HYP-1**：每个 Worker 在 `INIT` 之后只读一次。

### 7.5 采样纪律

- 事件按任务/计划粒度触发，**不在分配循环里打点**；禁止 `Uint8Array.prototype.slice` 全局劫持、
  每秒级 `Object.keys` 扫描、在 `alloc()` 内写日志（M4 教训：O(pages) 探针让 p16 从 10 s 变 18 s）。
- 主线程缓存数组，每 256 条或 250 ms 落盘；`process.on('exit')` 兜底 flush。

### 7.6 验收门槛（三层，替代原 70%–100% 区间）

| 层 | 门槛 | 判定方式 |
| --- | --- | --- |
| **L1 算法切分** | `n_points / s_scalar / bit_chunk / n_bit / n_point_chunk / chunk_pts / 任务数` **逐字段与源码复算相等** | `msm_plan` 与 `m5_budget.cjs --json` 无条件 diff；任一不等即失败 |
| **L2 逐 Worker 内存** | 从 `alloc_base` 起按 `allocs[]` **逐条回放**：每条 `ALLOC`/`ALLOCSET` 后的 `top`、每次 `grow_events` 的 `from_pages → to_pages`、任务收尾的 `wasm_after`，均与 `memory.buffer.byteLength` **逐 Worker、逐事件精确相等**。**不设任何容差** | 逐 Worker 回放表；首个不符的 `(worker, task_id, alloc_index)` 即判失败 |
| **L3 阶段总量** | 同一采样时刻**并列**四量（在途任务字节、WASM 容量、current WS、`arrayBuffers`），并给出 WS 的可核对分解与**残差区间**；**不设百分比门槛** | 时间对齐表 + 残差区间列 |

**L2 为什么可以要求精确相等**：`alloc_base`、每个 `ALLOC`/`ALLOCSET` 的字节数、每次 `grow` 的前后页数、
以及 `wasm_after` 都是探针能直接观测的事件，没有任何一项需要猜测。页粒度固定 64 KiB，
`requiredPages = floor((top + len)/65536)+1` 是确定性算术，因此"差一页"就意味着**探针漏了一个事件**
或 **`allocs[]` 与真实命令流不符**——这正是必须失败而不是容忍的情形。

**L3 的残差是区间，不是一个数**：`arrayBuffers` 可直接算作驻留候选；WASM 容量**不能**直接计入 WS
（扩了不等于写过），只能用 `[0, capacity]` 作为上下界。所以残差报为
`WS − arrayBuffers − Σ_known` 的区间，并注明端点假设。**绝不再把在途字节与容量相加后与 WS 比大小。**

L3 的残差不是"验收失败"，它就是 M5 的产出——用来判断模型缺什么。

### 7.7 明令禁止（M5 全程）

不改 `pTSizes` / `chunkSize` / `concurrency` / 任务顺序 / `Promise.all` 结构；不引入 transfer list；
不"顺手修" `alloc()` 的双倍余量；不改 FFT/MSM 计算过程；不跑 p20/p21；不动 `m1-m2-frozen`。

---

## 8. 测量协议

**M5-C（smoke，Power 10）**

1. `M5_TRACE=1` 跑 `prepared_verify @ p10`：`provenance.resolved` 指向 vendor 副本；JSONL 可解析；
   `concurrency=28`；`task_send` 数 == `worker_task` 数；L1 全字段相等。
2. 关闭探针再跑一次，比较 peak WS 与耗时（墙钟 ≤ +10%；peak WS 落在 M4.1 同 power 的会话内 CV 内）。
3. 用实测 `alloc_base` + `allocs[]` 逐 Worker 精确回放（L2），把 §5 的容量列由「HYP-1 下界」替换为
   **实测值**；若实测页数 > 静态页数，必须定位到具体 `(worker, task_id, alloc_index)`，
   不接受"按整页上修若干页"这种笼统修正。

**M5-D（p16 / p18 正式归因）**

- fixture、版本、`PollIntervalMs=25`、FastFile 采样沿用 M4.1。
- **交错对照** `on, off, on, off, on, off`（每 power ≥ 3 对），抵消会话漂移（M4.1 已观察到 +3.9%）。
- 产出 `m5_attribution_p16|p18.{csv,md}` + 一张"四类 × 阶段"的堆叠图；原始 JSONL 不入库。

---

## 9. 研究问题 → 证据映射

| 问题 | 回答它的字段 | 判定 |
| --- | --- | --- |
| RQ1 FFT 输入副本与分片是否峰值主要贡献者 | `fft_plan.copy_bytes`、`fft_assembly.*` | 与 MSM 在途同图；H-C |
| RQ2 MSM 分片与 Worker 克隆同时存活多少 | `task_send.send_bytes` + `inflight` 时间序列 | 在途峰对 969 MiB；H-A |
| RQ3 各 Worker WASM 是否持续增长并保留 | `worker_task.wasm_before/after/grow_pages/alloc_base` | L2 逐 Worker 对账；H-B |
| RQ4 p18 tauG1 的 +2.2 GiB 由什么解释 | 上述三者**同刻并列** + `heap_sample.array_buffers` + 残差区间 | L3 残差区间，不设百分比门、不相加 |

---

## 10. 风险与未解释项

1. **模型不是测量**。§5 所有数字是"源码算术 + `alloc_base = 0`"，只有 §8 跑完才有结论权。
2. **初始 allocator 基址未知**（F20）。它是 **HYP-1 下界**的来源：真实基址只会抬高 `requiredPages`，
   不会降低；M5-B 用 `alloc_base` + 逐条回放替换它。
3. **容量归属不再"依赖调度顺序"**（A.2 之后的补证，见 §5.0.1）：首轮映射由 `processWorks()` 的顺序扫描决定，
   迟到任务对 p16/p18 的 445 次调用逐一证明无增长，所以 1455 MiB 是**条件于点预测**而非上界；
   它唯一的不确定性来自 `alloc_base`。若探针发现首轮映射不是 `0..C-1`，说明 F8 的读法错了，须重做 §5。
4. **V8 的 ArrayBuffer 回收不可观测**：`arrayBuffers` 只给当前持有量，给不出释放时刻。
5. **WASM 容量 ≠ 驻留**：扩容但未写满的页可能不在 WS 里，H-B 只能证明"容量增长"。
6. **`prepare_phase2` 的 920–1180 MiB 差额目前无法归属**，可能是未统计的缓冲、Worker 内存或外部内存；
   在 M5-D 之前不得称其为"碎片"。
7. **Windows 口径**：继续用 `PeakWorkingSet64` / `PeakPagedMemorySize64`，不引入新口径。
8. **单位纪律**：全文 MiB；源码里的字节数保留精确值，禁止用十进制 MB 近似替代。
9. **三个量纲不可互加**：在途字节（JS 副本）、WASM 容量（线性内存地址空间）、Working Set（驻留页集合）
   是三种不同的内存口径。可以**同刻并列**，可以各自单独与实测比，但**任何相加后宣称"预测 WS"的做法都禁止**
   （A.1 稿的 `776 + 2351 = 3127` 已删除，原因即此）。
10. **账目 D 是冷启动容量预算，不是本次运行的扩容事件**：`batchTo/FromMontgomery` 若从 25 页起跑，
    p18 需要 28 页/Worker（28 个合计 49.0 MiB）；但它在 `resTau` 之后执行，那 28 页远低于已有容量
    （165 / 55 页），**实际 grow 次数为 0、容量增量为 0**。写报告时必须同时给出"冷启动需要 28 页"与
    "本次运行没有发生这次扩容"两个事实，不能只写"49 MiB"让人误读为增量。
11. **阶段增量是单采样点，离散不可忽略**：p18 同一段（phase-2 起始 → tauG2 标记）三次为
    +2160 / +2487 / +2636（极差 476 MiB，±10%），p16 为 +194 / +207 / +238。
    任何引用段增量的地方必须给出三次读数与均值；**M4.1 文档里的 `+2160` 是 r1 的读数**，不得当作"该段的实测值"。
    三次样本不足以支持统计意义上的"噪声"判断，故本文件不使用该措辞。
12. **主线程 64 MiB 同时存活是假设 P-1，不是源码推论**：`BigBuffer.PAGE_SIZE = 1 GiB`，16 MiB 缓冲只占一页，
    `slice()` 走 `Uint8Array.slice` 必然复制（累计 16 MiB/次）；但输入 / 分片 / GET 结果 / 输出四者
    **是否同时存活**取决于 V8 回收时机，M5-D 用 `heap_sample.array_buffers` 判定。

---

## 11. 评审结论与 M5-B 实施清单

**A.2 评审裁定（已采纳，不再另开 A.3）**：

| 待确认项 | 结论 | 落实位置 |
| --- | --- | --- |
| 账目 D：记录但不计入本次峰值增量 | **接受**，但改称"独立冷启动容量预算"，并给出"本次 grow 次数 = 0" | §5.4、§10.10 |
| 撤回"模型是上界" | **接受**，最终措辞为"现有测量尚不能验证静态模型的准确性"；不再用"噪声大于信号" | §5.6、§10.11 |
| L2 无容差精确回放 | **接受，作为 M5-B 硬门**：从真实 `alloc_base` 起按事件顺序回放，页数逐一相等，首个不符点定位到 `(worker, task_id, alloc_index)` | §7.6 |
| §5.6.1 Worker 分布与容量增量 | **已按源码更正**：18@988 + 10@549；tauG2 `Δ池 = 18×55 + 494 = 1,484 页 = 92.75 MiB` | §5.6.1 |
| 计算器须覆盖 G1/G2 与全部 power | **已补齐**：`--operation plan` 输出 445 次调用（p18）的完整计划，含 group / power / 切分 / 首轮页数 | `scripts/m5_budget.cjs` |
| `queueAction` 须显式上下文绑定 | **M5-B 实现**（见下） | §7.3 已改为逐调用点传 ctx |

**M5-B 实施清单**（按依赖顺序；L1/L2 必须**先可执行**，才允许进入 M5-C）：

1. `npm pack ffjavascript@0.3.1` → `vendor/ffjavascript-0.3.1-m5/`，记录 tarball sha256；在副本上打
   `patches/m5-instrumentation.patch`，`node_modules` 保持出厂状态。
2. **显式上下文绑定**（替代 A.2 的"只读全局"方案）：
   - `_multiExp` 入口生成 `ctx = {call_id, site, kind:'msm', group, n_points, s_scalar, bit_chunk, n_bit}`，
     下传给 `_multiExpChunk(..., ctx)`；每任务复制一份带 `pc_idx/bc_idx` 的派生 ctx。
   - `batchConvert` 入口生成 `ctx = {call_id, site, kind:'batch', n_points, s_in, s_out, chunk_idx, chunk_points}`。
   - `_fft` 入口生成 `ctx = {call_id, site, kind:'fft', n_points, bits, points_in_chunk, n_chunks}`。
   - `_fftJoinExt` / `fftJoin` / `fftFinal` / `batchLEMtoU` 同样各自绑 ctx（它们也走 `queueAction`）。
   - `queueAction(actionData, transfers, ctx)`：`ctx` 缺省时记 `site:'unlabeled'`（snarkjs 自己内联的
     task 属于这一类，必须被记录而不是被忽略）。
3. **BatchConvert / FFT 各自发独立的 `*_plan` 事件**，与 `task_send` / `worker_task` 用 `call_id` 对齐。
4. **L1 可执行**：`scripts/m5_check_l1.cjs` 读 `--operation plan` 的 JSON 与探针的 `*_plan` 事件，
   逐字段 diff（`n_points / s_scalar / bit_chunk / n_bit / chunk_pts / n_tasks`），先比**调用序列**再比字段；
   任何不一致即以非零码退出并打印首次分歧的 `call_id` 与字段名。
5. **L2 可执行**：`scripts/m5_check_l2.cjs` 读 `worker_task`，从 `alloc_base` 起按 `allocs[]` 回放，
   逐条比对 `grow_events[]` 与 `wasm_after`；不允许任何容差。
6. `scripts/m5_hook.cjs`（`--require`）+ `M5_CONFIG` 环境变量 + JSONL 落盘 + provenance 自证。

- **M5-C**：p10 smoke 过 L1 / L2 + 扰动预算（开关前后 peak WS 偏差与耗时偏差都要报）。
- **M5-D**：p16/p18 交错对照，产出归因表与残差区间。
- **M5-E**：写 `docs/M5_ATTRIBUTION.md`，届时**才**讨论 H1 / 并发 / 缓冲寿命的优先级；在此之前不写优化代码。

> **边界声明**：A.2 是本项目**最后一次静态设计校准**（本轮只做了评审勘误，不构成新修订）。此后不再靠纸面
> 预算推导内存峰值——所有数字要么来自探针，要么明确标注为"边界假设"。

