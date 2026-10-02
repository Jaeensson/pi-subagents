# Optional Herdr Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add best-effort central Herdr monitoring and independently disableable, read-only viewer panes while preserving existing subagent execution.

**Architecture:** Runtime observers feed an optional monitoring controller; children continue to be owned by `process.ts`. An asynchronous CLI adapter controls only explicitly owned Herdr resources. Four reusable viewer processes read private, bounded snapshots rather than controlling children.

**Tech Stack:** Existing TypeScript/Node modules, standalone dependency-free `.mjs` viewers, `node:test`, `execFile`, atomic filesystem replacement, Herdr CLI. No added runtime packages.

**Spec:** `docs/superpowers/specs/2026-10-02-herdr-monitoring-design.md` — approved by the user on 2026-10-02. Read both documents before execution.

## Global Constraints

- Outside Herdr: no Herdr commands, executable discovery, viewer processes, monitoring files, or integration timers.
- Gate on `HERDR_ENV=1` and nonempty `HERDR_PANE_ID` and `HERDR_SOCKET_PATH`; prefer `HERDR_BIN_PATH`, otherwise `herdr` on PATH.
- `subagent.herdr.enabled` and `subagent.herdr.viewers` default to `true`; disabling viewers leaves central monitoring active.
- Four viewer panes maximum per parent session; never evict an executing task; no focus stealing or adoption by labels.
- Keep child spawning, JSON parsing, results, durable manifests, model routing, pause/resume and shutdown classification authoritative and unchanged.
- No parent `report-agent`, `report-agent-session`, or `release-agent`; metadata is display-only. No viewer native session references/resume commands.
- Metadata TTL fifteen seconds; refresh five seconds; display values at most eighty characters; own token is `subagent_summary`.
- Snapshots at most 128 KiB; at most four publications per second per slot; viewer polling 250 milliseconds.
- Snapshot heartbeat every two seconds; disconnected after ten seconds; viewer exits after thirty seconds without heartbeat.
- Private directories and `0600` files where supported. Sanitize untrusted ANSI/OSC/control sequences.
- Herdr command timeout two seconds; total cleanup budget two seconds; failures never affect children or Pi completion delivery.
- Keep existing pure modules free of Pi runtime imports and use erasable TypeScript. No monitoring dependency in core/store.
- Existing package Node floor is `>=22.19.0`; installed Herdr 0.8.2 is the compatibility baseline. Do not require custom resume APIs introduced in 0.9.2.
- Do not start long-lived resources in the extension factory; bind session resources in `session_start`, dispose idempotently in `session_shutdown`.

## Review Focus

1. Foreground process arguments may be absent: prove viewer identity with a private nonce/PID handshake, otherwise do not reuse or close a possibly unrelated process (Tasks 4, 5, 7).
2. Parent/viewer panes can move and IDs can change: resolve inherited caller identities; never target UI focus or close a destination tab the extension did not create (Tasks 4, 6, 7).
3. Executable/script paths can contain spaces, quotes and shell metacharacters; Bun/standalone parents may lack Node: quote for supported shells or skip only viewers safely (Tasks 4, 5, 7).
4. Rapid off/on, shutdown during creation, and notification bursts must not resurrect stale viewers, leak unbounded work, or suppress Pi results (Tasks 2, 6, 7, 8).
5. Truncated/malformed snapshots, unknown protocol versions, Unicode and clock changes must not crash the viewer or emit untrusted controls (Tasks 3, 5).

---

## Preparation, evidence and file boundaries

Before execution, create an isolated worktree using the worktree skill; check for overlapping uncommitted changes. Parent exploration could not access graph tools. If graph tools are available to the executor, confirm project/generation, query the bounded targets and check coverage; otherwise read the exact files listed here. Do not claim graph verification.

Baseline at `9ee813f`: `npm test` passes 270 tests, `npm run typecheck` passes. Re-run the baseline in the execution worktree. Current `tsconfig.json` has an explicit include list; `package.json.files` does not ship `.mjs` files. Both need targeted additions.

Existing boundaries verified: `core.ts:buildChildArgs`; `process.ts:spawnTask`, `finalizeTask`, `settleUnlaunchedTask`, `markInterruptedSweep`; `runtime.ts:notifyStatusChanged`, `checkJobComplete`; `jobs.ts:readSettingsFile`, `writeModelTiers`; `command-subagents.ts:runDialog`; `index.ts` lifecycle handlers.

Pi references already read completely during planning: `docs/extensions.md`, `docs/tui.md`, `docs/packages.md`, `docs/cli-integration.md`, `docs/sdk.md` under the installed Pi package; examples `examples/extensions/tools.ts` and `notify.ts`. Re-check installed declarations if the execution checkout uses a different Pi version.

| File | Responsibility |
| --- | --- |
| `settings.ts` (new) | Safe generic JSON settings read/atomic read-modify-write; no Pi imports |
| `herdr-settings.ts` (new) | Normalize/read/write only Herdr preferences |
| `herdr-core.ts` (new) | Environment gate, counts, snapshot projection/caps, pure slot selection |
| `herdr-adapter.ts` (new) | Bounded asynchronous Herdr CLI calls, response validation and command quoting |
| `herdr-files.ts` (new) | Private snapshot directory, serialized atomic writes, identity reads and cleanup |
| `herdr-viewer-render.mjs` / `.d.mts` (new) | Shared protocol types, safe standalone rendering and validation |
| `herdr-viewer.mjs` / `.d.mts` (new) | Viewer loop, identity handshake and stale-parent expiry |
| `herdr-monitor.ts` (new) | Central metadata/notifications, activation and runtime subscription; injected viewer port |
| `herdr-viewers.ts` (new) | Four-slot pane ownership, viewer launching, publishing and reuse |
| Existing runtime/process/index/settings dialog | Small additive observation/lifecycle/UI seams |

Runtime dependency direction: `herdr-settings → settings`; `herdr-core → viewer-render` (shared sanitizer/constants; runtime task/live imports type-only); `adapter → herdr-core`; `files → herdr-core`; `monitor → runtime + adapter + herdr-core`; `viewers → adapter + files + herdr-core` (monitor interfaces type-only); `index → monitor + viewers`. Viewer `.mjs` modules have only Node/standalone-render imports. No monitor/viewer module imports `jobs.ts`.

### Shared interfaces to keep consistent

These names are the contracts across tasks; define them in the indicated owning task, not as duplicate local types.

```ts
// herdr-settings.ts (Task 1)
interface HerdrOptions { enabled: boolean; viewers: boolean }

// runtime.ts (Task 2); payload excludes task text/transcripts
interface JobCompletion {
  id: string; mode: JobMode; status: Job["status"];
  total: number; unsuccessful: number; notifyOnComplete: boolean;
}
type RuntimeObservation =
  | { type: "status" }
  | { type: "trace"; taskId: string; generation: number }
  | { type: "job-finished"; completion: JobCompletion };

// herdr-viewer-render.d.mts (Task 3)
interface ViewerSegment {
  kind: "text" | "thinking" | "toolCall" | "toolOutput";
  text: string; isError?: boolean; pending?: boolean;
}
interface ViewerSnapshot {
  version: 1; activationId: string; slotId: number; nonce: string;
  seq: number; heartbeatAt: number;
  task: {
    id: string; generation: number; name: string; agent: string; model?: string;
    status: "running" | "completed" | "failed" | "aborted" | "paused" | "interrupted";
    startedAt: number; finishedAt?: number;
  };
  segments: ViewerSegment[]; truncated: boolean;
}
interface ViewerIdentity {
  version: 1; activationId: string; slotId: number; nonce: string;
  pid: number; heartbeatAt: number;
}

// herdr-core.ts (Task 3)
interface HerdrContext { binary: string; socketPath: string; callerPaneId: string }
interface PaneRef { paneId: string; tabId: string; workspaceId: string }
interface SlotIdentity { activationId: string; slotId: number; nonce: string }
interface SlotState {
  index: number; phase: "empty" | "reserved" | "ready" | "unavailable";
  taskKey?: string; taskStatus?: ViewerSnapshot["task"]["status"];
  availableSince: number;
}
```

All timestamps in snapshots/identities are milliseconds. Slot indices are zero-based. A task attempt key includes task ID and `processGeneration`, not name or agent. Sequence values are nonnegative safe integers for file snapshots; CLI report sequences are decimal strings derived from a monotonic counter (seeded from time) and are ordered for each pane/source. Keep their counter alive through setting toggles within one activation.

### Task 1: Safe settings IO and independent Herdr options

**Files:** Create `settings.ts`, `herdr-settings.ts`, `tests/settings.test.mjs`, `tests/herdr-settings.test.mjs`; modify `jobs.ts:76-169`.

**Interfaces:**
- `settings.ts`: `WriteSettingsResult = {ok:true} | {ok:false;error:string}`; `readSettingsJson(settingsPath:string): Record<string,unknown> | undefined`; `updateSettingsJson(settingsPath:string, mutate:(root:Record<string,unknown>)=>void): WriteSettingsResult`.
- `herdr-settings.ts`: `normalizeHerdrOptions(raw:unknown):HerdrOptions`, `readHerdrOptions(settingsPath:string):HerdrOptions`, `writeHerdrOptions(settingsPath:string,next:HerdrOptions):WriteSettingsResult`.
- Existing `jobs.ts:writeModelTiers` keeps its public signature and re-exports `WriteSettingsResult`; existing tier/default/retention reads keep their behavior.

- [ ] **Step 1: Add failing settings tests.** Pin these assertions, using real private temporary settings files:
  ```js
  assert.deepEqual(normalizeHerdrOptions(undefined), { enabled: true, viewers: true });
  assert.deepEqual(normalizeHerdrOptions({ enabled: false, viewers: true }), { enabled: false, viewers: true });
  assert.deepEqual(normalizeHerdrOptions({ enabled: "false", viewers: null }), { enabled: true, viewers: true });
  assert.equal(writeHerdrOptions(file, { enabled: true, viewers: false }).ok, true);
  assert.equal(readHerdrOptions(file).viewers, false);
  assert.deepEqual(readSaved(file).subagent.modelTiers, originalTiers);
  assert.equal(readSaved(file).subagent.herdr.futureKey, "preserved");
  assert.equal(writeToMalformedFile().ok, false);
  assert.equal(readMalformedBytes(), originalMalformedBytes);
  ```
  Also pin current `writeModelTiers` removal/preservation semantics and failures for unreadable/missing files; failed writes leave no temporary file. Each helper above is local fixture IO, not production API.
- [ ] **Step 2: Run** `node --test tests/settings.test.mjs tests/herdr-settings.test.mjs`; expect missing-export failures before implementation.
- [ ] **Step 3: Implement the exact IO/options interfaces.** Extract only shared settings IO, not unrelated job orchestration. Use a unique sibling temp filename and rename; preserve unknown root/subagent/Herdr keys. Never overwrite unreadable/non-object existing settings. Keep writes synchronous like the current model-tier writer so sequential dialog changes cannot race each other.
- [ ] **Step 4: Run** the two new suites plus `tests/model-context.test.mjs` and `tests/ui-interactions.test.mjs`; expect all pass with unchanged model-context results.
- [ ] **Step 5: Commit** these files as `feat: add independent Herdr monitoring preferences`.

### Task 2: Isolated additive runtime observations

**Files:** Modify `runtime.ts:179-190,221-234,421-434`, `process.ts` status/stream/finalization paths; test `tests/runtime.test.mjs`, `tests/process.test.mjs`.

**Interfaces:** Export `subscribeRuntimeObservations(listener:(event:RuntimeObservation)=>void|Promise<void>):()=>void` and `notifyTaskTraceChanged(taskId:string,generation:number):void`. Status observations reuse `notifyStatusChanged`; job completion emits the immutable `JobCompletion` payload exactly once per finalized batch. Existing hooks are retained.

- [ ] **Step 1: Add failing observer tests.** Assert:
  ```js
  assert.equal(widgetCalls, 1);                 // old status hook still runs
  assert.equal(secondObserverCalls, 1);        // first observer threw/rejected
  assert.deepEqual(traceEvent, { type: "trace", taskId: task.id, generation: task.processGeneration });
  assert.equal(completionEvents.length, 1);    // repeated checkJobComplete
  assert.equal(completionEvents[0].completion.notifyOnComplete, false);
  assert.equal(eventsAfterUnsubscribe.length, 0);
  assert.equal(await waitForJob(job.id), true); // observer failure cannot block waiters
  ```
  Use the existing fake-child spawner to assert observations after queued→dispatched, parsed output, fully settled finalization, queued pause/cancel and resume. A rejecting observer must cause no unhandled rejection; a broken legacy job-finished hook must not suppress the new observer or completion delivery. Mid-chain gaps must not emit job completion.
- [ ] **Step 2: Run** `node --test tests/runtime.test.mjs tests/process.test.mjs`; expect missing observer exports/tests to fail.
- [ ] **Step 3: Implement observation fan-out.** Guard each callback independently and attach a rejection handler without awaiting it. Capture completion scalars before sending observations. Publish trace IDs only after accepted/current-generation event parsing. Add missing status observations for unlaunched task settlement and after finalization persistence clears `finalizing`; do not change spawn/kill/persistence/waiter ordering. Observers are explicitly unsubscribed by their owners, not silently cleared by `clearRegistry`.
- [ ] **Step 4: Run** runtime/process suites and `tests/jobs.test.mjs tests/ui-interactions.test.mjs`; expect pause/resume, chain gaps, stream errors and watch-hook regressions still pass.
- [ ] **Step 5: Commit** as `feat: expose isolated subagent lifecycle observations`.

### Task 3: Bounded snapshot protocol and pure pool decisions

**Files:** Create `herdr-core.ts`, `herdr-viewer-render.mjs`, `herdr-viewer-render.d.mts`, `tests/herdr-core.test.mjs`, `tests/herdr-viewer-render.test.mjs`.

**Interfaces:** Define shared types above. Export `getHerdrContext(env:NodeJS.ProcessEnv):HerdrContext|undefined`, `attemptKey(task:Pick<Task,"id"|"processGeneration">):string`, `summarizeTasks(tasks:Iterable<Task>):TaskCounts`, `formatSummary(counts:TaskCounts):string`, `projectSnapshot(task:Task,identity:SlotIdentity,seq:number,now:number):ViewerSnapshot`, `encodeSnapshot(snapshot:ViewerSnapshot):string`, `chooseSlot(slots:readonly SlotState[]):{kind:"reuse"|"create";index:number}|{kind:"full"}`. Define `TaskCounts={executing:number;queued:number;paused:number;completed:number;unsuccessful:number}` here. Renderer exports `sanitizeText(text:string):string`, `parseSnapshot(raw:string):ViewerSnapshot|undefined`, `renderViewer(snapshot:ViewerSnapshot,options:{columns:number;rows:number;now:number;disconnected?:boolean}):string[]`; declarations match runtime exports. Export shared constants `SNAPSHOT_VERSION=1`, `SNAPSHOT_MAX_BYTES=128*1024`, `PUBLISH_INTERVAL_MS=250`, `VIEWER_POLL_MS=250`, `HEARTBEAT_INTERVAL_MS=2000`, `DISCONNECTED_AFTER_MS=10000`, `EXIT_AFTER_MS=30000` from this standalone module so producers/viewers do not drift.

- [ ] **Step 1: Add failing pure tests.** Assert:
  ```js
  assert.equal(getHerdrContext({ HERDR_ENV: "0" }), undefined);
  assert.equal(getHerdrContext({ HERDR_ENV: "1", HERDR_PANE_ID: "p" }), undefined);
  assert.equal(counts.executing, 1); assert.equal(counts.queued, 2); // includes setup work
  assert.equal(chooseSlot(fourExecutingSlots).kind, "full");
  assert.deepEqual(chooseSlot(slotsWithOldestPaused), { kind: "reuse", index: 2 });
  assert.ok(Buffer.byteLength(encoded) <= 128 * 1024);
  assert.equal(JSON.parse(encoded).truncated, true);
  assert.doesNotMatch(encoded, /original-secret-task-prompt/);
  assert.equal(sanitizeText("safe\x1b]52;c;bad\x07\x1b[31mred"), "safered");
  assert.equal(parseSnapshot('{"version":99}'), undefined);
  ```
  Include control-only/very long names, empty traces, oversized tool arguments, Unicode at truncation boundaries, reserved-slot exclusion, no mutation of `Task.live`, malformed types/unsafe sequence numbers, and backwards clock input (age never negative). Flatten tool arguments into bounded readable text; append pending text/thinking as a pending segment.
- [ ] **Step 2: Run** `node --test tests/herdr-core.test.mjs tests/herdr-viewer-render.test.mjs`; expect missing-module/export failures.
- [ ] **Step 3: Implement the exact pure interfaces.** Keep latest trace content when trimming and keep JSON valid. Use protocol version `1`, the exact spec caps/times, and source task status unchanged. Strip complete OSC/CSI and remaining C0/C1 controls while retaining newline/tab for readable text. Standalone rendering uses grapheme-aware wrapping/clipping, handles CJK/emoji/combining sequences and widths 1–80, and emits no terminal controls itself. The actual viewer adds only its own screen-update controls.
- [ ] **Step 4: Run** both suites; assert every rendered line fits its terminal-column width and output fits rows, including widths 1, 2, 3, 7 and wide Unicode.
- [ ] **Step 5: Commit** as `feat: define bounded Herdr viewer snapshots and pool policy`.

### Task 4: Safe asynchronous Herdr CLI adapter

**Files:** Create `herdr-adapter.ts`, `tests/herdr-adapter.test.mjs`.

**Interfaces:** Export `ApiResult<T> = {ok:true;value:T}|{ok:false;reason:"missing"|"unavailable"|"invalid";error:string}` and `createHerdrAdapter(context:HerdrContext,exec?:HerdrExec):HerdrAdapter`. `HerdrExec` accepts `(binary:string,args:string[],options:{env:NodeJS.ProcessEnv;timeout:number;maxBuffer:number;signal?:AbortSignal})=>Promise<string>`.

`HerdrAdapter` methods: `currentPane(callerPaneId?:string)`, `pane(id:string)`, `processInfo(id:string)`, `panes(workspaceId:string)`, `createTab(workspaceId:string,cwd:string)`, `splitPane(id:string,direction:"right"|"down",cwd:string)`, `runViewer(id:string,command:string)`, `metadata(id:string,patch:MetadataPatch)`, `viewerState(id:string,state:"idle"|"working",source:string,seq:string)`, `releaseViewer(id:string,source:string,seq:string)`, `notify(title:string,body:string)`, `closePane(id:string)`, `closeTab(id:string)`. All return `Promise<ApiResult<...>>`; `currentPane`, `pane` and `splitPane` yield `PaneRef`; `createTab` yields `{tabId:string;rootPane:PaneRef}`; `panes` yields `PaneRef[]`; `processInfo` yields `ProcessInfo={paneId:string;shellPid?:number;foregroundProcessGroupId?:number;foregroundProcesses:Array<{pid:number;name:string;argv?:string[]}>}`; action methods yield `void`. `MetadataPatch` contains `source:string`, `seq:string`, optional `ttlMs:number`, optional `tokens:Record<string,string|null>`, optional `stateLabels:Partial<Record<"idle"|"working"|"blocked"|"done"|"unknown",string>>`, and optional `clearStateLabels:boolean`. Define these types here. Adapter also exposes `scoped(isCurrent:()=>boolean):HerdrAdapter`; scoped wrappers share the underlying command scheduler and skip stale queued requests before execution. Return already-issued creation responses even when the scope changed so callers can clean up the returned IDs.

Also export `buildViewerCommand(nodePath:string,scriptPath:string,snapshotPath:string,identityPath:string,identity:SlotIdentity,shell:"posix"|"powershell"|"cmd"|"unsupported"):string|undefined` and `classifyOccupant(processInfo:ProcessInfo,identity:ViewerIdentity,expectedScript:string,now:number):"owned"|"foreign"|"unknown"`. Missing argv alone is not foreign or owned; require a matching identity PID in foreground processes and identity age `0 <= now-heartbeatAt < 10000`, and reject conflicting argv when supplied. The manager first validates activation ID, slot ID and nonce against its assigned slot. Unknown inspection forbids destructive operations.

- [ ] **Step 1: Add failing adapter tests.** Capture exact argv/options:
  ```js
  assert.deepEqual(currentArgs, ["pane", "current", "--current"]);
  assert.equal(currentEnv.HERDR_PANE_ID, requestedCallerIdentity);
  assert.ok(createArgs.includes("--no-focus"));
  assert.equal(execOptions.timeout, 2000); assert.equal(execOptions.maxBuffer, 64 * 1024);
  assert.equal(reply.reason, "missing"); // explicit pane_not_found, not generic prose
  assert.equal(classifyOccupant(argvAbsentButMatchingFreshPid, identity, script, now), "owned");
  assert.equal(classifyOccupant(unrelatedEditor, identity, script, now), "foreign");
  assert.equal(buildViewerCommand(...unsupportedShellArgs), undefined);
  assert.ok(maxConcurrentExecs <= 4); assert.ok(maxQueuedCommands <= 32);
  assert.equal(staleScopedQueuedCommandsExecuted, 0);
  ```
  Pin invalid/partial creation replies, ID mismatch, old inherited ID resolving to a moved pane, no `--tab` flag on `pane list`, timeout/stdout/stderr errors and metacharacter paths. Round-trip POSIX quoting through a disposable shell/argument-printing fixture; decode the Windows encoded launch and assert arguments are literal, including apostrophes, percent signs and `$()`.
- [ ] **Step 2: Run** `node --test tests/herdr-adapter.test.mjs`; expect missing exports to fail.
- [ ] **Step 3: Implement the methods using `execFile`, never a shell for Herdr.** Use explicit IDs and `HERDR_SOCKET_PATH`. Share a finite command scheduler across scoped wrappers, with concurrency four and at most thirty-two pending commands; report queue exhaustion as unavailable rather than growing it. Serialize reports/cleanup for the same pane across sources as well as ordering sequences for each source, and check scope validity again on dispatch. Parse `.result.pane`, `.result.root_pane`, `.result.tab`, `.result.process_info`, and `.result.panes` according to installed schema; filter workspace pane lists locally by tab ID. Fixed viewer agent label is `pi-subagent-viewer`. Metadata clearing uses only `--clear-token subagent_summary` and this source's state-label clear. POSIX quoting supports known Bourne-compatible shells; Windows uses a safely generated PowerShell encoded launch for known PowerShell/cmd shells. Reject unsupported shell/unsafe control-character paths rather than guessing. Abort/timeout is not proof an API command was never applied; do not retry creation/notification blindly.
- [ ] **Step 4: Run** adapter tests and re-inspect installed command help/schema for any syntax mismatch; expect all tests pass with zero live layout mutations.
- [ ] **Step 5: Commit** as `feat: add bounded and ownership-aware Herdr CLI adapter`.

### Task 5: Standalone viewer and private file transport

**Files:** Create `herdr-files.ts`, `herdr-viewer.mjs`, `herdr-viewer.d.mts`, `tests/herdr-files.test.mjs`, `tests/herdr-viewer.test.mjs`; modify `package.json`, `tsconfig.json`.

**Interfaces:** `createSnapshotStore(deps?:SnapshotFsDeps):SnapshotStore`, with `openSlot(identity:SlotIdentity):Promise<{snapshotPath:string;identityPath:string}>`, `publish(slotId:number,snapshot:ViewerSnapshot,isCurrent:()=>boolean):Promise<void>`, `readIdentity(slotId:number):Promise<ViewerIdentity|undefined>`, `dispose():Promise<void>`. Define `SnapshotFsDeps={fs?:Pick<typeof import("node:fs/promises"),"mkdtemp"|"chmod"|"writeFile"|"rename"|"rm"|"readFile">;tempRoot?:string}`; production uses Node async fs and the operating system's temporary directory. Identity acknowledgement is a separate bounded `.identity.json` per slot, not a durable store entry.

Viewer exports `runViewer(paths:{snapshotPath:string;identityPath:string;identity:SlotIdentity},deps?:Partial<ViewerDeps>):{stop():Promise<void>}`. Define `ViewerDeps` in the matching `.d.mts`: `readFile(path:string):Promise<string>`, `writeIdentity(path:string,identity:ViewerIdentity):Promise<void>`, `wallNow():number`, `monotonicNow():number`, `setInterval(fn:()=>void,ms:number):unknown`, `clearInterval(handle:unknown):void`, `output:{size():{columns:number;rows:number};write(frame:string):void}`, and `pid:number`. The optional dependency argument is `Partial<ViewerDeps>` with production defaults. Importing the module starts nothing. CLI main validates its arguments and calls this export only when executed directly.

- [ ] **Step 1: Add failing file/viewer tests.** Assert:
  ```js
  assert.equal(fsOps.beforeOpenSlot.length, 0);
  assert.equal(snapshotMode & 0o777, 0o600); assert.equal(dirMode & 0o777, 0o700);
  assert.ok(observedReaders.every((raw) => parseSnapshot(raw)));
  assert.equal(ready.nonce, identity.nonce); assert.equal(ready.pid, injectedPid);
  clock.advance(10_000); assert.match(lastFrame(), /disconnected/i);
  clock.advance(20_000); assert.equal(activeViewerTimers(), 0);
  assert.equal(newestPublishedSeq, 3); // held write followed by coalesced replacement
  assert.equal(filesAfterDispose.length, 0);
  ```
  Test malformed/missing/unknown-version snapshots, stale/incorrect activation and nonce, returning heartbeat recovery before expiry, wall-clock rollback/forward jump, terminal resize/Unicode, storage rejection, and dispose while directory creation/write is held. Identity is refreshed every two seconds by the viewer so stale PID files cannot prove ownership. Synchronize on deferred operations, not sleeps.
- [ ] **Step 2: Run** `node --test tests/herdr-files.test.mjs tests/herdr-viewer.test.mjs`; expect missing exports to fail.
- [ ] **Step 3: Implement the transport/viewer loop.** Memoize directory creation; serialize writes per slot and retain only the newest pending publication. Atomic temp files are private and removed on every failed/stale path. Keep at most four snapshots, four identity acknowledgements and bounded temporary writes. Poll at 250 ms, render only changed frames except resize/disconnection, write private identity heartbeats at two seconds, and exit at thirty seconds. Measure expiry with the monotonic clock since the last newly accepted snapshot sequence, not wall-clock subtraction; an unchanged file, malformed data or old sequence does not reset that deadline. Pass the derived disconnection flag to the renderer. Require nonnegative/fresh wall-clock age for ownership acknowledgements, otherwise classification is unknown rather than authorizing cleanup. Never forward stdin or send commands to children. Use fresh identity nonce/PID proof before considering viewer startup successful.
- [ ] **Step 4: Verify packaging and types.** Ship `herdr-viewer*.mjs` and `herdr-viewer*.d.mts` via `package.json.files`; add `settings.ts`, `herdr-*.ts`, declarations and `command-subagents.ts` to explicit typecheck coverage. Run new suites, `npm run typecheck`, and `npm pack --dry-run --json`; assert the actual entrypoint, renderer and declarations are included. Node `>=22.19.0` can run the `.mjs` entry without a TS loader or Pi runtime imports.
- [ ] **Step 5: Commit** as `feat: add private standalone Herdr trace viewers`.

### Task 6: Central monitor activation, metadata and notifications

**Files:** Create `herdr-monitor.ts`, `tests/herdr-monitor.test.mjs`.

**Interfaces:** `createHerdrMonitor(deps:MonitorDeps):HerdrMonitor`; methods `start(sessionId:string,cwd:string,options:HerdrOptions):void`, `applyOptions(options:HerdrOptions):void`, `stop():Promise<void>|undefined`. Inactive controllers return `undefined` on stop without creating timers; active/pending activations return a bounded cleanup promise. Define `MonitorDeps` with exact ports: `env:NodeJS.ProcessEnv`, `getTasks:()=>readonly Task[]`, `subscribe:typeof subscribeRuntimeObservations`, `adapterFactory:(context:HerdrContext)=>HerdrAdapter`, `clock:MonitorClock`, `warn:(message:string)=>void`, and optional `viewerFactory:(host:ViewerHost)=>ViewerManager`. `MonitorClock` supplies `wallNow():number`, `monotonicNow():number`, `setTimeout(fn:()=>void,ms:number):unknown`, `clearTimeout(handle:unknown):void`, `setInterval(fn:()=>void,ms:number):unknown`, and `clearInterval(handle:unknown):void`; production wrappers use Node timers without unsafe casts in callers. Export `ViewerManager = {reconcile(tasks:readonly Task[],parent:PaneRef):void;stop():Promise<void>}` and `ViewerHost = {adapter:HerdrAdapter;parent:PaneRef;cwd:string;activationId:string;isCurrent:()=>boolean;warn:(message:string)=>void}`. Factory invocation occurs only after a valid environment/context and when viewers are enabled.

- [ ] **Step 1: Add failing monitor tests.** Assert:
  ```js
  assert.equal(outsideHerdr.execCalls.length, 0); assert.equal(outsideHerdr.timers.size, 0);
  assert.equal(viewersDisabled.factoryCalls, 0); assert.ok(viewersDisabled.metadataCalls.length > 0);
  assert.equal(metadata.ttlMs, 15_000); assert.equal(metadata.tokens.subagent_summary, expectedSummary);
  assert.equal(parentLifecycleCalls.length, 0);
  assert.equal(notifyCallsForSameJob.length, 1); assert.equal(suppressedJobNotifications.length, 0);
  assert.equal(piCompletionDeliveryCount, 1); // failed Herdr notification is independent
  assert.equal(warningsAfterRepeatedErrors.length, 1);
  assert.ok(maxConcurrentCommands <= 4); assert.ok(maxPendingCommands <= 32);
  ```
  Cover no tasks/no parent decoration, five-second TTL refresh, viewer factory failure without losing metadata, startup query failure without retry loops, queued counts, moved parent identity, malformed responses, notification bursts, disable during held current-pane query, and off/on attaching existing executing tasks without replaying old completions.
- [ ] **Step 2: Run** `node --test tests/herdr-monitor.test.mjs`; expect missing monitor exports to fail.
- [ ] **Step 3: Implement the controller.** Subscribe only for a gated/enabled activation; capture completion events before enabling asynchronous work. Resolve the caller before reporting and on refresh so moved parent IDs are followed. Coalesce reports (never on each token) and use Task 4's shared bounded scheduler/scoped wrappers; drop best-effort notifications if full rather than retaining unbounded history. Reuse one underlying adapter/limiter across setting toggles while its context is unchanged, including cleanup and viewer calls, so rapid off/on cannot multiply the concurrency/queue bounds. Give the viewer factory the underlying adapter; both controllers create their own scoped wrapper for ordinary work and use the underlying adapter only for guarded cleanup. De-duplicate eligible completion events for the current activation; suppress historical replays after toggles. Use activation guards, expiring metadata, monotonic report sequences and a once-per-activation warning. Keep the parent metadata source stable for the logical parent-session binding across setting toggles (`pi-subagent:<sessionId>`, sanitized/hashed if necessary to fit eighty source characters), while snapshot activation identifiers change; keep the report sequence counter across those toggles so old accepted reports cannot outrank cleanup/new reports. Stop synchronously invalidates work/timers/subscription before bounded async metadata/viewer cleanup. Keep late already-issued API commands best-effort and never infer task success from replies.
- [ ] **Step 4: Run** monitor plus runtime suites; expect exact metadata/notification assertions and no leaked fake-clock timers after stop, including failure paths.
- [ ] **Step 5: Commit** as `feat: report optional central Herdr subagent activity`.

### Task 7: Four owned viewer panes, reusable snapshots and safe cleanup

**Files:** Create `herdr-viewers.ts`, `tests/herdr-viewers.test.mjs`.

**Interfaces:** `createViewerManager(host:ViewerHost,deps?:Partial<ViewerManagerDeps>):ViewerManager`. Define `ViewerManagerDeps` with ports `storeFactory:()=>SnapshotStore`, `resolveNode:()=>Promise<string|undefined>`, `viewerScriptPath:string`, `nonce:()=>string`, `clock:MonitorClock` and `execPath:string`; production resolves entrypoint with `import.meta.url` and uses Node clock wrappers. This optional dependency argument is `Partial<ViewerManagerDeps>`. Consume Task 3 slot policy, Task 4 adapter and Task 5 transport. Export `resolveViewerNode(execPath:string,env:NodeJS.ProcessEnv,platform:string):Promise<string|undefined>` for direct testing.

- [ ] **Step 1: Add failing manager tests.** Assert:
  ```js
  reconcile(eightTasksFourExecuting);
  assert.equal(reservations, 4); assert.equal(createdTabs, 1); assert.equal(createdPanes, 4);
  assert.equal(activeViewerEvictions, 0);
  assert.equal(reusedSlot.taskKey, attemptKey(newTask));
  assert.doesNotMatch(reusedSnapshot, /prior-slot-occupant/);
  assert.equal(parentFocusCommands.length, 0);
  assert.equal(recreatedManuallyClosedAttemptCount, 0);
  assert.equal(childKillCalls.length, 0);
  assert.equal(closedForeignPaneIds.length, 0);
  assert.equal(closedUnownedTabIds.length, 0);
  ```
  Hold creation, then disable/stop: resolving it later must clean up the returned pane without starting a viewer. Hold a snapshot write, resume/reassign: the old generation must not win. Include moved viewer resolution through its original caller identity, user-added panes in the owned tab, fresh identity PID with absent argv, stale identities, unknown occupant inspection, missing Node under Bun/standalone, node/script paths with metacharacters, publication rate≤4/sec and retained-output heartbeats every two seconds.
- [ ] **Step 2: Run** `node --test tests/herdr-viewers.test.mjs`; expect missing manager export to fail.
- [ ] **Step 3: Implement manager lifecycle.** Reserve synchronously before awaiting layout. Create only one owned tab; split root right, then left down and right down for four-pane layout. Reuse inactive slots oldest-first after identity/process inspection. Prefer parent Node, otherwise search executable Node in PATH only inside the gate. Inspect the new shell before launching; skip unsupported/unknown shell rather than sending a guessed command. Confirm the private identity handshake within two seconds using injected timers. Use current-pane resolution with the viewer's original inherited pane identity before inspection/report/reuse/cleanup; track returned live IDs without adopting destination tabs. Unknown/foreign occupants prohibit closure/relaunch, and confirmed foreign work relinquishes the slot. Only an explicit missing response suppresses reopening that attempt. Coalesce writes, guard every await by activation and task generation, and publish retained final output/heartbeats. On failure do not retry blind creation or touch the child.
- [ ] **Step 4: Verify** viewer/adapter/file/core suites together. Cleanup inspection, release and close use explicit owned resources and the total two-second deadline; concurrent late creation completions get best-effort rollback. Removing files cancels further writes and stops stale viewers even if pane cleanup cannot finish. No unrelated tab closes; no in-flight callback creates a replacement after stop.
- [ ] **Step 5: Commit** as `feat: manage four reusable read-only Herdr viewer panes`.

### Task 8: Extension lifecycle and settings-dialog integration

**Files:** Modify `index.ts`, `command-subagents.ts`, `tests/ui-interactions.test.mjs`; create `tests/herdr-extension.test.mjs`; update module guidance in `AGENTS.md`.

**Interfaces:** Change registration to `registerSubagentsCommand(pi:ExtensionAPI,onHerdrOptionsChange?:(next:HerdrOptions)=>void):void`. Keep default callers compatible. For lifecycle testing, allow `index.ts`'s default factory an optional second argument `{createMonitor?:typeof createHerdrMonitor}`; normal Pi loading continues to pass only `pi`. The injected factory receives the same fully constructed dependencies and returns a `HerdrMonitor`. `index.ts` constructs the monitor without starting resources, supplies the viewer factory, reads preferences from `path.join(getAgentDir(),"settings.json")` on session start, and passes successful UI changes to `monitor.applyOptions`.

- [ ] **Step 1: Add failing UI/lifecycle tests.** With captured extension hooks and injected monitor dependencies, assert:
  ```js
  assert.equal(factoryTimeCommands.length, 0); assert.equal(factoryTimeTimers.size, 0);
  assert.equal(startBeforeHasUiGuard, true); // monitoring also works in non-TUI parents
  assert.equal(outsideHerdrCommands.length, 0);
  assert.equal(saved.subagent.herdr.viewers, false); assert.equal(saved.subagent.herdr.enabled, true);
  assert.equal(applyOptionsCalls.length, 1); assert.equal(callbackAfterFailedSave.length, 0);
  assert.equal(tierClearedWhenHighlightingHerdrRow, false);
  assert.equal(originalWidgetAndWatchStillWork, true);
  assert.equal(durableSweepStartedBeforeMonitorCleanupResolved, true);
  assert.equal(shutdownFakeChildWasReaped, true);
  ```
  Exercise toggling auto with Herdr rows present, submenu cancel and ctrl-alt-l, multiple lifecycle starts/shutdowns, rejected/hanging monitor stop, and viewer-off cleanup while children continue. Clear inherited Herdr variables in unrelated existing UI tests so default-on behavior cannot mutate the developer's real session.
- [ ] **Step 2: Run** `node --test tests/ui-interactions.test.mjs tests/herdr-extension.test.mjs`; expect missing callback/integration assertions to fail.
- [ ] **Step 3: Wire lifecycle and menu.** Guard monitor errors at the entry boundary; preserve existing widget/watch registration. Use stable row IDs `auto`, `fast`, `balanced`, `deep`, `herdr-enabled`, `herdr-viewers`; derive tier targeting from the selected item's ID rather than `selectedIndex-1`. Append both Herdr rows even with auto tiers on. After a successful preference write invoke the optional callback, retain active values after a failed save, and show effective-disabled explanation without erasing the viewer preference. Shutdown closes the spawn gate and starts monitor stop without awaiting it before durable interruption/child reaping; at the end await cleanup only if stop returned a promise, guarded by an independent two-second timeout/rejection handler so even a defective stop cannot hang shutdown. Do not create that guard timer when stop returned `undefined` (including outside Herdr). Non-TUI warnings use bounded sanitized stderr, never JSON stdout.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`; all existing and new tests must pass. Verify dependency directions and update `AGENTS.md` module responsibilities without introducing runtime Pi imports into pure modules.
- [ ] **Step 5: Commit** as `feat: integrate optional Herdr monitoring and viewer switches`.

### Task 9: Shipping documentation and isolated live verification

**Files:** Modify `README.md`; create `scripts/herdr-monitor-smoke.mjs`, `scripts/herdr-monitor-smoke-driver.mjs`, `tests/herdr-smoke-safety.test.mjs`. Scripts are developer validation tools, not extension entrypoints.

**Interfaces:** Launcher exports `runSmoke(deps?:Partial<SmokeDeps>):Promise<{sessionName:string;checks:string[]}>`; define `SmokeDeps` in its JSDoc with `binary:string`, `env:NodeJS.ProcessEnv`, `exec:HerdrExec`, `spawnServer:(binary:string,args:string[],env:NodeJS.ProcessEnv)=>ChildProcess`, and `tempRoot:string`. Driver exports `runSmokeDriver():Promise<void>`. Importing either module performs no work; CLI main is guarded by direct-entry detection. Smoke launcher owns a uniquely generated named test session and temporary config/agent directory; driver runs in that session's own pane. Scripts use explicit named-session commands, parse creation IDs and clean up only the generated session/resources. Driver supplies fake JSON child processes through existing `spawnProcess` injection so actual Herdr rendering is verified without paid model calls. It uses isolated `PI_CODING_AGENT_DIR`, existing extension hooks, and emits bounded completion markers for the launcher to assert.

- [ ] **Step 1: Add failing smoke-safety tests.** Assert launcher command plans never reference the inherited/default socket, never use bare `herdr` to attach, stop/delete only their generated session name, and clean up on driver failure. Use injected CLI execution; `npm test` must not create Herdr sessions. Explicit live smoke is opt-in via `node scripts/herdr-monitor-smoke.mjs`.
- [ ] **Step 2: Run** `node --test tests/herdr-smoke-safety.test.mjs`; expect missing script exports/command plan to fail.
- [ ] **Step 3: Implement the opt-in smoke harness and README section.** Start a disposable named headless server using the installed CLI's session argument; generate a temporary default config rather than loading user plugins/config. Clear inherited Herdr routing variables in the launcher. Inside the driver's own pane establish a test-only custom parent reporter, run four fake children through the real extension lifecycle, emit text/thinking/tool events, finish one, and run another to prove reuse. Assert real pane metadata, viewer text/status, no focus stealing, four-pane cap, `viewers:false` closing viewers while jobs continue, and `enabled:false` clearing integration metadata. Verify plain-terminal inactivity with Herdr variables removed and simulate parent heartbeat loss. README documents both JSON keys/defaults, immediate `/subagents` changes versus `/reload` for manual edits, retained output, read-only panes, failure fallback, and the distinction between display labels and semantic parent state.
- [ ] **Step 4: Run final verification.** Commands: `npm test`, `npm run typecheck`, `npm pack --dry-run --json`, `node scripts/herdr-monitor-smoke.mjs`, `git diff --check`. Inspect the produced pack file list and run the viewer from a temporary unpacked tarball to catch omitted assets/path assumptions. Record Herdr, Pi and Node versions; disclose any untested OS/shell instead of asserting cross-platform success. If live Herdr is unavailable, report that verification as blocked, not passed. Verify live mutations are confined to the disposable session.
- [ ] **Step 5: Commit** as `docs: document and verify optional Herdr monitoring`; run the required fresh whole-branch review for the selected execution method before claiming completion.

## Plan self-review and handoff

Coverage map: spec settings/gate → Tasks 1, 6, 8; central monitoring/notifications → Tasks 2, 3, 4, 6; four viewers/retention → Tasks 3, 5, 7; failure/ownership/shutdown → Tasks 2, 4–8; packaging/docs/live verification → Tasks 5, 9. All twelve spec acceptance groups have owning tests above. The five Review Focus conditions each have explicit regression assertions in their owning tasks.

Known API limitations: CLI timeouts cannot prove a request was unapplied; rollback requires known returned IDs, otherwise the named smoke/session or user-visible shell may require manual cleanup. Unknown foreground ownership deliberately prefers leaving a pane behind over closing unrelated work. These limitations never justify changing task results or retrying creation blindly.

Recommended execution method: **Native**, followed by one fresh whole-branch reviewer on the most capable model. Most tasks consume tightly coupled interfaces defined earlier; staying in one implementation context reduces repeated reconstruction, while isolated tests and the final independent review cover the optional observer's failure risks.

Stop here. Ask the user to review this plan and select Native or Subagent-driven execution before any product code changes. During execution, mark each step as completed only after fresh test evidence and review gates for the selected method.
