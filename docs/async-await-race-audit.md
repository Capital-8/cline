# Async `await`-race audit — local method-level patterns (pass 1)

Status: **audit only, no fixes applied.** Scope: `apps/vscode/src` (excl. `generated/`, tests), then `sdk/packages/{shared,llms,agents,core,sdk}/src` (excl. `dist/`, tests, fixtures). Method: crude brace-tracked async-function scanner (check→await→mutate, read→await→write-same-field, guard-set-after-await, push-after-await, clear→await→use) + manual full-function review of every distinct candidate region. Criterion for CONFIRMED: a second concurrent call on the same instance/key certainly interleaves badly locally — no lock, no synchronously-stored in-flight promise, no re-check after the `await`, no single-caller guarantee in the method.

Reference (correct) patterns already in-tree — the fix shape for every finding below: `OcaAuthService.refreshAuthState()` (`sdk`/`vscode` auth, `_refreshInFlight` IIFE stored synchronously, cleared in `finally`), `AgentRuntime.ensureInitialized()` (`this.initialization ??= this.initialize()`), `FeatureFlagsService` pending-poll dedupe, `McpHub` generation counters, `StatePostDebouncer` (sets `inFlight=true` synchronously before `await`), `CronService/HubScheduleService/CronRunner/AgendaTaskManager/UnifiedConfigWatcher.start()` (set `started=true` *before* first `await`), promise-chained queues (`enqueueRefresh`, `refreshQueue`).

Note the recurring tell: several findings are one-line deviations from a correct idiom used a few lines away (`this.x = await …` vs `this.x ??= …`; clearing a dedupe promise before the follow-up `await save…`).

---

## CONFIRMED — `apps/vscode`

### V1. Cancelled hook still spawns — `src/core/hooks/HookProcess.ts:140-195` (`run()`)
`abortHandler` early-returns unless `this.childProcess` exists; the only spawn happens after `await getHookLaunchConfig()` (L176). Abort during that await consumes the `{once:true}` listener (L169) doing nothing; the IIFE then spawns anyway (L189) and the promise never rejects via abort. Also: a second `run()`/cleanup interleaving overwrites `childProcess`/`timeoutHandle`, orphaning the first child (timeout/abort only reference the newest fields). **Fix:** re-check `abortSignal.aborted` (and an `isCompleted`/run-generation flag) immediately after the await, before `spawn`; have `abortHandler` set a sticky `aborted` flag + reject even when `childProcess` is undefined. Severity: high (executes user code after cancellation).

### V2. Refresh-token rotation race / spurious logout — `src/integrations/openai-codex/oauth.ts:462-490, 539-574` (`forceRefreshAccessToken`, `getAccessToken`)
Dedupe is correct up to the await, then broken: `this.refreshPromise = null` (L478/558) **before** `await this.saveCredentials(...)`, and `saveCredentials` (L517-523) only assigns `this.credentials` after two awaits. A caller arriving in that window sees no in-flight promise and stale (pre-rotation) credentials, starts a second refresh with the old refresh token; under rotation the loser gets `invalid_grant` and its catch path `clearCredentials()` (L486/567) wipes the winner's freshly saved credentials. Last-finisher `saveCredentials` can also regress the stored token. **Fix:** clear `refreshPromise` in `finally` *after* `saveCredentials`, and assign `this.credentials = newCredentials` synchronously before saving. Severity: high.

### V3. Two `WorkspaceRootManager`s, leaked + divergent — `src/sdk/SdkController.ts:2770-2798` (`ensureWorkspaceManager`)
Classic form from the brief: check `!this._workspaceManager || key changed` (L2789), then `this._workspaceManager = await WorkspaceRootManager.fromPaths(...)` (L2790) — the field stays unset/stale for the whole await, so a concurrent caller builds a second manager; completion order decides the survivor, the other is never disposed, and callers that already returned hold different instances (inconsistent roots/caches/watchers). A third variant: B (new paths) overwrites A's manager, then A applies its older `pathsKey`. **Fix:** memoise the in-flight promise synchronously keyed by `pathsKey`: `this._workspaceManagerPromise ??= …` (clear on failure / key change, dispose superseded manager). Severity: medium-high.

### V4. Duplicate cloud-session restore + duplicate turns — `src/sdk/cloud-session-host.ts:317-363` (`ensureInnerSessionLive`/`send`)
`if (restoreConfig && !this.innerSessionLive) await this.ensureInnerSessionLive(...)` (L341); `innerSessionLive` is only set at L335 after up to three awaits (`updateSessionConnection`, `readSessionMessages`, `restoreConfig()`, `startSession`). Two concurrent `send()`s both restore (server-side `session_already_exists` is handled, L332, so restore itself mostly survives) and then **both** call `host.runTurn()` (L344) on the same inner session — duplicate agent turns / interleaved persistence. Single-threaded callers make this caller-dependent, hence ranked below V1-V3. **Fix:** store/share the restore promise synchronously (`this.innerSessionRestorePromise ??= …`), clear on failure; consider a per-host turn-in-flight assertion. Severity: medium.

### V5. Duplicate Chromium, one leaked — `src/services/browser/BrowserSession.ts:155-210` (`launchBrowser`/`launchLocalBrowser`/`launchRemoteBrowser`)
No launching/in-flight guard: two concurrent `launchBrowser()`s both pass L156, both suspend in `getDetectedChromePath()`/`launch()`/`connect()`, second assignment to `this.browser` orphans the first Chromium ( `closeBrowser()` only closes the current reference); both then `this.page = await this.browser?.newPage()` on the survivor. Note per-task `BrowserSession` instances narrow real-world concurrency — treat as latent unless a session is shared. **Fix:** `this.launchPromise ??= (async()=>{…})()` pattern + clear in `finally`. Severity: medium (latent).

### V6. Same, smaller — `src/services/browser/UrlContentFetcher.ts:11-29` (`launchBrowser`)
`if (this.browser) return` → `await ensureChromiumExists()` → `this.browser = await puppeteer.launch(...)` → `this.page = await …newPage()`. Concurrent URL mentions on one fetcher launch two Chromiums; first is orphaned, callers share/race `page` in `urlToMarkdown()`. Same `??=` fix. Severity: medium (latent; depends on fetcher sharing in `core/mentions/index.ts`).

### Uncertain (needs caller analysis — pass 2)
- `hosts/external/AuthHandler.ts:48-56` `getCallbackUrl()` — rejection path can yield port-0 URL; retry/race behaviour is caller-side.
- `sdk/sdk-session-lifecycle.ts:359-384` `restoreActiveSession()`, `:288-313` `attachExistingSession()` — unconditional `activeSession` assignment after await; appears serialized by the rebuild scheduler, not provable locally.
- `sdk/sdk-provider-change-coordinator` / `sdk-session-config-change-coordinator` (generation/`shouldContinue` tokens — likely the correct-pattern exemplar; verify token is always threaded).
- `sdk/auth-service.ts:401-413` `refreshAccessToken()` — currently safe (no await between check and promise creation) but fragile to the next edit.
- `sdk/state-post-debouncer.ts:66-122` — `post()` during `dispose()`'s await can start a post-disposal flush if any caller still holds the debouncer.

---

## CONFIRMED — Cline SDK (`sdk/packages`)

### S1. Duplicate MCP HTTP client + leaked transport — `packages/core/src/extensions/mcp/client.ts:776-850` (`SdkUrlMcpClient.connect`)
`if (this.client) return` (L777) → `await authContext.provider.tokens()` (L800) → local `client` → `await client.connect()` → `this.client = client` (L825). Two concurrent connects both handshake; second overwrites first; `disconnect()` (L846-850) closes only the survivor. `ensureConnectedClient()` (L915-925) re-checks after await but cannot prevent it — both callers are inside `connect()` by then. **Fix:** `this.connectPromise ??= …` stored synchronously, cleared in `finally`. Severity: high (default path for every remote MCP tool call).

### S2. Duplicate MCP stdio child process — same file, `:248-291` (`StdioMcpClient.connect`)
`if (this.connected) return` (L249) but `connected=true` only at L290, after `await ensureAgentPluginDataDirectory()` (L263), `spawnProcess` (L264), `await request("initialize")`. Concurrent callers spawn two children; second overwrites `this.process`/`processClose`/handlers, both share `this.pending`; `disconnect()` reaps only the current child — the other MCP server process leaks for the process lifetime. Severity: high.

### S3. (Found verifying S1/S2) Manager amplifies both — `packages/core/src/extensions/mcp/manager.ts:237-265` (`connectState`), via `ensureConnectedClient:225-235`
`if (state.status==="connected" && state.client) return` (L243), then sets `status="connecting"` — a value no guard checks — then `client ??= await this.clientFactory(...)` (L250): concurrent callers create two clients, both assign `state.client` (L253), both `await client.connect()` (L254, compounding S1/S2), and a failure path can `disconnect()` the winner's client and mark `disconnected` underneath it. A `runExclusive` helper exists in the same file (L290) but is not used here. **Fix:** route `connectState` through `runExclusive` per-server, or store `state.connectPromise` synchronously. Severity: high — this is the entry point that makes S1/S2 reachable concurrently (`listTools/callTool/...` all funnel through `ensureConnectedClient`).

### SDK otherwise clean in this pass
27 other distinct candidate regions reviewed and classified SAFE, notably: `packages/agents` `AgentRuntime.ensureInitialized` (`??=`), `hub-client.ready()` (get-then-`.then` chain stored before await), `user-instruction-service` (`this.ready = watcher.start()` sync assignment), `unified-config-file-watcher` (`started=true` before await + `refreshQueue` chaining), cron/agenda `start()`s (flag-before-await), `FeatureFlagsService` pending-poll dedupe, `connector-store`/`shared/db` lazy DB (synchronous `loadSqliteDb`, no await gap — the brief's pattern done safely because the factory is sync).

---

## Suggested fix order & shape
1. **S3→S1/S2** (one PR): single-flight promise in manager + both clients; regression test: two concurrent `connect()`/`listTools()` on a fake transport assert one spawn/handshake.
2. **V2**: move `refreshPromise=null` into `finally` after save + synchronous `this.credentials=` assignment; test with deferred refresh promise + rotating token stub.
3. **V1**: post-await abort re-check + sticky abort flag; test: abort during deferred `getHookLaunchConfig`, assert no spawn.
4. **V3, V6, V5, V4**: same `??=` in-flight-promise idiom (keyed by `pathsKey` for V3); each is <15 lines.

Uniform fix idiom (matches existing correct code): store the promise **synchronously before the first await**, share it, clear it in `finally` **after** any follow-up persistence, and assign the durable field synchronously when the value is known.

## Pass 2 (not yet done)
Cross-method/caller analysis for the Uncertain list; shared-state (module-level `let`, non-`this` maps); `apps/cli`, `apps/cline-hub`, webview UI; read-modify-write on files (StateManager flush, session/task stores) where the "shared state" is on disk; event-emitter re-entrancy. Scanner scripts: `/tmp/scan-vscode.mjs`, `/tmp/scan-sdk.mjs` (regenerable; crude brace tracking — expect false positives around nested closures).
