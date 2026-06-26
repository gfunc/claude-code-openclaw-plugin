# OpenClaw 后台任务完成/失败通知 agent session 的机制

> 仓库：`openclaw/openclaw` @ v2026.6.9。所有引用都是 `repo-root/相对路径:行号`。

---

## 1. TL;DR

OpenClaw **没有"任务完成专用总线"**——所有后台任务（bash bg / detached task / ACP subagent / cron / 远端 node-host / gateway hook / channel inbound）最终都汇到 **同一套两段式机制**：

1. `enqueueSystemEvent(text, {sessionKey, contextKey, deliveryContext})` 把一条文本事件投到 **per-session 内存队列**（`src/infra/system-events.ts`，纯内存，无持久化，`MAX_EVENTS=20`，按 `text+contextKey+deliveryContext` 去重）。
2. 紧接着 `requestHeartbeat({source, intent, sessionKey, ...})` 唤醒 heartbeat-runner（`src/infra/heartbeat-wake.ts` + `src/infra/heartbeat-runner.ts`），由 runner 在自己的 turn 里 `peek → 构造 prompt → consume`。

**普通用户 turn 是兜底**：`src/auto-reply/reply/session-system-events.ts` 把堆积事件渲染成 `System: [ts] …` 行 prepend 到下一次 prompt 前；heartbeat 自己 own 的事件（exec / cron）会在用户 turn 里被故意跳过留给 heartbeat 消费。

**两条不走 system-event 的特例**：
- 媒体生成 (`src/agents/tools/media-generate-background-shared.ts`) 走 `deliverSubagentAnnouncement()`，**主动 steer 到 ACP/embedded 当前 turn 或直发 channel**，是唯一一条真"push"路径。
- Detached task terminal 通知（`src/tasks/task-registry.ts:maybeDeliverTaskTerminalUpdate`）能 reach 原 `requesterOrigin` 时**直接 `sendMessage` 到 channel**，到不了才 fallback 到 system-event。

**持久化**：system-event queue 进程一退就丢；但 task 元数据 (`tasks`/`task_flows`/`task_delivery_state`)、cron job、subagent run、pendingFinalDelivery 都在 sqlite，靠 reconcile/maintenance 在重启后补发。

**`<task-notification>` 这个标签 OpenClaw 不发**：全仓只在 `extensions/acpx/src/claude-agent-acp-completion.test.ts:134,149` 出现，是 `@agentclientprotocol/claude-agent-acp` SDK 自己的 `result.origin.kind`，ACPX 测试只是验证这种 autonomous result 不会提前 resolve foreground prompt。

跟 plugin 之前修过的 bug 的关系：那个 bug 是 plugin 通过 `api.runtime.system.requestHeartbeatNow()` 触发时 `source` 默认 `"other"` + 没传 `contextKey`，被并发 cron heartbeat 抢走。后台任务通知用的是 `"exec-event"` / `"background-task"` / `"acp-spawn"` / `"cron"` 这些**专用 source**，配上 `task:*` / `exec:*` / `acp:*` / `cron:*` 这些 **专用 contextKey**，跟 cron drain 是隔离的——只有走通用 plugin SDK 且没显式传 source/contextKey 的路径才会重蹈覆辙。

---

## 2. 架构图

```
┌──────────── Producer 侧（任务源头）────────────┐
│                                                 │
│ bash bg ──┐    ACP child ──┐    cron tick ──┐  │
│ node-host─┤    detached ───┤    gateway hook┤  │
│ remote    │    task term  │    media gen ─┐ │  │
│ exec  ────┤    /state ─────┤    plugin sdk│ │  │
│           │                │              │ │  │
└───────────┼────────────────┼──────────────┼─┘  │
            │                │              │    │
            │                ▼              │    │
            │  ┌─ deliverSubagentAnnouncement ┐  │
            │  │ (steer ACP/embed turn        │  │
            │  │  OR sendMessage to channel)  │──┼──► requester session 直接收到
            │  └──────────────────────────────┘  │
            │                                    │
            ▼                                    │
┌───── enqueueSystemEvent(text, opts) ──────────┐│
│ src/infra/system-events.ts                    ││
│ · per-sessionKey queue, MAX_EVENTS=20         ││
│ · 内存唯一存储，进程退出即丢                  ││
│ · dedupe by text+contextKey+deliveryContext   ││
└──────────────────┬─────────────────────────────┘
                   │ (通常紧跟)
                   ▼
┌───── requestHeartbeat({source, intent, sessionKey, ...}) ─────┐
│ src/infra/heartbeat-wake.ts                                   │
│ · coalesce 250ms / busy 时 1s retry                          │
│ · 三层 skip：main lane busy / cron-in-progress /              │
│   pendingFinalDelivery 30s 窗口                              │
│ · 按 `${agentId}::${sessionKey}` 合并 pendingWakes            │
│ · 优先级 RETRY > INTERVAL > DEFAULT > ACTION                  │
└──────────────────┬────────────────────────────────────────────┘
                   ▼
┌───── HeartbeatWakeHandler（heartbeat-runner.ts）─────┐
│  runHeartbeatOnce → peekSystemEventEntries           │
│  → 按 source/contextKey 分类构造 prompt：             │
│      buildExecEventPrompt   (source=exec-event)      │
│      buildCronEventPrompt   (contextKey: cron:*)     │
│      其他普通 heartbeat prompt                       │
│  → 跑 agent turn                                     │
│  → consumeSelectedSystemEventEntries                 │
└──────────────────┬───────────────────────────────────┘
                   │ 或者：用户先开了 turn → 走兜底
                   ▼
┌───── drainFormattedSystemEvents（用户 turn 兜底）─────┐
│ src/auto-reply/reply/session-system-events.ts        │
│ · 渲染 `System: [yyyy-MM-dd HH:mm:ss] <text>` 行     │
│ · 跳过 exec-completion 和 cron-context（留给 hb own） │
│ · prepend 到 next user prompt                        │
└──────────────────────────────────────────────────────┘
```

---

## 3. 按任务类型分章节

### 3.1 Bash background（`Bash` tool `run_in_background:true` / 内置 exec 后台）

- **登记**：`src/agents/bash-process-registry.ts`，两张内存 Map（`runningSessions` / `finishedSessions`），`jobTtlMs` 后回收。
- **切换 bg**：`src/agents/bash-tools.exec.ts:1867-1888` 在 `yieldWindow` 到 / 立即 background 时 `markBackgrounded(run.session)`。
- **完成通知**：`src/agents/bash-tools.exec-runtime.ts:310-357 maybeNotifyOnExit()`
  ```ts
  const summary = output
    ? `Exec ${status} (${session.id.slice(0,8)}, ${exitLabel}) :: ${output}`
    : `Exec ${status} (${session.id.slice(0,8)}, ${exitLabel})`;
  enqueueSystemEvent(summary, {
    sessionKey: resolveEventSessionKeyForPolicy(sessionKey, eventRouting),
    deliveryContext: session.notifyDeliveryContext,
  });
  if (!isSubagentSessionKey(sessionKey)) {
    requestHeartbeat(scopedHeartbeatWakeOptionsForPolicy(sessionKey,
      { source: "exec-event", intent: "event", reason: "exec-event", coalesceMs: 0 },
      eventRouting));
  }
  ```
- **取消时静默**：`status==="failed" && exitReason==="manual-cancel" && !output` 不发，避噪。
- **subagent 内 bash bg**：only enqueue，不 requestHeartbeat（让父 session 下一个 turn 兜底）。
- **远端 (node-host) bash**：`src/gateway/server-node-events.ts:756-805` 收 `exec.started/finished/denied`，`enqueueSystemEvent(..., {contextKey:`exec:${runId}`})` + `requestHeartbeat({source:"exec-event", coalesceMs:0})`。

### 3.2 Detached agent / async subagent / Background task

- **登记**：
  - `src/tasks/task-executor.ts:115 createRunningTaskRun()` → `src/tasks/task-registry.ts:1682 createTaskRecord()`，并写 sqlite `tasks` 表（`src/tasks/task-registry.store.sqlite.ts`）。
  - 一对一 task ↔ flow 通过 `ensureSingleTaskFlow()` 建立（`task_flows` 表）。
  - subagent 侧 `src/agents/subagent-registry*.ts` 维持 `SubagentRunRecord`，同样持久化。
  - ACP 子 session 镜像逻辑在 `src/acp/control-plane/manager.background-task.ts:127-218`（`createBackgroundTaskRecord` / `markBackgroundTaskRunning` / `markBackgroundTaskTerminal`）。
- **运行中 stream（ACP child → parent）**：`src/agents/acp-spawn-parent-stream.ts:385-416`，`emit(text, contextKey)` 是核心闭包：
  ```ts
  const wake = () => {
    if (!shouldSurfaceUpdates) return;
    requestHeartbeat(scopedHeartbeatWakeOptionsForPolicy(parentSessionKey,
      { source: "acp-spawn", intent: "event", reason: "acp:spawn:stream" },
      eventRouting));
  };
  const emit = (text, contextKey) => {
    enqueueSystemEvent(cleaned, {
      sessionKey: resolveEventSessionKeyForPolicy(parentSessionKey, eventRouting),
      contextKey,
      deliveryContext: params.deliveryContext,
    });
    wake();
  };
  ```
  lifecycle `phase==="end"|"error"` 走同一 emit（`acp-spawn-parent-stream.ts:738-762`），文本类似 `ACP run completed in 12s.`，contextKey 形如 `acp:spawn:<sid>:done|error|stall|resumed|progress|start`。
- **Terminal 通知**：`src/tasks/task-registry.ts:1330 maybeDeliverTaskTerminalUpdate()`：
  - 文本由 `src/tasks/task-executor-policy.ts:31 formatTaskTerminalMessage` 拼成：`Background task done/failed/timed out/cancelled/lost/blocked: <title> (run <8>). <summary>`。
  - **出口 1**（首选）：reach 得到原 `requesterOrigin`（聊天 channel + to）→ 直接 `sendMessage()`（`task-registry.ts:1397-1413`）。
  - **出口 2**（兜底）：`queueTaskSystemEvent(task, text)`（`task-registry.ts:1286-1304`）：
    ```ts
    enqueueSystemEvent(text, {
      sessionKey: ownerKey,
      contextKey: `task:${task.taskId}`,
      deliveryContext: owner.requesterOrigin,
    });
    requestHeartbeat({
      source: "background-task",
      intent: "immediate",
      reason: "background-task",
      sessionKey: ownerKey,
    });
    ```
- **状态变化（running/progress）**：`maybeDeliverTaskStateChangeUpdate()` 同结构，`source:"background-task"`，无 contextKey override。
- **媒体生成（图片/音乐/视频后台）特殊路径**：`src/agents/tools/media-generate-background-shared.ts:539-660 wakeMediaGenerationTaskCompletion()` → `src/agents/subagent-announce-delivery.ts:1706 deliverSubagentAnnouncement()`。先 `maybeSteerSubagentAnnounce()` 试图通过 ACP/embedded queue 把消息直接 steer 进 active turn；失败再 `sendSubagentAnnounceDirectly()` 走 channel。**这是 OpenClaw 唯一一条真正"主动 push"通知，不依赖 system-event/heartbeat**。

### 3.3 Remote agents / remote sessions（node-host wire 协议）

OpenClaw 把"远端 agent"实现为 `node-host`（gateway ↔ remote node）。所有"远端完成"事件都是 wire-event，gateway 收到后转换为 system-event：

- exec.started/finished/denied → `src/gateway/server-node-events.ts:689-805`：enqueue with `contextKey: exec:<runId>` + `requestHeartbeat({source:"exec-event", coalesceMs:0})`。同一文本格式 `Exec finished (...)` 区分 success/timeout/exit≠0。
- push notification（`server-node-events.ts:618-666`）：`enqueueSystemEvent(summary, {sessionKey, contextKey: notification:<key>})` + `requestHeartbeat({source:"notifications-event", intent:"event"})`。
- **进程死的孤儿**：靠 `src/tasks/detached-task-runtime.ts:134 tryRecoverTaskBeforeMarkLost()` + `src/tasks/task-registry.maintenance.ts` 周期扫描，标 `lost` → 触发 §3.2 的 terminal delivery（再走 system-event）。

### 3.4 Workflow runs

OpenClaw 里 `Workflow` 概念落到 **task flow**：`src/tasks/task-flow-registry.ts` + `src/commands/flows.ts`，sqlite 表 `task_flows`。**flow 本身没有专用通知通道**——它是若干关联 task 的容器；其中每个 task 完成时仍由 §3.2 的 `maybeDeliverTaskTerminalUpdate()` 通知。`task-registry.ts:1675`：
```ts
const updated = updateTask(current.taskId, patch);
if (updated) {
  void maybeDeliverTaskStateChangeUpdate(current.taskId, stateChangeEvent);
  void maybeDeliverTaskTerminalUpdate(current.taskId);
}
```

### 3.5 Scheduled / cron tasks

cron 服务实现在 `src/cron/service/`；`CronCreate`/`ScheduleWakeup`/`/loop` 这些是 Claude Code 端工具名，OpenClaw 端等价于 cron job。

- **Fire main-session systemEvent**（`payload.kind === "systemEvent"`）：`src/cron/service/timer.ts:1945-2056`：
  ```ts
  state.deps.enqueueSystemEvent(text, {
    agentId: job.agentId,
    sessionKey: cronRunSessionKey,
    contextKey: `cron:${job.id}`,
    ...(deliveryContext ? { deliveryContext } : {}),
  });
  if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
    await state.deps.runHeartbeatOnce({
      source: "cron", intent: "immediate", reason,
      agentId: job.agentId, sessionKey: cronRunSessionKey,
      heartbeat: { target: "last" },
    });
  } else {
    state.deps.requestHeartbeat({
      source: "cron",
      intent: job.wakeMode === "now" ? "immediate" : "event",
      reason: `cron:${job.id}`,
      agentId: job.agentId, sessionKey: cronRunSessionKey,
      heartbeat: { target: "last" },
    });
  }
  ```
  `contextKey: cron:<jobId>` 是 heartbeat-runner 认领 cron 事件的关键 tag。auto-disable（`src/cron/service/jobs.ts:504-515`）/ failure-alert（`src/cron/service/failure-alerts.ts:152`）同模式，contextKey 加后缀。
- **手动 wake**（`cron wake`、`agentTurn`）：`src/cron/service/wake.ts:6-86` 同样 enqueue + `requestHeartbeat({source:"manual" 或 "cron"})`。
- **isolated cron agent**：`src/cron/isolated-agent/run-executor.ts`、`session.ts` 创建一次性 child session 跑 turn，结果回流再走 task-registry / system-event。
- **`runHeartbeatOnce` 同步等待**：`wakeMode === "now"` 时不走 `requestHeartbeat` 的协程调度，而是同步 `runHeartbeatOnce()`——cron tick 自己持有那一轮 heartbeat 的进度。

### 3.6 其他后台触发源

| 源 | 文件 | source | contextKey/payload |
|---|---|---|---|
| Gateway hooks (`exec_done` / agent hook) | `src/gateway/server/hooks.ts:107,194,213` | `"hook"` | `Hook <name>: <summary>` |
| Restart sentinel | `src/gateway/server-restart-sentinel.ts:81-96` | `"restart-sentinel"` | 重启后续延消息 |
| CLI watchdog stall | `src/agents/cli-runner/execute.ts:1242-1247` | `"cli-watchdog"` | 长无 stdout 提示 |
| Plugin runtime（第三方 plugin） | `src/plugins/runtime/runtime-system.ts:20-29` | `"other"`（默认） | 旧 `requestHeartbeatNow()` alias |
| Channel inbound（slack/msteams/signal/whatsapp/imessage/telegram） | `extensions/<channel>/...` | `"other"` / `"notifications-event"` | per-event |
| 媒体生成 | `src/agents/tools/media-generate-background-shared.ts:539` | n/a（直发） | n/a |
| Webhooks 插件 | `extensions/webhooks/src/http.ts` | n/a | 走 task flow ops 或 agentTurn cron，合流到 §3.2/§3.5 |
| Voice wake | `src/infra/voicewake.ts` / `voicewake-routing.ts` | n/a | 入系统事件 |

---

## 4. 通知机制对比表

| 任务类别 | 主队列 | wake 机制 | wake source | contextKey 形式 | 持久化？ |
|---|---|---|---|---|---|
| Bash bg（local） | system-events | `requestHeartbeat({coalesceMs:0})` | `"exec-event"` | 无（队尾去重） | ❌ 内存 |
| Bash bg（remote node-host） | system-events | `requestHeartbeat({coalesceMs:0})` | `"exec-event"` | `exec:<runId>` | ❌ |
| ACP subagent stream | system-events | `requestHeartbeat()` | `"acp-spawn"` | `acp:spawn:<sid>:start\|progress\|stall\|resumed\|done\|error` | task 表 ✅ |
| Detached task terminal | system-events **或** 直发 channel | `requestHeartbeat({intent:"immediate"})` | `"background-task"` / `"background-task-blocked"` | `task:<taskId>` / `task:<id>:blocked-followup` | ✅ `task_delivery_state` |
| Detached task state change | 同上 | 同上 | `"background-task"` | （无 override） | ✅ |
| Media gen | **不走 system-events** | `deliverSubagentAnnouncement()` 直 steer / 直发 | n/a | n/a | ✅ task+media artifact |
| Cron systemEvent | system-events | `runHeartbeatOnce({target:"last"})` 或 `requestHeartbeat()` | `"cron"` | `cron:<jobId>` | ✅ cron 表 |
| Cron agentTurn / isolated | 经 task-registry 合流 | 同上 | `"cron"` | `cron:<jobId>:…` | ✅ |
| Cron auto-disabled / failure-alert | system-events | `requestHeartbeat()` | `"cron"` | `cron:<jobId>:auto-disabled` / `:failure` | ✅ |
| Gateway hook | system-events | `requestHeartbeat()` | `"hook"` | – | ❌ |
| Restart sentinel | system-events | `requestHeartbeat()` | `"restart-sentinel"` | – | ✅ payload |
| 远端 push notification | system-events | `requestHeartbeat()` | `"notifications-event"` | `notification:<key>` | ❌ |
| Channel inbound | system-events | optional `requestHeartbeat()` | `"other"` / vary | per-event | ❌ |
| Plugin SDK 通用 | system-events | `requestHeartbeatNow()` | `"other"` 默认 | per-plugin | ❌ |

---

## 5. 失败 / 边界 case

### 5.1 进程死 / session crash
- **system-events queue 完全不持久化**：`src/infra/system-events.ts:32-34` 用 `resolveGlobalMap(Symbol.for("openclaw.systemEvents.queues"))`，gateway 进程一退就丢，无 sqlite mirror。
- **task 元数据持久化**：`tasks`、`task_flows`、`task_delivery_state` 表分别在 `src/tasks/task-registry.store.sqlite.ts`、`task-flow-registry.store.sqlite.ts`。重启后 `src/tasks/task-registry.reconcile.ts` + `task-registry.maintenance.ts` 周期扫描，对 still-running 但子进程消失的 task 调 `tryRecoverTaskBeforeMarkLost()`，恢复失败就 `markTaskLost` → 重新触发 `maybeDeliverTaskTerminalUpdate()`，进新 gateway 的 system-events 队列。
- **bash background**：纯内存 registry，gateway 重启子进程脱钩、pid 也丢；`notifyOnExit` 通知只在原 gateway 内有效。
- **`pendingFinalDelivery` 30s 窗口**：在 `src/agents/subagent-delivery-state.ts:23-78` 和 `src/agents/main-session-restart-recovery.ts:425-618`。这是 **subagent announce delivery** 在父 session 重启场景的补偿——父 session restart 时把"还没成功 deliver 给父的 subagent 终止通知"写 sqlite，重启后由 recovery 文件拼成 resume message 重发。**和 system-events queue 没有直接关系**；它专门补 §3.2 那条 `deliverSubagentAnnouncement` push 通道丢失的情况。

### 5.2 超时 / 取消
- Bash：`maybeNotifyOnExit` 在 manual-cancel 且无输出时主动不发通知（`bash-tools.exec-runtime.ts:325-327`）。
- Task 超时：ACP `resolveBackgroundTaskFailureStatus` 映射 `status:"timed_out"`（`manager.background-task.ts:55-57`），terminal 文本 `Background task timed out: ...`。
- Task cancelled：subagent kill 走 `src/agents/subagent-registry-run-manager.ts:745-829 markSubagentRunTerminated()` → `endedReason = SUBAGENT_ENDED_REASON_KILLED` → `emitSubagentEndedHookOnce()`；task-registry 端 `failTaskRunByRunId(status:"cancelled")` 写回终态，再走 deliver。

### 5.3 通知丢失 / 重试
- `enqueueSystemEvent` 自带 `isDuplicateSystemEvent`（`text+contextKey+deliveryContext`），retry 同文本不重复。
- `requestHeartbeat` 自带 250ms coalesce、busy 1s retry、per-target merge（`heartbeat-wake.ts:139-186`）。
- `MAX_EVENTS=20`（`system-events.ts:25`），溢出 `shift()` 最旧。**风险点**：单 session 大量 cron+exec 叠加 + heartbeat 持续 busy-skip 时旧通知可能溢出丢失。
- task-registry 侧 `tasksWithPendingDelivery` 集合（`task-registry.ts:1336-1446`）防 deliver 重入；deliver 失败回退到 enqueue + 标 `deliveryStatus:"failed"`，由 `task-registry.maintenance.ts` 周期重试。

### 5.4 与 plugin bug 的关系
关键引用 `src/auto-reply/reply/session-system-events.ts:29-37`：
```ts
// Exec completions and tagged cron events own dedicated heartbeat prompts
// (buildExecEventPrompt / buildCronEventPrompt). During heartbeat runs, leave
// cron entries queued for that owner; ordinary turns still drain them as the
// fallback when a heartbeat was skipped before it could consume the event.
return events.filter(
  (event) =>
    !isExecCompletionEvent(event.text) &&
    !(options?.suppressHeartbeatOwnedEvents === true && isCronContextSystemEvent(event)),
);
```
配合 `heartbeat-runner.ts:1009-1011, 1193-1196, 1300-1305`：cron-context 事件靠 `contextKey: cron:*` 区分，heartbeat-runner 只在 `isCronWake`（`source === "cron"`）或事件本身带 `cron:` contextKey 时认领；否则普通用户 turn 通过 `drainFormattedSystemEvents` 兜底吃掉。

**后台任务通知用的是不同 source**（`"background-task"` / `"exec-event"` / `"acp-spawn"`）和不同 contextKey（`task:*` / `exec:*` / `acp:*`），与 cron drain 隔离，**不会被 cron heartbeat 抢走**。只有走 plugin SDK 且不显式传 `source` / `contextKey` 的路径（默认 `"other"`、无 contextKey）会落入"既不被 heartbeat-runner 认领、也不被 user-turn 跳过"的灰区，那个 plugin bug 是这种形状。

---

## 6. 关键文件清单

| 文件 | 简介 |
|---|---|
| `src/infra/system-events.ts` | session-scoped 内存事件队列；`enqueue/peek/drain/consume*` |
| `src/infra/heartbeat-wake.ts` | `requestHeartbeat` + `setHeartbeatWakeHandler` 协程式 wake 调度器 |
| `src/infra/heartbeat-runner.ts` | wake handler 实现；构造 exec/cron/heartbeat prompt；consume 事件 |
| `src/infra/heartbeat-reason.ts` / `heartbeat-events-filter.ts` | 规范化 reason；判断 exec/cron 事件 |
| `src/auto-reply/reply/session-system-events.ts` | 用户 turn 兜底 drain，渲染 `System: [ts] …` |
| `src/auto-reply/reply/get-reply-run.ts` | reply 主流程，prepend system 块 |
| `src/agents/bash-process-registry.ts` | bash bg session 内存登记 |
| `src/agents/bash-tools.exec-runtime.ts` | `maybeNotifyOnExit()` |
| `src/agents/bash-tools.exec.ts` | bash fg/bg 切换点 |
| `src/agents/acp-spawn-parent-stream.ts` | ACP child → parent system-event 桥 |
| `src/agents/subagent-announce-delivery.ts` | 主动 steer/直发的 subagent 完成通知 |
| `src/agents/subagent-registry*.ts` | subagent run 元数据 + `subagent_ended` hook |
| `src/agents/main-session-restart-recovery.ts` | `pendingFinalDelivery` 重启回放 |
| `src/agents/subagent-delivery-state.ts` | pendingFinalDelivery sqlite state |
| `src/tasks/task-registry.ts` | task registry；terminal/state-change delivery；`queueTaskSystemEvent` |
| `src/tasks/task-executor.ts` | createQueued/Running/start/fail TaskRun 门面 |
| `src/tasks/task-executor-policy.ts` | terminal/state 文本拼装 + 出口策略 |
| `src/tasks/detached-task-runtime.ts` | runtime 注入点 + `tryRecoverTaskBeforeMarkLost` |
| `src/tasks/task-registry.maintenance.ts` / `.reconcile.ts` | 启动/周期 reconcile 孤儿 task |
| `src/tasks/task-flow-registry.ts` | task flow（workflow 容器）登记 |
| `src/tasks/task-registry.store.sqlite.ts` / `task-flow-registry.store.sqlite.ts` | sqlite 持久化 |
| `src/acp/control-plane/manager.background-task.ts` | ACP 子 session 与 detached task 镜像 |
| `src/cron/service/timer.ts` | cron tick → fire main-session systemEvent / agentTurn |
| `src/cron/service/jobs.ts` | cron job state + auto-disable 通知 |
| `src/cron/service/wake.ts` | 手动 wake 工具 |
| `src/cron/service/failure-alerts.ts` | cron 失败告警 |
| `src/cron/isolated-agent/run-executor.ts` / `session.ts` | isolated cron agent 跑 turn |
| `src/gateway/server-node-events.ts` | 远端 exec/notification 事件 → enqueue + heartbeat |
| `src/gateway/server/hooks.ts` | 外部 hook → enqueue + heartbeat |
| `src/gateway/server-restart-sentinel.ts` | 重启续延 |
| `src/plugins/runtime/runtime-system.ts` | plugin SDK 暴露的 enqueue/heartbeat（默认 `source:"other"`） |
| `src/plugin-sdk/system-event-runtime.ts` / `heartbeat-runtime.ts` | plugin 窄出口 |
| `src/agents/tools/media-generate-background-shared.ts` | 媒体生成 task 完成走 `deliverSubagentAnnouncement` |
| `extensions/acpx/src/claude-agent-acp-completion.test.ts` | ACP SDK `result.origin.kind==="task-notification"` 行为锁定 |

---

## 7. 未解之谜

1. **`<task-notification>` prompt 标签的来源**：在 OpenClaw 源码内除 ACPX 测试外**没有任何匹配**（grep 验证：仅 `extensions/acpx/src/claude-agent-acp-completion.test.ts:134,149` 和 `CHANGELOG.md:4066`），且 `drainFormattedSystemEvents()` 不会注入。如果用户在 prompt 里看到该标签，**几乎可以确定来自 `@agentclientprotocol/claude-agent-acp` 这个外部 SDK 的 patched 行为**（OpenClaw 在 `extensions/acpx/` ship 一份补丁）。
2. **`pendingFinalDelivery` 30s 的具体常量**：sqlite 行为 + retry 计数都见到，但 "30s" 这个数字没在 `main-session-restart-recovery.ts` 里 verbatim 找到，可能落在 `subagent-announce-retry-policy.ts` 之类策略文件里。
3. **远端 node-host 死、gateway 没收到 `exec.finished`** 的 lost 判定阈值：标 lost 由 `task-registry.maintenance.ts` 触发，但 heartbeat ping 超时 vs 周期 sweep 间隔的默认 `taskAuditConfig` / `cleanupAfter` 数值未确认。
4. **plugin SDK `source:"other"` 当前是否完全跟 cron drain 隔离**：从 `heartbeat-runner.ts` 现状看，cron drain 严格双条件（`source==="cron"` 或 `contextKey.startsWith("cron:")`），理论上 `source:"other"` 不会被误归类。当前 v2026.6.9 看起来已修，但未做 git archaeology 确认是哪个 commit 修的。
5. **subagent 内启动的 bash bg 完成**：`bash-tools.exec-runtime.ts:344` 显式跳过 `isSubagentSessionKey` 的 `requestHeartbeat`，只 enqueue。subagent 怎么"看到"该事件依赖其自身 announce 或父 session next-turn drain——未完整读完 subagent-spawn 的 reply loop。

---

## 8. 推荐配置（plugin 作者照抄）

通知主会话**后台任务**已经在 OpenClaw 内部走专用 source 实现的话，**plugin 不需要自己重新实现**——把"后台任务"建模成 task-registry 的 task（`createTaskRecord` / `failTaskRunByRunId`），完成时 OpenClaw 自动调 `maybeDeliverTaskTerminalUpdate()` 走 `source:"background-task"` + `contextKey:"task:<taskId>"`，与 cron / exec 隔离，最稳。

只有当 plugin 真的要旁路（不挂 task-registry，又要 wake session）时，**务必 verbatim**：

```ts
enqueueSystemEvent(text, {
  sessionKey,
  contextKey: `<plugin-id>:<kind>:<stable-id>`,   // 必须给，否则与 cron 共担灰区
  deliveryContext,                                // 有 channel 路由就给
});
requestHeartbeat({
  source: "exec-event",                           // ★ 不要默认 "other"
  intent: "event",
  reason: `<plugin-id>:<kind>`,
  sessionKey,
  coalesceMs: 0,                                  // 像 bash exec 一样立即触发
});
```

把 `source` 选成 `"exec-event"` 或 `"background-task"`（这两个 heartbeat-runner 都会专门构造 prompt），加上 plugin 私有前缀的 `contextKey`，就同时避开了 cron drain 抢占和 user-turn 误吞。
