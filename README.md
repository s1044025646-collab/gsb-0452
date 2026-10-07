# 确定性单带图灵机执行与有限步停机诊断后端

离线、本地运行的图灵机实验服务。使用 TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生依赖、无外部服务）。只提供 HTTP API 与 CLI，不执行任何用户输入的代码，只操作内存与项目内数据库文件。

## 目标与边界

- 明确区分三种有限步结果：**已停机**（`accepted` / `rejected`）、**无规则**（`no_transition`）、**预算耗尽**（`paused_by_budget`），以及资源受限（`limited`）。
- **不做循环检测，不证明不终止**。`paused_by_budget` 只表示"这次请求的步数预算用完了"，可以从原配置继续运行。
- 不实现编译器、多带模拟器，不访问其他程序文件。

### 为什么有限步未停机不能推出永不停机

本服务每次 `run` 只执行有限条转移规则。预算耗尽时机器只是"还没停"，它可能在下一步就进入接受态，也可能永远不停——一般停机问题不可判定，有限观察无法区分"暂未停机"与"永不停机"。因此 `paused_by_budget` 是中性结论，既不是停机也不是死循环的证明。

## 环境要求

- Windows 本地，Node.js >= 22.5（使用内置 `node:sqlite`，开发时为 experimental 警告，可忽略）
- 不需要 Docker / WSL / 任何在线服务

## 命令

```powershell
npm install        # 安装 typescript 与 @types/node（仅开发依赖）
npm run build      # 编译 src -> dist
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务（默认端口 0 = 自动选空闲端口；用 $env:PORT=8080 指定）
npm run demo       # 运行内置演示（一元加一 + 无限左移）
node dist/cli.js   # 查看 CLI 全部子命令
```

数据库文件默认在项目内 `data/tm.db`，可用环境变量 `TM_DB` 覆盖。

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
    { "state": "q", "read": "1", "next": "q",      "write": "1", "move": "R" },
    { "state": "q", "read": "_", "next": "accept", "write": "1", "move": "S" }
  ]
}
```

校验规则（违反即整体拒绝，返回 `VALIDATION_ERROR`）：

- 符号与空白符必须是单个 ASCII 可打印字符（0x20–0x7E），空白符必须属于符号集。
- 所有引用的状态/符号必须已声明；接受态与拒绝态不重叠。
- 每对 `(状态, 读符号)` 最多一条规则；**重复规则直接拒绝**，不会静默覆盖。
- 终止态（接受/拒绝）不允许定义出边。
- 移动方向仅 `L` / `R` / `S`。

## 一步语义

稀疏双向磁带 + 整数读写头（允许负坐标，无左右边界）：

1. 在**当前头位置**读取符号（未存储格视为空白符）；
2. 查找 `(状态, 读符号)` 的唯一规则，无规则则以 `no_transition` 停止；
3. **先写**符号（写空白 = 删除该稀疏条目），**再移动**一格或不动（`S`），最后进入新状态；
4. 步数 +1，持久化一条步记录（旧状态、头位置、所读字符、规则、新状态）。

进入接受/拒绝态立即停止。预算为 0 时不执行任何规则，但会如实报告当前是否已处于终止态。预算只限制本次请求，不会在预算用完后多走一步。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/machines` | 校验并保存机器（每次保存产生新的锁定版本） |
| GET  | `/machines` / `/machines/:id` | 列表 / 导出转移明细 |
| POST | `/executions` | 创建执行 `{machineId, tape, head}`，各执行磁带互相隔离 |
| GET  | `/executions/:id` | 查看状态、头位置、已执行步数、版本号 |
| POST | `/executions/:id/step` | 单步（等价于 budget=1） |
| POST | `/executions/:id/run` | 按预算运行 `{budget, expectedVersion?, requestId?}` |
| POST | `/executions/:id/replay` | 用同一机器版本与初始输入重新创建执行 |
| GET  | `/executions/:id/tape?start=&width=` | 磁带窗口：只返回非空单元清单与逻辑头位置，坐标不重编号 |
| GET  | `/executions/:id/steps?from=&limit=` | 逐步轨迹 |

### 并发与幂等

- 一次 `run` 的全部步骤与结果在**单个事务**中原子提交；崩溃后从最后已提交配置恢复，未提交步骤不会进入历史。
- `expectedVersion` 提供乐观并发控制：两个请求同时推进同一执行时只有一个成功，另一个得到 `VERSION_CONFLICT`（HTTP 409）。
- `requestId` 幂等：相同请求号重复提交不会多跑，直接返回首次结果。

### 错误码

`VALIDATION_ERROR`（400）、`NOT_FOUND`（404）、`VERSION_CONFLICT`（409）、`LIMIT_EXCEEDED`（400）、`INTERNAL`（500）。

### 资源上限（可在创建机器时覆盖默认值）

`maxStates` 256、`maxSymbols` 64、`maxTransitions` 4096、`maxCells` 100000、`maxAbsCoord` 1000000、`maxTotalSteps` 1000000、`maxStepsPerRun` 100000。触及上限时本次 run 整体回滚（不留下半次转移），执行被标记为 `limited`。

## CLI 速查

```powershell
node dist/cli.js machine:create '{"states":[...], ...}'   # 或 @machine.json
node dist/cli.js exec:create <machineId> "111" 0
node dist/cli.js exec:run <execId> 100 [expectedVersion] [requestId]
node dist/cli.js exec:step <execId>
node dist/cli.js exec:tape <execId> -10 20
node dist/cli.js exec:steps <execId>
node dist/cli.js exec:replay <execId>
node dist/cli.js machine:export <machineId>
```

## 演示

`npm run demo` 演示两台机器：

1. **一元加一**：输入 `111`，`q` 读到 `1` 右移，读到空白写 `1` 并进入接受态，4 步后磁带为 `1111`。
2. **无限左移**：预算 5 步后头位于 `-5`、状态 `paused_by_budget`；续跑 3 步与一次性跑 8 步结果完全一致（头 `-8`）。

## 测试

`npm test` 覆盖：空输入、初始即终止、`S` 不移动、写空白删除稀疏条目、缺规则 `no_transition`、全部非法定义、零预算、版本冲突、请求幂等、资源上限回滚、重放隔离、单步与批量轨迹一致性（手写逐步配置核对动作顺序：读→写→移→换状态）。

## 已知限制

- 无循环检测：重复配置不会自动提示，需要调用方自行判断。
- `node:sqlite` 在 Node 25 仍打印 experimental 警告，不影响功能。
- 单进程服务，未做鉴权，仅面向本机实验用途。
