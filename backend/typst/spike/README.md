# T1005 spike harness and evidence

Everything in this directory exists to PROVE something, and is not production code.
`backend/typst/Dockerfile` and `docker-compose.yml` are the deliverables; this is the
instrumentation. It is kept in the repo (rather than thrown away) because the next
person who bumps the Typst pin has to re-run it, and a spike whose evidence cannot be
reproduced is a spike nobody trusts.

ASCII only, by repo requirement.

## Running it

```powershell
# 1. Vendor the pinned, digest-verified toolchain and fonts. Needs network ONCE.
#    (Skipped automatically if ./backend/typst/typst-dist/ already has the archives.)
docker run --rm -v "${PWD}/backend/typst:/stage" alpine:3.20 sh /stage/fetch-assets.sh

# 2. Build the worker image.
docker compose build typst-worker

# 3. Every render fixture, in order, with a summary table.
powershell -File backend/typst/spike/harness.ps1 -Suite

# 4. The container-level probes: identity, determinism, peak memory, cross-job leakage,
#    timeout/kill, error surface, output caps, traversal, artifact validation, pid cap.
powershell -File backend/typst/spike/harness.ps1 -Probes

# 5. One fixture on its own.
powershell -File backend/typst/spike/harness.ps1 -Fixture a-valid-resume
```

## The probe scripts

| Script | Asserts | What it actually does |
|---|---|---|
| `probe/stage-audit.sh` | V5 (control half) | The spike's stand-in for `backend/src/render/stage.ts`: walks `/work`, rejects off-allowlist names and any non-regular file. Does not exist in production code yet. |
| `probe/identity.sh` | V4, V11b | `id`, write attempts to `/` and each mount, capability mask, docker socket presence, egress attempts, tmpfs sizes. |
| `probe/determinism.sh` | V3, R14 | Renders the same input five ways and compares digests: epoch pinned twice, epoch unset twice, and `--jobs 4`. Also prints the embedded PDF timestamps. |
| `probe/peak-memory.sh` | V17 | Launches the memory flood in the background and reads cgroup `memory.peak` (exact) plus a sampled peak (lower bound). Reports which mechanism produced the number. |
| `probe/cross-job.sh` | V21, V5 | Five phases: a fresh job sees nothing; a positive control proves the probe can read what it may; seven outside-root paths are refused; planted in-root leftovers are readable and the audit refuses them; the symlink escape, with the byte-identity proof. |
| `probe/timeout.sh` | V19 | Two-stage kill: `timeout -s TERM` at the budget, then `pkill -KILL` after the grace, with elapsed time and the post-kill state of `/out`. |
| `probe/error-surface.sh` | V23 | Captures the raw diagnostic, enumerates exactly what it leaks, applies the policy 9.4 redaction, and checks the result. |
| `probe/cap-output.sh` | V20, V22 | `dd` past the 16 MiB `/out` tmpfs, traversal attempts, a symlink planted in `/out`. |
| `probe/validate-artifact.sh` | V1, V22 | Policy 6.3's six checks, in order, with a fixed message per failure. |
| `probe/validate-oversize.sh` | V20 (check 5) | The 20 MiB supervisor cap, proven on a mount with no size cap, because `/out` makes an over-20-MiB file unreachable. |
| `probe/cap-memory.sh` | V17 | Shell-side memory flood (a real in-process allocation, unpinned by any mount). |
| `probe/cap-pids.sh` | V18 | Fork storm with counters written to files, because a spawn failure also kills the process that would report the count. |

## The policy 13.2 grep gate

Policy 13.2 requires a repo-wide grep for `typst compile` / `pdflatex` to return zero hits
outside `backend/src/render/` and `backend/typst/Dockerfile`. Measured on this branch:

```
HIT backend/src/render/sandbox.test.ts:231     <- allowed
HIT backend/src/render/sandbox.ts:14           <- allowed (a comment)
HIT backend/typst/spike/probe/peak-memory.sh:33
HIT backend/typst/spike/probe/timeout.sh:69
HIT backend/typst/spike/probe/timeout.sh:71
HIT backend/typst/spike/probe/timeout.sh:73
```

The three probe scripts are the spike's own instrumentation and are a second documented
exception alongside the Dockerfile, for the same reason the Dockerfile is: they exist to
verify the contract, and they assemble the policy argv by hand because the code that will
own that argv (`backend/src/render/sandbox.ts` plus the T1040 broker) does not exist yet.
They are not a compile path - nothing renders a user's document through them.

**The compile argv itself is never joined into a shell string.** In `harness.ps1` the
argv is a PowerShell array handed to `docker exec` as separate arguments:

```powershell
$rargs = @('exec', $cname, 'timeout', '-s', 'KILL', "$($Budget+2)", '/opt/typst/typst') + $argv[1..($argv.Length-1)]
```

The `sh -c` calls in the harness are staging (`cp` from the read-only fixture bind) and
probing (`ln -s` to plant the symlink), never compiling. `spike/probe/peak-memory.sh` and
`spike/probe/timeout.sh` do build the compile command in a shell string, because they run
inside busybox `sh` where an argv array is not available; both are probe scripts, and both
are replaced wholesale by the supervisor in T1040.

## Two harness rules, both forced by measurement

**1. The worker contract has exactly three mounts; the spike's own containers add more.**
Policy 4.5 says the three read-only binds are the ONLY mounts, and `docker-compose.yml`
honours that exactly. But a fixture has to get into `/work`, and a read-only root
filesystem makes that impossible by copying: `docker cp` into a RUNNING container fails
with `container rootfs is marked read-only`, and into a CREATED container it fails with
`Could not find the file /work` because a tmpfs has no content until the container starts.
So the spike's containers mount `./backend/typst/fixtures` at `/fixtures` and
`./backend/typst/spike/probe` at `/probe`, read-only, and copy from inside. The service
definition is unaffected and is verified separately via `docker compose run`.

**2. Artifact extraction cannot use `docker cp` either**, for the same reason. The
harness reports the in-container `sha256sum` as the authoritative digest and does not
attempt host-side extraction. The production broker (T1040) will need to solve this
properly; it is escalated as open item OI-1.

## Measured typst 0.15.1 behaviours that shaped the fixtures

These are all recorded in the fixtures themselves, because each one silently turned a
fixture into a FALSE PASS before it was found:

| Behaviour | Consequence for a test |
|---|---|
| `try`/`catch` does not propagate assignments (the body is a new scope) | The catch branch is unobservable. No "probe N paths and report each" is possible. |
| `try`/`catch` inside a `for` or a function body is a parse error | The natural loop-and-catch probe does not compile. |
| A document that fails to parse exits non-zero, same as a refused read | A broken probe is indistinguishable from a containment win. Every fixture has a positive control. |
| `range(N)` materialises as an array | `range(1000000000)` is a MEMORY flood (killed at the 1 GiB cap in ~2 s), not a CPU one. |
| `while` with any provable-or-opaque-true condition is refused | "loop seems to be infinite". A CPU flood must be a large FINITE loop. |
| PDF/SVG text is subset-encoded glyph IDs | `grep` for a string in a rendered artifact finds nothing. Exfiltration must be proven by byte-identity against a control render. |
| Absolute paths are rebased onto the project root | `read("/etc/passwd")` searches `<root>/etc/passwd`. Document paths are root-relative, and a "refused because rebased" verdict must be reported as such. |
| `TYPST_IGNORE_*_FONTS` env vars are clap booleans | `"1"` is REJECTED; only `true`/`false` parse. The policy skeleton says `"1"`. See the report. |
| Unvendored package imports ATTEMPT a download | The diagnostic is `failed to download package ... Dns Failed`, not `package not found`. Only `network_mode: none` prevents it. |
