# Codex app-server W2 spike evidence

Date: 2026-08-21 (Asia/Shanghai)  
Worker: `knowledge-m4`  
Codex: `codex-cli 0.147.0` (worker and controller match)

This directory is generated reference material, not production integration code. The JSON files were produced without `--experimental`:

```sh
codex app-server generate-json-schema --out <directory>
```

The worker generated the bundle first in a temporary directory. The controller then generated this checked-in copy with the same Codex version. Both outputs contain 285 JSON files and 2,925,973 bytes. Their `codex_app_server_protocol.v2.schemas.json` SHA-256 is identical:

```text
f3dec1e031d99a420b137b903f02196d4325eece57620c925bb7130b25f168d2
```

Every JSON file is covered by `MANIFEST.sha256`.

## Live evidence and hard stop

The worker already had app-server installed, so the spike did not install or upgrade anything. A stdio app-server was started through SSH and received only these no-turn protocol messages:

```json
{"method":"initialize","id":0,"params":{"clientInfo":{"name":"agos_spike","title":"AgOS app-server spike","version":"0.1.0"}}}
{"method":"initialized","params":{}}
{"method":"model/list","id":1,"params":{"limit":20}}
```

Evidence observed through SSH stdio:

- `initialize` returned `id: 0` and an app-server `0.147.0` user agent. This proves client request/server response traffic survives the SSH stdio path.
- The worker's CLI login-status command said it was logged in, but app-server's model refresh returned HTTP 401 with `refresh_token_invalidated` and reported that the session had ended.
- `model/list` eventually returned cached model metadata. That is not evidence that inference authentication works.
- The connection was immediately closed. No `thread/start`, `turn/start`, `thread/resume`, command, approval decision, or model-inference request was sent. `model/list` did attempt an authentication/model-catalog refresh, but there was no inference turn; model-turn cost for this spike is therefore zero.

No credential value was read, copied, logged, or written here. Live resume and approval validation must wait until the owner signs in again on `knowledge-m4`.

## The three W2 questions

### 1. Does `thread/resume` really continue after disconnect?

Protocol answer: it is explicitly supported on the stable surface. The official contract says a client records `thread.id`, reconnects and initializes a new transport, calls `thread/resume`, and later `turn/start` appends to that stored thread. `ThreadResumeParams.json` and `ThreadResumeResponse.json` are present in this non-experimental bundle.

Live answer for this spike: **not proven**. Authentication failed before the two minimal turns needed to demonstrate conversational continuity. A valid acceptance test still needs:

1. connection A: initialize, start a thread, send a tiny nonce turn, wait for `turn/completed`, record the thread id;
2. close connection A and app-server;
3. connection B over a new SSH stdio process: initialize, `thread/resume` with the recorded id, ask for the nonce, and verify the answer plus the same thread id.

Merely resuming an empty thread would test persistence mechanics but would not prove that model context continued, so it was not used as a substitute.

### 2. Can approval server requests make a round trip through SSH stdio?

Transport/schema answer: **yes by protocol design**. Stdio is bidirectional newline-delimited JSON, and the checked-in stable schema includes:

- `ServerRequest.json` with `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` variants;
- `CommandExecutionRequestApprovalResponse.json` and `FileChangeRequestApprovalResponse.json`;
- `serverRequest/resolved` in `ServerNotification.json`.

The client must reply to the server-originated request using the same JSON-RPC id. Because initialize request/response already crossed the same SSH stdio pipes, SSH itself does not remove the reverse channel.

Live approval answer for this spike: **not proven end to end**. No turn was started after the 401. After reauthentication, the smallest safe test is one turn that attempts a harmless command under an approval policy, then answers the server request with `decline` and observes both `serverRequest/resolved` and a declined/completed item. This avoids modifying the worker.

### 3. What would a second fold cost?

The current DSH fold is 334 lines plus a 118-line output model and is backed by a 392-session replay corpus. Codex 0.147.0 exposes 18 `ThreadItem` variants, 70 `ServerNotification` variants, and 10 `ServerRequest` variants. A Codex fold should be a new module and must not modify `src/fold/**`.

Estimated scope for useful `FoldedConversation` parity:

| Work | Estimated lines | Notes |
|---|---:|---|
| Stable event normalizer and incremental state machine | 360-480 | thread/turn lifecycle, item pairing, deltas, final-item authority, reconnect replay dedupe |
| Compatibility mapping/helpers | 100-170 | synthesize numeric turn/step order, tool args/results, metadata and status mapping |
| Unit and fixture tests | 320-480 | delta/final replacement, reconnect replay, approvals, commands, file changes, malformed/unknown events |
| Corpus/replay checks | 100-180 | invariants equivalent to the DSH replay checks, initially against captured app-server sessions |

Minimal production code is therefore about **460-650 lines**, plus **420-660 lines** of tests and corpus checks. A narrow remote-computer implementation that only supports user/agent/reasoning/command/file-change items could be about 280-380 production lines, but it would silently lose MCP, collaboration, image and approval semantics. Full fidelity for all 18 item variants is closer to 700-1,000 production lines.

Material semantic gaps:

| Codex event/item | Proposed `FoldedConversation` mapping | Gap |
|---|---|---|
| `thread/started` and start/resume response | `header`, title, cwd and provider metadata | model is returned beside the thread, not stored in the same shape as the DSH header |
| `turn/started`, `turn/completed` | turn counters and final reason | ids are strings; the DSH view expects numeric turn/step ordinals |
| `userMessage` | `UserItem` | multimodal content cannot fit the current text-only item without a placeholder or new output type |
| reasoning item and reasoning deltas | assistant reasoning buffer | reasoning is a separate item, so attaching it to the correct assistant message requires turn-local ordering rules |
| agent message and deltas | `AssistantItem` | final item should replace accumulated deltas, but historical items do not carry the same timestamps as live notifications |
| `commandExecution` | `ToolItem` named `bash` | output and exit code map well; status vocabulary and command structure still need normalization |
| `fileChange` and diff notifications | synthetic file tool | changes are structured patches, not a conventional tool call/result pair |
| MCP/dynamic tool calls | `ToolItem` | result bodies are typed content, not only text; lossy flattening must be explicit |
| collaboration/subagent items | tool plus optional swarm projection | no direct equivalent of DSH `swarm/progress` rows |
| plan updates | `todos` | plan prose items and structured plan-step notifications are two separate surfaces |
| approval server request + client response | synthetic `ApprovalItem` | the decision is client-owned; `serverRequest/resolved` alone does not preserve the chosen decision |
| compaction | diagnostics counter | reconnect may replay historical items, so id-based dedupe is mandatory |
| image generation/view, web search and sleep | generic tool items or explicit ignored diagnostics | flattening them loses domain-specific result metadata |

The largest risk is not parsing JSON. It is defining deterministic replay semantics across live deltas, final items, disconnect/resume, and history rehydration. A production decision should require at least one captured successful resume session and one captured approval session as gold fixtures.

## Sources

- [Official Codex app-server documentation](https://developers.openai.com/codex/app-server/)
- Generated stable schemas in this directory, tied to Codex `0.147.0`
- Existing local DSH fold: `src/fold/fold.ts` and `src/fold/model.ts` (read only; unchanged)
