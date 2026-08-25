# SPEC — runtime-network-error-account-health

> The agent fills this by running the BOUNDED dimensional clarifier (see the
> Spec-first protocol: score Objective/Metric/Target/Scope, ask one question
> per round at the weakest, exit at ambiguity ≤20%), reads it back, and only
> runs `ftask spec runtime-network-error-account-health --approve` once sunke says OK. No code until
> approved. This is the non-coder's real review gate.
>
> The 'How will I know it works' section is the Karpathy gate — `--approve`
> parses it and refuses to flip status if Surface / Acceptance scenarios /
> Regression guards are empty or placeholder. Filling this section honestly
> is what lets the LLM LOOP toward done instead of guessing.

## Done — ONE measurable sentence (fill LAST, after the interview)
> The crisp goal the interview converges to. Must be checkable, not vague —
> it doubles as the future drive-to-green stop condition.
> e.g. 'subscribe-v3 import maps all 7 fields; imported row count = source ±0'.
- Done: With two healthy managed accounts, an upstream transport exception makes exactly one upstream request, returns a retryable HTTP 503, records zero rotations, and leaves both accounts enabled and out of cooldown.

## What sunke wants (plain language)  [Objective]
- Fix `codex-multi-auth` so a shared/local network failure is not misclassified as an individual account failure and does not exhaust the managed account pool.

## Out of scope (what we will NOT do)  [Scope]
- No changes to duplicate-account detection, proxy/Surge configuration, account selection strategy, release packaging, or unrelated diagnostics.

## 任务类型 fix

## 根因 (fix 必填 — 不写根因就会同一个 bug 修两遍)
> 这个缺陷的真实成因是什么?在哪一层进入系统?哪些调用方共享同一个根因?
- The runtime rotation proxy catches every pre-response `fetch` exception and immediately records an account failure, applies a persisted `network-error` cooldown, increments rotation counters, and retries another account even though transport failures provide no account-specific evidence and all accounts share the same upstream path.

## 拷问(写 Done 前) — 运行 /grilling 与 sunke 对齐到共识;共识即落 Done。(T0/T1 可跳过)

## How will I know it works (Karpathy gate — required to approve)

### Surface (which user-facing surface — pick one or more)
- [ ] web — Interceptor / agent-browser harness
- [ ] cli — fresh shell + actual command
- [x] api — curl against real endpoint
- [ ] lib — 5-line consumer script
- [ ] none — pure doc/config change (no simulate step)

### Visual target (web surface only — 钉死"长成什么样才算对")
> 仅 web surface 任务需填: 参考图路径 / 设计稿 URL / 一句可视判定(如"侧边栏宽 240px、企业名居中")。
> 这是前端视觉验收的对比基准 — 没有它,"看着对"无法机器核验。
- 

### Acceptance scenarios (each = observable user action + observable outcome)
Format: 'user does X → observe Y' (use → to separate action from outcome)
- user posts a Responses request while the upstream transport rejects before headers → observe one upstream attempt and a structured retryable HTTP 503
- user inspects runtime/account state after that response → observe zero rotations and no cooldown or disablement on either healthy account

### Regression guards (what must NOT break — list things to recheck)
- Explicit upstream 429, 401, and 5xx responses retain their existing account-specific handling and rotation behavior.
- The local proxy remains loopback-only and does not expose account identity or credentials in responses.

### Targeted tests (repo-relative paths; one per bullet, or `full-suite`)
> The direction model lists only tests affected by this task. Invalid/missing targets block; full-suite is CI-only.
- test/runtime-rotation-proxy.test.ts

## Plan (long tasks only — ordered route + live progress; T1/short may leave empty)
> Steps DERIVED from the Done line (not a chat-plan). Tick `[ ]`→`[x]` as you go.
> This is the compaction-survival anchor: after an auto-compact, read this to see
> exactly which steps are done and what's next — never re-run finished steps.

## Dead ends (filled DURING work — approaches tried & rejected, don't retry)
> Append one line per rejected approach: `approach → why it failed`. Read
> this before each new attempt so the same wrong path isn't tried twice.
- named `red`/`green` simulation IDs from the pipeline skill → installed ftask accepts positive integer scenario IDs only; use `1` and `2`
