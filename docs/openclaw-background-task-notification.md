# OpenClaw 通知架构：源码分析与 plugin 实践

> OpenClaw v2026.6.10，基于 `/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/dist/` 源码逆向。
> 配合 `claude-code-openclaw-plugin` 的多次现场调试，记录了从"完全不通知"到"可靠推送"的完整路径。

---

## 1. 通知系统的两条腿

OpenClaw 的通知机制就两个原语，所有后台任务（bash bg / cron / ACP / task terminal / plugin）最终都汇到这里：

```
enqueueSystemEvent(text, {sessionKey, contextKey, deliveryContext})
    → 写 per-session 内存队列（MAX_EVENTS=20，进程退出即丢）

requestHeartbeat({source, intent, reason, sessionKey, agentId})
    → 唤醒 heartbeat-runner，在下一个可用的 turn 里处理
```

普通用户 turn 是兜底：`drainFormattedSystemEvents` 把队列事件渲染成 `System: [ts] …` 行，prepend 到下一次 prompt 前。

**不存在"主动 push 通知"API。** 只有一条例外：media-gen 的 `deliverSubagentAnnouncement()` 直接 steer 到 ACP/embedded turn 或直发 channel，但这是内部专有路径，plugin 不可用。

---

## 2. Heartbeat wake 机制（heartbeat-wake.ts）

```
requestHeartbeat(opts)
  → queuePendingWakeReason  → pendingWakes.set(targetKey, wake)
  → schedule(250ms coalesce) → setTimeout → handler(pendingWakes)
    → handler returns {status: "skipped", reason: "requests-in-flight"}
      → isRetryable → re-queue + schedule(1s retry)
    → handler returns {status: "ran"} → done
```

### 2.1 Wake payload 白名单（关键发现）

`heartbeat-runner.js:759`：
```javascript
isWakePayload: source === "hook" || source === "acp-spawn" || reason === "wake"
```

**只有这三个值被识别为 wake payload。** `source: "background-task"` 不在白名单里——这是 OpenClaw 自己的 detached task system 用的 source，但它**不触发 wake payload 处理**。

### 2.2 `isWakePayload` 的影响

| `isWakePayload` | `shouldInspectPendingEvents` | 行为 |
|:---:|:---:|---|
| `true` | `true` | 检查 pending events → 分类（exec/cron）→ 生成 prompt |
| `false` | 取决于 `hasTaggedCronEvents` | interval heartbeat 不检查（除非有 cron: event） |

### 2.3 `getSize("main")` 瓶颈

`heartbeat-runner.js:964`：
```javascript
if (getSize("main") > 0) return { status: "skipped", reason: "requests-in-flight" };
```

**所有 agent 共享同一个全局 `main` command lane。** 当 `agent:main:main` 在跑模型调用（用户正在聊天），`getSize("main") > 0` 恒为真，任何 heartbeat run 都被跳过。

`isolatedSession: true` 不绕过这个检查——它在 1147 行才创建，busy check 在 964 行就拦住了。

### 2.4 Priority 和 Deferral

```javascript
REASON_PRIORITY = { RETRY: 0, INTERVAL: 1, DEFAULT: 2, ACTION: 3 }

shouldDeferWake():
  intent === "immediate" → { defer: false }（除非 flood guard 触发）
  intent === "event"     → 检查 nextDueMs + min-spacing
  intent === "scheduled" → 严格按 nextDueMs
```

Flood guard：60s 窗口内 ≥5 次 run → defer。

---

## 3. System event 消费逻辑

### 3.1 `resolveHeartbeatRunPrompt` 只认三种事件

`heartbeat-runner.js:866-925`：

| 类型 | 匹配条件 | 生成的 prompt |
|------|---------|-------------|
| Exec completion | `isExecCompletionEvent(text)` — 匹配 `exec finished(...)` 或 `exec completed(id, code N)` | `buildExecEventPrompt`："An async command has completed..." |
| Cron event | `contextKey.startsWith("cron:")` | `buildCronEventPrompt`："A scheduled reminder has been triggered..." |
| Default | 其他所有 | `resolveHeartbeatPrompt(cfg)` — 通常是 null |

**如果没有 heartbeat file tasks，且没有 exec/cron 事件，prompt 为 null → 返回 `skipped: no-tasks-due`。**

### 3.2 `selectSystemEventsConsumedByHeartbeat`

```javascript
function selectSystemEventsConsumedByHeartbeat(params) {
  if (!preflight.shouldInspectPendingEvents || ...) return [];
  if (params.hasExecCompletion) return events.filter(isExecCompletionEvent);
  if (params.hasCronEvents) return events.filter(isCronSystemEvent);
  return preflight.pendingEventEntries;  // ★ catch-all: 返回所有！
}
```

**catch-all 是真正的杀手。** 当时 `shouldInspectPendingEvents=true` 但 `hasExecCompletion=false` 且 `hasCronEvents=false`，所有 pending events 都被消费。

### 3.3 `task:` vs `cron:` prefix（关键发现）

`hasTaggedCronEvents = events.some(e => e.contextKey?.startsWith("cron:"))`

| prefix | `hasTaggedCronEvents` | interval heartbeat `shouldInspectPendingEvents` | 后果 |
|--------|:---:|:---:|---|
| `task:` | `false` | `false`（全部四个 flag 都是 false） | **不检查、不消费** ✓ |
| `cron:` | `true` | `true` | 检查 → 消费 → 但 interval 不生成 prompt → **事件被静默删除** ❌ |

**`task:` prefix 是唯一能存活过 interval heartbeat 的选择。**

### 3.4 消费时机

```
isWakePayload=true  + prompt≠null → line 1228: consume(events)  → 正常（生成 reply 时消费）
isWakePayload=false + shouldInspect=true → line 1139: consume(events) → 危险（skipped 时静默消费）
```

---

## 4. 后台任务的三种通知模式

### 4.1 Session resume（exec-approval-followup）

`bash-tools.exec-approval-followup.ts`：后台 exec 完成 → `callGatewayTool("agent", {sessionKey, message})`。

这是 **gateway 内部 method call**，直接把 prompt 注入 agent session，agent 当场处理并回复用户。不经过 system event queue，不经过 heartbeat。

**Plugin 不可用。** 等价的 `dispatchGatewayMethod` 要求 HTTP route scope 有 `gatewayMethodDispatchAllowed=true`，但 `auth: "plugin"` 路由的 scope 不带这个 flag——即使 manifest 声明了 `contracts.gatewayMethodDispatch`。

### 4.2 Direct delivery（fallback）

Session resume 失败 → `sendMessage({channel, to, content})` 直发消息到 channel。

Plugin 等价方案：**wecom webhook** — POST markdown 到企业微信 webhook URL。绕过整个 OpenClaw 通知系统。

### 4.3 System event + wake（通用路径）

ACP spawn、bash bg、cron 都用这路径。事件进队列，wake poke agent。最终效果：
- agent 在 turn 中：system event 作为 `System:` 行出现
- agent 不在 turn：等下一个 turn（用户发消息）

---

## 5. ACP spawn 架构

`acp-spawn-BEA0VnCe.js`：

```javascript
const emit = (text, contextKey) => {
  enqueueSystemEvent(cleaned, {
    sessionKey: parentSessionKey,
    contextKey,                          // "acp-spawn:<runId>:start|done|error|..."
    deliveryContext: params.deliveryContext,  // ★ 从 parent turn 带来的 channel 路由
  });
  wake();  // source: "acp-spawn", intent: "event"
};
```

ACP 能工作是因为：
1. **parent 在 turn 里**（agent 调了 `sessions_spawn`，正在等 tool 返回）→ main lane 空闲 → wake 秒级处理
2. **有 `deliveryContext`**（当前 turn 的 channel/to 信息）→ reply 能路由回用户
3. **`source: "acp-spawn"`** 在 `isWakePayload` 白名单里

---

## 6. Plugin 实践的结论

经过 20+ 次迭代（v0.4.1 → v0.7.1），最终确认的可靠配置：

### 当前生效路径

```
Claude Code SessionEnd hook
  → plugin 收到
    ├── wecom webhook POST → 即时文本通知（如果有配置 wecomWebhookUrl）
    ├── exec-format event → agent:main:main 队列（task: prefix → 不被 interval 消费）
    ├── wake (source: "hook") → 尝试唤醒
    └── 用户发下条消息 → drainFormattedSystemEvents → agent 看到结果
```

### 试过但失败的路径

| 尝试 | 版本 | 失败原因 |
|------|------|---------|
| `source: "background-task"` | ≤0.5.2 | 不在 `isWakePayload` 白名单 → 事件被静默消费 |
| `contextKey: "cron:"` | 0.5.4 | interval heartbeat 抢先消费事件 → 事件丢失 |
| `dispatchGatewayMethod("agent")` | 0.7.0 | scope 无 `gatewayMethodDispatchAllowed` |
| `isolatedSession: true` | 0.6.1 | `getSize("main")` 在 isolated session 创建之前检查 |
| `notificationSessionKey` | 0.6.3 | 不同 agent 的 session 无 delivery context → 无法路由 reply |

### 最终配置

| 配置 | 用途 |
|------|------|
| `targetSessionKey`（默认 `agent:main:main`） | spawn 归属 + system event 队列 + wake target |
| `wecomWebhookUrl`（可选） | 绕过 OpenClaw 的即时文本推送 |

### Wake 参数（最终版）

```typescript
requestHeartbeatNow({
  source: "hook",        // ★ isWakePayload=true 白名单
  intent: "immediate",   // 不 defer
  reason: `claude-code:${sessionId}:${state}`,  // 唯一，防 dedup
  sessionKey: targetSessionKey,
  agentId,
});
```

### Event 格式（最终版）

```
exec completed (claude-code-<id>, code 0) :: 🚨 Claude Code session <name> finished.
> analysis result excerpt...
```

- Exec format → `isExecCompletionEvent=true` → `hasExecCompletion=true` → 生成 prompt
- `task:` prefix → interval heartbeat 不消费
- `source: "hook"` → `isWakePayload=true` → wake 时不静默消费

---

## 7. 关键源码文件

| 文件 | 功能 | 关键行号 |
|------|------|---------|
| `heartbeat-runner-Df4cCdpO.js` | heartbeat 主逻辑 | 759(isWakePayload), 778(replyToWake), 866(resolvePrompt), 926(selectConsume), 964(getSizeMain), 1139(consumeOnSkip), 1147(isolatedSession), 1228(consumeOnRun) |
| `heartbeat-wake-B1PwAt1V.js` | wake 调度器 | 62(queuePending), 100(schedule), 169(registerHandler), 195(requestHeartbeat) |
| `heartbeat-events-filter-5kQ8A6OW.js` | exec/cron 事件识别 | isExecCompletionEvent, isCronSystemEvent, buildExecEventPrompt |
| `system-events-B4uVi8eM.js` | 事件队列 | enqueueSystemEvent, peekSystemEventEntries, consumeSelectedSystemEventEntries, resolveSystemEventDeliveryContext |
| `acp-spawn-BEA0VnCe.js` | ACP spawn 通知 | 274(wake), 282(emit), contextPrefix |
| `bash-tools-Bvyb7cWG.js` | bash bg 通知 | 260(buildExecApprovalFollowupPrompt), 352(buildAgentFollowupArgs), 385(sendExecApprovalFollowup) |
| `delivery-context.shared-BjCF5MAj.js` | delivery context | normalizeDeliveryContext, mergeDeliveryContext |
| `targets-D3UePr8z.js` | delivery target 路由 | resolveHeartbeatDeliveryTarget, resolveHeartbeatDeliveryTargetWithSessionRoute |
| `heartbeat-visibility-BWEWr0c7.js` | channel 可见性 | showAlerts, showOk, useIndicator |
| `gateway-method-runtime-BFMT067e.js` | gateway method dispatch | dispatchGatewayMethod (需要 scope 权限) |

---

## 8. 架构图

```
                         Claude Code 完成
                              │
                              ▼
              ┌───────────────────────────┐
              │  plugin hook handler      │
              │  POST /claude-code/hook   │
              └──────────┬────────────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
   ┌──────────────────┐  ┌─────────────────────┐
   │ wecom webhook    │  │ enqueueSystemEvent   │
   │ (即时文本通知)   │  │ exec completed(...)  │
   │ 100% 可靠        │  │ task: prefix         │
   └──────────────────┘  └──────────┬──────────┘
                                    │
                         ┌──────────┴──────────┐
                         │                     │
                         ▼                     ▼
              ┌──────────────────┐  ┌──────────────────────┐
              │ requestHeartbeat │  │ system event queue   │
              │ source:"hook"    │  │ (agent:main:main)    │
              │ isWakePayload ✓  │  │ task: prefix → safe  │
              └────────┬─────────┘  └──────────┬───────────┘
                       │                       │
                       ▼                       │
              ┌──────────────────┐             │
              │ getSize("main")  │             │
              │ > 0 → skip+retry │             │
              │ = 0 → run        │             │
              └────────┬─────────┘             │
                       │                       │
           ┌───────────┴───────────┐           │
           │ 空闲时                │ 忙时      │
           ▼                       ▼           │
   ┌──────────────┐      ┌──────────────┐      │
   │ heartbeat    │      │ 事件留在队列 │      │
   │ exec prompt  │      │ 等待下次turn │◄─────┘
   │ → agent reply│      └──────────────┘
   │ → user 可见  │
   └──────────────┘
```
