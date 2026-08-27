# Remote OrgBench initializer

This directory prepares **virtual** Cloud identities for the uBuddy-OrgBench experiment. It is intentionally remote-only: it refuses to run on Windows and requires an explicit acknowledgement before writing PostgreSQL.

## Remote Ubuntu usage

```bash
export UBUDDY_ORGBENCH_REMOTE_INIT_ACK=I_UNDERSTAND_REMOTE_DATABASE_WILL_BE_MODIFIED
export CRS_OAI_KEY='...'                 # only for later model runs
export OPENAI_BASE_URL='...'
docker compose -f deploy/community/compose.yml up -d postgres minio minio-init
docker compose -f deploy/community/compose.yml run --rm migrator
docker compose -f deploy/community/compose.yml up -d cloud-api evolution-worker
cp deploy/env/orgbench-init.env.example deploy/env/orgbench-init.env
# Fill DATABASE_URL. A password seed is optional; if omitted, high-entropy passwords are generated once on first creation.
mkdir -p experiments/runs/remote-init
docker compose -f deploy/community/compose.yml --profile orgbench run --rm orgbench-init
npm run experiment:ubuddy:orgbench:remote-verify -- --output-dir experiments/runs/remote-init
```

The initializer creates six virtual users, six uBuddy secretary instances, 36 internal execution Agent instances, private Memory0 baselines, accepted friendship edges for profile visibility, versioned public profiles, and isolated device/evolution grants. It is idempotent and does not delete non-OrgBench data.

The container writes `/var/lib/janus/orgbench-init`, bind-mounted to the ignored host directory `experiments/runs/remote-init`, with mode `0600`:

* `remote-orgbench.env` — runtime tokens and maps; never commit it.
* `remote-orgbench-identities.json` — redacted identities and instance IDs.
* `remote-orgbench-agent-map.json` — all 36 local aliases to Cloud IDs.
* `remote-orgbench-verification.json` — database completeness checks.

Passwords are generated only to create/update the user hash and are never written to artifacts. Model credentials are not read by this initializer and are not included in output.
