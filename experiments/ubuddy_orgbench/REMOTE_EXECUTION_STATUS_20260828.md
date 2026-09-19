# OrgBench v2 remote execution status — 2026-08-28

## Outcome

The remote Linux deployment and real AppWorld execution/evaluation pipeline are installed and reproducible, but the benchmark is intentionally stopped before pilot/main. The canary produces official AppWorld evaluation and passes both artifact verifiers, while the current organization/executor policy does not yet complete task `6f4b9a5_1` and the configured model endpoint has long-tail executor latency.

## Frozen deployment

- Janus root: `/root/Janus`
- writable benchmark root: `/root/autodl-tmp/benchmarks`
- AppWorld repository: `/root/autodl-tmp/benchmarks/appworld-official`
- AppWorld runtime: `/root/autodl-tmp/benchmarks/appworld-runtime`
- AppWorld Python: `/root/autodl-tmp/benchmarks/appworld-official/.venv/bin/python`
- run root: `/root/autodl-tmp/janus-runs/orgbench`
- Janus commit: `822d139f3b9c836630971cd04bb5d2a95a274655`
- synced Janus snapshot SHA-256: `bd72ab362bae94f4b3ee47b3155e8d3b2d236619fd86a26ebdf9ca61b607fc82`
- AppWorld commit: `a072b7a86e7c1d5b1d7175659d750ebb9b79f10a`
- AppWorld package: `0.2.0.dev0`
- AppWorld data: `0.2.0`
- AppWorld manifest SHA-256: `3ad07712ae25322317cd8938421ba04e51ba4c95c6b67c3f33ca9ad990ec3d80`
- model: `gpt-5.4-mini`
- model base URL: `https://codexpro.wwxb1123.xyz/v1`
- fixed budget: 3 first-level tasks, 2 leaves per uBuddy, 4 steps per Agent, 3 model retries, 180-second model timeout, 45-second AppWorld execution timeout

The API key is not stored in this file, `.orgbench_env`, Git, or run artifacts.

## Verification evidence

- local OrgBench tests: 18/18 passed
- remote OrgBench tests: 18/18 passed
- AppWorld official unit verification: 1652 app tests passed; 76 common tests passed; 110 other tests passed and 2 skipped
- AppWorld official task smoke: 1/1 passed
- OrgBench doctor: `ready: true`; optional TheAgentCompany, MARBLE, and Who&When references deferred
- locked-test protocol: 7 families / 19 task instances
- transfer protocol: 10 pairs
- frozen manifest regeneration: semantic JSON is identical; only CRLF/LF differs

AppWorld required a recorded compatibility override `pendulum==2.1.2`; versions 3.0–3.2 make `Time.add()` incompatible with this frozen AppWorld commit's official tests. Official AppWorld source was not modified.

## Canary evidence

Primary retained run:

```text
/root/autodl-tmp/janus-runs/orgbench/canary-final
```

Results:

- real AppWorld reset and `apis.*` execution succeeded
- official evaluator returned 1/8 checkpoints (12.5%), task unsuccessful
- `verify` passed
- independent verifier passed
- report generated
- no private-memory leak detected
- `supervisor.complete_task` API path was discovered, but the task was not actually completed
- project correctly remained `blocked`, rather than being falsely marked done

Diagnostic execution stages are stored incrementally in `progress.jsonl` without task plaintext or API secrets.

## Implemented runner hardening

- persistent output root now honors `UBUDDY_ORGBENCH_OUTPUT_ROOT`
- run configs record frozen source/data/model/budget metadata
- AppWorld executor instructions forbid importing `apis` and require `apis.<app>.<function>` namespacing
- nonexistent first-level dependencies are filtered before execution
- recovery `status=execute` code is actually executed
- project status is blocked when first-level tasks remain incomplete
- AppWorld's native `timeout_seconds` is configured from the benchmark environment
- incremental `progress.jsonl` records reset, model, execution, and official-evaluation stages

## Gate decision

Pilot, main, fault stress, attribution, and evolution were not started. Before pilot, rerun the fixed canary and require:

1. real state change in AppWorld;
2. an actual successful `apis.supervisor.complete_task(...)` call;
3. official evaluator output;
4. `verify` and independent verifier pass;
5. acceptable model latency under the frozen budget.

Cloud integration remains deferred because Docker/Compose is unavailable. Optional external resources do not block the AppWorld main line.
