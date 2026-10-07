# tm-lab：确定性单带图灵机执行与有限步停机诊断后端

离线、本地运行的实验服务。用有限转移表描述一台确定性单带图灵机，给定初始磁带与读写头位置，可单步或按预算执行，查看磁带修改、状态变化与停止原因。只做 API 与 CLI，不执行任何用户提供的 JavaScript / Shell / 机器码，不访问项目目录之外的文件。

## 运行环境

- Windows 本地，Node.js ≥ 22（使用内置 `node:sqlite`，无需 Docker / WSL / 原生编译 / 外部服务）
- 安装依赖：`npm install`（仅开发依赖 TypeScript）

## 常用命令

```powershell
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm start         # 启动 HTTP 服务（默认端口 0 = 自动选择空闲端口）
npm run demo      # 运行两个演示（一元加一、持续左移）
node dist/src/cli.js validate examples/unary-increment.json
node dist/src/cli.js run examples/unary-increment.json --tape 111 --budget 100
node dist/src/cli.js status <executionId>
```

环境变量：`PORT`（监听端口，缺省自动选空闲端口）、`TM_DATA_DIR`（数据目录，默认项目内 `data/`，SQLite 文件为 `data/tm.sqlite`）。

## 机器定义

```json
{
  "name": "unary-increment",
  "states": ["q", "accept", "reject"],
  "startState": "q",
  "acceptStates": ["accept"],
  "rejectStates": ["reject"],
  "symbols": ["1", "_"],
  "blank": "_",
  "transitions": [
    { "state": "q", "read": "1", "next": "q", "write": "1", "move": "R" },
    { "state": "q", "read": "_", "next": "accept", "write": "1", "move": "S" }
  ]
}
```

校验规则（违反即拒绝，返回对应错误码）：

- 符号必须是单个可打印 ASCII 字符（0x20–0x7E），空白符必须是已声明符号之一（`INVALID_SYMBOL`）。
- 移动方向只允许 `L` / `R` / `S`（`INVALID_DIRECTION`）。
- 同一 `(状态, 读符号)` 最多一条规则，重复直接拒绝而不是覆盖（`DUPLICATE_RULE`）。
- 所有引用的状态与符号必须已声明（`UNDECLARED_STATE` / `UNDECLARED_SYMBOL`）。
- 接受态与拒绝态不得重叠（`ACCEPT_REJECT_OVERLAP`）；终止态不允许有出边（`TERMINAL_HAS_OUTGOING`）。

## 一步语义

磁带是稀疏双向无限带（`Map<整数坐标, 字符>`），未存储的格视为空白；写入空白会删除该稀疏条目。允许负坐标，左移没有边界。一步的顺序固定为：

1. 在当前头位置**读**符号；
2. 查 `(状态, 读符号)` 的规则；
3. **写**符号；
4. 移动一格（L/R）或不动（S）；
5. 进入新状态，已执行步数 +1。

每步记录旧状态、头位置、所读字符、命中规则、写入字符、新状态与新头位置，持久化到 `steps` 表。

## 停止原因（明确区分，互不混淆）

- `halted_accept` / `halted_reject`：进入接受/拒绝态，立即停止。
- `no_transition`：非终止态没有适用规则。不自动视为接受或拒绝。
- `paused_by_budget`：本次请求的步数预算用完但机器仍可继续。**这不是停机，也不是死循环**，可用新版本号继续跑。
- `limited`：触及资源上限（见下），未留下半次转移。

预算只限制**这一次请求**最多执行多少条规则；预算为 0 时不执行任何步，但会报告当前是否已处于终止态。不会在预算用完后额外多走一步。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/machines` | 校验并保存机器，返回 `machineKey` 与 `version=1` |
| PUT | `/machines/:key` | 修改定义，创建新版本；旧执行仍锁定旧转移表 |
| GET | `/machines/:key?version=N` | 查看定义（缺省最新版） |
| GET | `/machines/:key/transitions` | 导出转移明细 |
| POST | `/machines/:key/executions` | 创建执行：`{"tape":"111","head":0,"state?":"q","machineVersion?":1}` |
| POST | `/executions/:id/run` | 按预算运行：`{"budget":100,"expectedVersion":1,"requestId?":"abc"}` |
| POST | `/executions/:id/step` | 单步（等价于 budget=1 的 run） |
| GET | `/executions/:id` | 查看状态（状态机、头、步数、版本号） |
| GET | `/executions/:id/tape?start=-10&width=21` | 磁带窗口：`start`/`width` 必填，返回窗口内非空格清单与逻辑头位置，不重编号坐标 |
| GET | `/executions/:id/steps` | 查看逐步历史 |
| POST | `/executions/:id/replay` | 从初始条件重新回放（可带 `budget`），并校验与当前配置一致 |

错误统一为 `{"error":{"code","message"}}`，主要错误码：`MACHINE_INVALID`、`DUPLICATE_RULE`、`UNDECLARED_STATE`、`UNDECLARED_SYMBOL`、`TERMINAL_HAS_OUTGOING`、`ACCEPT_REJECT_OVERLAP`、`INVALID_SYMBOL`、`INVALID_DIRECTION`、`BAD_REQUEST`、`NOT_FOUND`、`VERSION_CONFLICT`(409)、`ALREADY_HALTED`(409)、`LIMIT_EXCEEDED`(413)。

## 并发、幂等与崩溃恢复

- 一次 `run`/`step` 的全部步记录与配置更新在**单个 SQLite 事务**（`BEGIN IMMEDIATE`）中提交：要么全部落库，要么全部回滚，不会留下半次转移。
- 每个执行有单调递增的 `version`；推进请求必须携带 `expectedVersion`。两个并发推进只有一个成功，另一个得到 `VERSION_CONFLICT`。
- 可选 `requestId` 幂等键：重复的请求号直接返回首次结果，不会多跑。
- 崩溃或重启后从最后已提交的配置恢复（WAL），未提交的步骤不会计入历史。

## 资源上限

默认上限（`src/types.ts` 中 `DEFAULT_LIMITS`，构造 `TmService` 时可覆盖）：状态数 1000、符号数 128、规则数 100000、单执行累计步数 1,000,000、非空格数 100,000、坐标绝对值 ±1,000,000。触及上限时执行进入 `limited` 状态，且不应用那一步转移。

## 为什么有限步未停机不能推出永不停机

本服务只做**有限步诊断**：`paused_by_budget` 只表示"在给定预算内没有停机"，它对"是否永不停机"不作任何断言。一台机器可能在一亿步之后才停机；任何有限预算都无法区分"还要很久才停"与"永不停"。一般性的停机问题已被证明不可判定，因此本服务刻意不提供循环检测或不终止证明，只如实报告三种可判定的事实：已停机（接受/拒绝）、无规则可走（`no_transition`）、预算耗尽（`paused_by_budget`）。

## 演示

`npm run demo` 输出：

1. **一元加一**：输入 `111`，`q` 读到 `1` 右移，读到空白写 `1` 进接受态，4 步后磁带为 `1111`，状态 `halted_accept`。
2. **持续左移**：预算 5 步后头位于 `-5`，状态 `paused_by_budget`；续跑 3 步与一次性跑 8 步结果完全一致（头 `-8`）。

## 限制

- 仅单带、确定性、L/R/S 移动；不实现多带、非确定性、编译器或循环检测。
- `node:sqlite` 在 Node 25 中仍标记为 experimental（启动时有一条警告），API 未来可能微调。
- 单进程服务，未做认证，仅面向本机实验用途。
