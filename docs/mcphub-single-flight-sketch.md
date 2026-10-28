# McpHub connect/disconnect/reconnect — the plain `??=` expression

Companion to `docs/async-await-race-audit.md` (legacy VSCode `McpHub`; GitHub [#7413](https://github.com/cline/cline/issues/7413)). **Sketch only — not applied.**

## Why `??=` alone is not the chord expression

`??=` gives **join** only: N concurrent callers share one in-flight promise. McpHub needs three different algebras:

| Chord | Callers | Semantics needed |
|---|---|---|
| `connect(name,cfg)` | `updateServerConnections{,RPC}`:1226/1297, `restartConnection{,RPC}`:1495/1525, `toggleServerDisabledRPC`:1623, reconnect handler cb:629 | **Join** — concurrent connects, same name = one spawn |
| `deleteConnection(name)` | update/restart/toggle paths, reconnect handler, dispose:2213 | **Exclude** — wait for in-flight connect, close what it created; no new connect until close done |
| `reconnect = delete;connect` | restart x2, toggle, update-changed-config, handler loop:162-190 | **Serialise as one unit** — nothing interposes between halves |

Currency for all three: a per-name **promise chain as FIFO mutex**. `??=` is retained inside it for the join.

## Mechanism (~25 lines, beside `connections` McpHub.ts:87)

```ts
// Per-server lifecycle queue: ops for one name run one-at-a-time in arrival
// order; different names in parallel. Enforces the invariant connectToServer's
// comment assumes ("connection should be deleted beforehand").
private lifecycleChains = new Map<string, Promise<unknown>>()
private pendingConnects = new Map<string, Promise<void>>() // ??= join handle

private enqueueLifecycle<T>(name: string, op: () => Promise<T>): Promise<T> {
  const prev = this.lifecycleChains.get(name) ?? Promise.resolve()
  const result = prev.then(op, op)          // run even if prev rejected
  const tail = result.then(() => undefined, () => undefined) // chain never rejects
  this.lifecycleChains.set(name, tail)
  void tail.then(() => {                     // drop drained chains
    if (this.lifecycleChains.get(name) === tail) this.lifecycleChains.delete(name)
  })
  return result
}
```

## The three chords

```ts
// CONNECT — ??= join: arrivals while a connect is queued/running share it.
private connectChord(name, config, source): Promise<void> {
  const existing = this.pendingConnects.get(name)
  if (existing) return existing
  const p = this.enqueueLifecycle(name, () => this.connectToServerLocked(name, config, source))
  this.pendingConnects.set(name, p)
  const clear = () => { if (this.pendingConnects.get(name) === p) this.pendingConnects.delete(name) }
  void p.then(clear, clear)
  return p
}

// DISCONNECT — exclude: queued behind in-flight connect.
async deleteConnection(name: string): Promise<void> {
  return this.enqueueLifecycle(name, () => this.deleteConnectionLocked(name))
}

// RECONNECT — one enqueued unit. Replaces all five delete-then-connect
// call-site pairs (1264-65, 1350-51, 1506-08, 1541-43, 1651-52) and the
// handler's delete+loop (StreamableHttpReconnectHandler.ts:162ff).
private reconnectChord(name, config, source): Promise<void> {
  return this.enqueueLifecycle(name, async () => {
    await this.deleteConnectionLocked(name)
    await this.connectToServerLocked(name, config, source)
  })
}
```

`*Locked` = existing bodies of `connectToServer`:388 / `deleteConnection`:1170, with two changes:

1. **Close-before-replace at :394.** Delete the sync `filter(name!==…)` that discards a live connection *without closing it* (the direct #7413 orphan mechanism). Under the queue a previous connection has already been closed by the preceding chord; defence-in-depth if one remains:
   ```ts
   if (this.connections.some(c => c.server.name === name)) await this.deleteConnectionLocked(name)
   ```
2. **`isConnecting`:88 stops being a hand-cleared boolean** (set at 1227/1298/1496/1526/1624, clearable mid-flight by an interleaved op). Derive it: `get isConnecting(){ return this.lifecycleChains.size>0 }` — after checking webview consumers, since it is published state.

The handler's replacement-revalidation (`StreamableHttpReconnectHandler.ts:152-190`, "another path installed a replacement… orphan that session") becomes dead: under the queue no path can install anything mid-chord. Callback :629 becomes `reconnect: () => this.reconnectChord(name, config, source)`; the :179-186 guard can be removed in a follow-up.

## Interleavings

**Before** (A=settings watcher, B=restart RPC):
```
A connect(X): filter(no-op) … await transport.start()      spawn#1 unregistered
B connect(X): filter(no-op, spawn#1 invisible) … start()   spawn#2 unregistered
A push(conn1); await client.connect(); fetchCapabilities…
B push(conn2); …  findConnection(X) may return conn1; conn2's process untracked
deleteConnection(X): closes find() result only → other process orphaned forever (#7413 amplifier: transport.onerror/reconnect spawns more)
```

**After**: `B` joins A's connect (same promise) or queues behind A's reconnect as one unit. At most one registered connection per name; every spawned transport is reachable from `this.connections` and closable. Invariant is *structural* (holds by construction of enqueue order), not by callers remembering delete-first.

## Honest limitations vs a join calculus

- **Join config-sensitivity**: `connectChord` joining discards the second caller's `config`/`source`. Today callers pre-delete on config change, so joinable connects should carry identical config — but nothing enforces it. Last-writer-wins `reconnectChord` after the join, or key `pendingConnects` by `name+configHash`, are the usual patches; both are conventions a reviewer must check by hand.
- **No deadlock/re-entrancy protection**: an op that (transitively) enqueues onto its own name deadlocks silently. `connectToServer` triggering OAuth writes → settings watcher → `updateServerConnections` → same name is exactly the shape to audit before adopting (cf. the non-reentrant settings-lock warning at :1626-29). A join-calculus encoding makes this a definition-site property; here it is a code-review obligation.
- **Cancellation isn't expressible**: a queued `reconnect` can't be superseded by a later `delete` (server removed while restart queued) except by re-checking `isStillWanted` inside the locked body — the imperative pattern the codebase already uses. Queue gives order, not pre-emption.
- Ergonomics: ~25 lines + renaming every call site to chords + keeping the two maps consistent is the boilerplate tax paid per class. It is, however, reviewable by any TS reader with no new vocabulary — which is the acceptance trade being bought.

## Test that motivates it (fails before, passes after)

Deferred `transport.start()`: fire `connectChord`/`updateServerConnections` + `restartConnection` concurrently for one stdio server; assert exactly one `StdioClientTransport` constructed, one entry in `connections`, and `deleteConnection` closes that transport. Deterministic with a manually-resolved promise — no sleeps.
