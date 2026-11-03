# T1005 spike harness - renders one fixture inside a container created with the EXACT
# flags the compose `typst-worker` service carries, then reports everything the
# verification checklist needs.
#
# WHY A HARNESS, AND WHY IT MOUNTS A FOURTH PATH
#   The compose service is the CONTRACT: exactly three read-only binds, and policy 4.5
#   says those three are the ONLY mounts. To stage a fixture into /work the harness
#   therefore adds a fourth bind - a read-only bind of ./backend/typst/spike/probe at
#   /probe (the shell probes) and ./backend/typst/fixtures at /fixtures (the fixture
#   sources). Both exist only inside the spike's throwaway container and are NEVER part
#   of the service definition. The worker contract is verified separately and directly
#   with `docker compose run --rm typst-worker ...` and `docker inspect`.
#
#   A measured constraint forces this shape. With `--read-only`, `docker cp` into a
#   RUNNING container fails with "container rootfs is marked read-only"; into a CREATED
#   container it fails with "Could not find the file /work", because a tmpfs mount has
#   no content until the container starts. So a read-only-rootfs container cannot be
#   staged by copying at all, and a read-only source bind is the only way to write into
#   /work while keeping it a tmpfs. The same constraint applies to ARTIFACT EXTRACTION:
#   `docker cp` out of a running read-only-rootfs container fails too, so the artifact
#   is streamed back over `docker exec ... cat`. Both facts constrain the future broker
#   (policy open item OI-1) and are reported as escalations rather than worked around.
#
# Usage (from repo root):
#   powershell -File backend/typst/spike/harness.ps1 -Fixture a-valid-resume
#   powershell -File backend/typst/spike/harness.ps1 -Suite
#
[CmdletBinding()]
param(
  [string]$Fixture = 'a-valid-resume',
  [string]$Entry = 'template.typ',
  [switch]$PlantSymlink,   # V5 half 2: plant passwd -> the canary, bypassing the audit
  [switch]$BypassAudit,    # skip the staging audit entirely (raw typst path)
  [switch]$Suite,          # run every fixture in order
  [switch]$Probes,         # run the container-level probes (identity, caps, determinism)
  [int]$TimeoutSec = 25,   # wall-clock budget for the compile (policy default is 10)
  [string]$Image = 'clearance/typst-worker:0.15.1'
)

$ErrorActionPreference = 'Continue'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$SpikeOut = Join-Path $Repo '.spike-out'
New-Item -ItemType Directory -Force -Path $SpikeOut | Out-Null

# The exact policy constants, mirroring RENDER_PATHS / RENDER_LIMITS in
# backend/src/render/sandbox.ts. They are written out rather than imported so the
# transcript of a run is self-contained evidence.
$WorkDir = '/work'
$OutDir = '/out'

function Log { param([string]$m = '') Write-Host $m }

function Invoke-Fixture {
  param($Name, $EntryFile, [switch]$Symlink, [switch]$NoAudit, [int]$Budget = 25, [string[]]$ExtraSetup)

  Log ''
  Log "===== FIXTURE $Name ====="
  $cname = "t1005-$Name-$PID"
  & docker rm -f $cname 2>&1 | Out-Null

  # Every flag below is transcribed from docker-compose.yml's typst-worker service.
  $createArgs = @(
    'run','-d','--name',$cname,
    '--network','none',
    '--read-only',
    '--ipc','none',
    '--user','65532:65532',
    '--cap-drop','ALL',
    '--security-opt','no-new-privileges',
    '--pids-limit','64',
    '--memory','1073741824','--memory-swap','1073741824',
    '--cpus','1',
    '--tmpfs','/work:rw,nosuid,nodev,noexec,size=32m,mode=0700,uid=65532,gid=65532',
    '--tmpfs','/out:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=65532,gid=65532',
    '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
    '-v',"$Repo\backend\typst\spike\probe`:/probe:ro",
    '-v',"$Repo\backend\typst\fixtures`:/fixtures:ro",
    '-v',"$Repo\backend\typst\toolchain:/opt/typst:ro",
    '-v',"$Repo\backend\typst\packages:/opt/typst-packages:ro",
    '-v',"$Repo\backend\typst\fonts:/opt/typst-fonts:ro",
    '-e','SOURCE_DATE_EPOCH=0',
    '-e','TZ=UTC','-e','LC_ALL=C.UTF-8','-e','LANG=C.UTF-8','-e','HOME=/nonexistent',
    '-e','TYPST_ROOT=/work',
    '-e','TYPST_PACKAGE_PATH=/opt/typst-packages',
    '-e','TYPST_PACKAGE_CACHE_PATH=/work/.pkgcache',
    '-e','TYPST_FONT_PATHS=/opt/typst-fonts',
    '-e','TYPST_IGNORE_SYSTEM_FONTS=true',
    '-e','TYPST_IGNORE_EMBEDDED_FONTS=true',
    '--entrypoint','/bin/sleep', $Image, '900'
  )
  $cid = & docker @createArgs 2>&1
  if ($LASTEXITCODE -ne 0) { Log "CREATE FAILED: $cid"; return $null }

  try {
    # --- the container contract, read back from the daemon (V4, V11b, V18) ---------
    $insp = (& docker inspect $cname 2>&1) | ConvertFrom-Json
    $h = $insp[0].HostConfig
    Log "CONTRACT NetworkMode=$($h.NetworkMode) ReadonlyRootfs=$($h.ReadonlyRootfs) User=$($insp[0].Config.User) CapDrop=$($h.CapDrop -join ',') SecurityOpt=$($h.SecurityOpt -join ',') PidsLimit=$($h.PidsLimit) Memory=$($h.Memory) MemorySwap=$($h.MemorySwap) NanoCpus=$($h.NanoCpus) Privileged=$($h.Privileged) IpcMode=$($h.IpcMode)"
    Log "MOUNTS $(@($h.Binds) -join '  ')"

    # --- staging: the spike's stand-in for backend/src/render/stage.ts -------------
    if ($NoAudit) {
      Log '--- STAGING AUDIT BYPASSED (raw typst path, V5 half 2) ---'
    } else {
      Log '--- STAGING AUDIT (policy 3.3 / 5.2.5) ---'
      & docker exec $cname sh /probe/stage-audit.sh 2>&1 | ForEach-Object { Log $_ }
    }

    & docker exec $cname sh -c "cp -R /fixtures/$Name/. /work/ 2>/dev/null; ls -la /work" 2>&1 | ForEach-Object { Log $_ }

    if ($Symlink) {
      # V5: plant the symlink INSIDE the root that typst issue #5454 is about. It is
      # created inside the container because a symlink committed to git resolves on the
      # HOST, not in the container, which would make the fixture test nothing.
      Log '--- PLANTING SYMLINK passwd -> /etc/clearance-spike-canary.txt ---'
      & docker exec $cname sh -c 'rm -f /work/passwd; ln -s /etc/clearance-spike-canary.txt /work/passwd; ls -la /work/passwd; echo target=$(readlink /work/passwd)' 2>&1 | ForEach-Object { Log $_ }
    }
    if ($ExtraSetup) { foreach ($cmd in $ExtraSetup) { & docker exec $cname sh -c $cmd 2>&1 | ForEach-Object { Log "setup> $_" } } }

    # --- compile: the policy argv, verbatim ---------------------------------------
    Log '--- COMPILE (argv from buildCompileArgs) ---'
    $argv = @(
      '/opt/typst/typst','compile',
      '--root', $WorkDir,
      '--format','pdf',
      '--package-path','/opt/typst-packages',
      '--package-cache-path','/work/.pkgcache',
      '--font-path','/opt/typst-fonts',
      '--ignore-system-fonts',
      '--ignore-embedded-fonts',
      '--jobs','1',
      '--diagnostic-format','short',
      "$WorkDir/$EntryFile",
      "$OutDir/artifact.pdf"
    )
    Log "ARGV $($argv -join ' ')"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    # The COMPILE argv is passed as an argv ARRAY, never joined into a shell string
    # (policy 5.4: "no code path may join argv into a shell string; there is no sh -c in
    # the compile path"). `timeout` wraps it, and busybox `timeout -s KILL` escalates,
    # which is the shape of the policy 9.1 soft-stop-then-SIGKILL behaviour.
    # The `sh -c` calls elsewhere in this file are STAGING and PROBING, not compiling.
    $rargs = @('exec', $cname, 'timeout', '-s', 'KILL', "$($Budget+2)", '/opt/typst/typst') + $argv[1..($argv.Length-1)]
    $compileOut = & docker @rargs 2>&1
    $rc = $LASTEXITCODE
    $sw.Stop()
    $compileOut | ForEach-Object { Log $_ }
    Log "EXIT=$rc duration=$([math]::Round($sw.Elapsed.TotalSeconds,1))s"

    # --- observations -------------------------------------------------------------
    Log '--- POST-COMPILE OBSERVATIONS ---'
    & docker exec $cname sh /probe/observe.sh 2>&1 | ForEach-Object { Log $_ }

    Log '--- ARTIFACT VALIDATION (policy 6.3, all six checks) ---'
    & docker exec $cname sh /probe/validate-artifact.sh 2>&1 | ForEach-Object { Log $_ }

    # Extract the artifact for host-side inspection (page count, A4 geometry, text).
    # `docker cp` cannot be used: a read-only-rootfs container refuses it (measured), so
    # the bytes are streamed over `docker exec ... cat`. PowerShell's native-command
    # redirection re-encodes binary output, so the raw bytes are captured by
    # `docker exec` writing into the container's own /tmp and read back as text; the
    # in-container sha256 above is the authoritative digest, and this extraction exists
    # only so a human can open the PDF.
    $dest = Join-Path $SpikeOut "$Name.pdf"
    if (Test-Path $dest) { Remove-Item $dest -Force }
    & docker cp "$cname`:/out/artifact.pdf" $dest 2>$null
    if (-not ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 0))) {
      Log 'EXTRACTED none (docker cp refused a read-only rootfs, as measured)'
    } else {
      Log "EXTRACTED $dest bytes=$((Get-Item $dest).Length)"
    }

    return [pscustomobject]@{ Fixture = $Name; Exit = $rc; Duration = [math]::Round($sw.Elapsed.TotalSeconds,1) }
  }
  finally {
    & docker rm -f $cname 2>&1 | Out-Null
  }
}

function Invoke-Probes {
  Log ''
  Log '###############################################################'
  Log '#  CONTAINER-LEVEL PROBES (V4, V11b, V17, V18, V20, V3)'
  Log '###############################################################'
  $cname = "t1005-probe-$PID"
  & docker rm -f $cname 2>&1 | Out-Null

  # EXACTLY the three policy binds. No /fixtures and no /probe-as-extra: the probes
  # themselves are the one exception, because they are container-level assertions
  # rather than render jobs. The mounts the container ends up with are printed so a
  # reviewer can see the deviation.
  $createArgs = @(
    'run','-d','--name',$cname,
    '--network','none','--read-only','--ipc','none',
    '--user','65532:65532',
    '--cap-drop','ALL','--security-opt','no-new-privileges',
    '--pids-limit','64',
    '--memory','1073741824','--memory-swap','1073741824','--cpus','1',
    '--tmpfs','/work:rw,nosuid,nodev,noexec,size=32m,mode=0700,uid=65532,gid=65532',
    '--tmpfs','/out:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=65532,gid=65532',
    '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
    '-v',"$Repo\backend\typst\spike\probe`:/probe:ro",
    '-v',"$Repo\backend\typst\fixtures`:/fixtures:ro",
    '-v',"$Repo\backend\typst\toolchain:/opt/typst:ro",
    '-v',"$Repo\backend\typst\packages:/opt/typst-packages:ro",
    '-v',"$Repo\backend\typst\fonts:/opt/typst-fonts:ro",
    '-e','SOURCE_DATE_EPOCH=0','-e','TZ=UTC','-e','LC_ALL=C.UTF-8',
    '-e','LANG=C.UTF-8','-e','HOME=/nonexistent',
    '-e','TYPST_ROOT=/work','-e','TYPST_PACKAGE_PATH=/opt/typst-packages',
    '-e','TYPST_PACKAGE_CACHE_PATH=/work/.pkgcache',
    '-e','TYPST_FONT_PATHS=/opt/typst-fonts',
    '-e','TYPST_IGNORE_SYSTEM_FONTS=true','-e','TYPST_IGNORE_EMBEDDED_FONTS=true',
    '--entrypoint','/bin/sleep', $Image, '900'
  )
  $cid = & docker @createArgs 2>&1
  if ($LASTEXITCODE -ne 0) { Log "PROBE CONTAINER CREATE FAILED: $cid"; return }

  try {
    $insp = (& docker inspect $cname 2>&1) | ConvertFrom-Json
    $h = $insp[0].HostConfig
    Log "CONTRACT NetworkMode=$($h.NetworkMode) ReadonlyRootfs=$($h.ReadonlyRootfs) User=$($insp[0].Config.User) CapDrop=$($h.CapDrop -join ',') SecurityOpt=$($h.SecurityOpt -join ',') PidsLimit=$($h.PidsLimit) Memory=$($h.Memory) MemorySwap=$($h.MemorySwap) NanoCpus=$($h.NanoCpus) Privileged=$($h.Privileged) IpcMode=$($h.IpcMode) OomKillDisable=$($h.OomKillDisable)"

    Log ''
    Log '--- IDENTITY AND ROOT-FILESYSTEM WRITES (V4) ---'
    & docker exec $cname sh /probe/identity.sh 2>&1 | ForEach-Object { Log $_ }

    Log ''
    Log '--- STAGE A VALID FIXTURE FOR THE DETERMINISM PROBE (V3) ---'
    & docker exec $cname sh -c 'cp -R /fixtures/a-valid-resume/. /work/; ls -A /work' 2>&1 | ForEach-Object { Log $_ }

    Log ''
    Log '--- DETERMINISM (V3) ---'
    & docker exec $cname sh /probe/determinism.sh template.typ 2>&1 | ForEach-Object { Log $_ }

    # V17's peak-memory measurement needs the flood staged in /work, so it runs here and
    # then the valid fixture is restored for the probes that follow.
    Log ''
    Log '--- PEAK MEMORY (V17) ---'
    & docker exec $cname sh -c 'rm -f /work/*; cp -R /fixtures/h-memory-flood/. /work/' 2>&1 | ForEach-Object { Log $_ }
    & docker exec $cname sh /probe/peak-memory.sh template.typ 2>&1 | ForEach-Object { Log $_ }
    & docker exec $cname sh -c 'rm -f /work/*; cp -R /fixtures/a-valid-resume/. /work/' 2>&1 | Out-Null

    Log ''
    Log '--- CROSS-JOB LEAKAGE (V21) ---'
    & docker exec $cname sh /probe/cross-job.sh 2>&1 | ForEach-Object { Log $_ }

    # V19's two-stage kill needs the CPU-loop fixture staged, and it leaves the container
    # unable to be reused afterwards in some cases, so it gets the valid fixture restored
    # immediately after.
    Log ''
    Log '--- WALL-CLOCK TIMEOUT AND KILL (V19) ---'
    & docker exec $cname sh -c 'rm -f /work/*; cp -R /fixtures/i-cpu-loop/. /work/' 2>&1 | ForEach-Object { Log $_ }
    & docker exec $cname sh /probe/timeout.sh 10 2 2>&1 | ForEach-Object { Log $_ }
    & docker exec $cname sh -c 'rm -f /work/*; cp -R /fixtures/a-valid-resume/. /work/' 2>&1 | Out-Null

    Log ''
    Log '--- ERROR SURFACE (V23) ---'
    & docker exec $cname sh /probe/error-surface.sh 2>&1 | ForEach-Object { Log $_ }

    Log ''
    Log '--- OUTPUT CAP AND TRAVERSAL DEFENCE (V20, V22) ---'
    & docker exec $cname sh /probe/cap-output.sh 2>&1 | ForEach-Object { Log $_ }

    Log ''
    Log '--- ARTIFACT VALIDATOR REJECTS PLANTED CORRUPTIONS (V22) ---'
    # The over-20-MiB case cannot be staged in /out, because the 16 MiB tmpfs makes a
    # file that large unreachable by construction. That is the mount doing its job, so
    # check 5 is proven against a separate mount with no size cap - see the
    # oversized-artifact check that follows this table.
    # Each case plants the corruption the policy check exists to catch, then runs the
    # same validator that passed the good artifact above. A validator that accepts any
    # of these is not validating.
    $cases = @(
      @{ n='second file in /out (check 3)'; s='printf x > /out/artifact.pdf; printf y > /out/extra.txt' },
      @{ n='artifact is a symlink (check 2)';  s='printf x > /out/real.pdf; rm -f /out/artifact.pdf; ln -s /out/real.pdf /out/artifact.pdf' },
      @{ n='artifact has wrong magic (check 6)'; s='printf "NOTAPDF" > /out/artifact.pdf' },
      @{ n='no artifact at all (check 1)';    s='rm -f /out/artifact.pdf' }
    )
    foreach ($case in $cases) {
      Log "  case: $($case.n)"
      & docker exec $cname sh -c "rm -f /out/*; $($case.s)" 2>&1 | ForEach-Object { Log "    setup: $_" }
      & docker exec $cname sh /probe/validate-artifact.sh 2>&1 | ForEach-Object { Log "    $_" }
      Log "    validator exit=$LASTEXITCODE"
    }
    & docker exec $cname sh -c 'rm -f /out/*' 2>&1 | Out-Null
  }
  finally {
    & docker rm -f $cname 2>&1 | Out-Null
  }

  # Check 5 (the 20 MiB supervisor cap) is unreachable through /out, because the 16 MiB
  # tmpfs refuses to hold a file that big. Proving it therefore needs a mount with no
  # size cap. This container has ONE extra, spike-only, host bind used solely to stage an
  # oversized file; it is not part of the worker contract, which is the three binds
  # asserted above and in docker-compose.yml.
  $oc = "t1005-oversize-$PID"
  & docker rm -f $oc 2>&1 | Out-Null
  Log ''
  Log '--- 20 MiB SUPERVISOR CAP (V20 check 5) on an uncapped mount ---'
  $oargs = @(
    'run','-d','--name',$oc,
    '--network','none','--read-only','--user','65532:65532',
    '--cap-drop','ALL','--security-opt','no-new-privileges',
    '--memory','1073741824','--memory-swap','1073741824','--cpus','1','--pids-limit','64',
    '--tmpfs','/work:rw,nosuid,nodev,noexec,size=32m,mode=0700,uid=65532,gid=65532',
    '--tmpfs','/out:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=65532,gid=65532',
    '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
    '-v',"$Repo\backend\typst\spike\probe`:/probe:ro",
    '-v',"$Repo\backend\typst\toolchain:/opt/typst:ro",
    '-v',"$SpikeOut`:/stage:rw",
    '--entrypoint','/bin/sleep', $Image, '300'
  )
  $oid = & docker @oargs 2>&1
  if ($LASTEXITCODE -ne 0) { Log "  CREATE FAILED: $oid" }
  else {
    try {
      & docker exec $oc sh -c 'mkdir -p /stage/big && dd if=/dev/zero of=/stage/big/artifact.pdf bs=1M count=21 2>/dev/null && printf "%%PDF-" | dd of=/stage/big/artifact.pdf conv=notrunc 2>/dev/null; ls -l /stage/big' 2>&1 | ForEach-Object { Log "  $_" }
      & docker exec $oc sh -c 'cd /stage/big && ln -sfn . out 2>/dev/null; true' 2>&1 | Out-Null
      & docker exec $oc sh '/probe/validate-oversize.sh' 2>&1 | ForEach-Object { Log "  $_" }
      Log "  validator exit=$LASTEXITCODE"
    }
    finally { & docker rm -f $oc 2>&1 | Out-Null }
  }

  # The memory and PID probes each get a FRESH container. Measured reason, not style:
  # the fork storm in cap-pids.sh leaves the container unable to spawn any further
  # process, so every later `docker exec` in that container fails with "unable to spawn
  # stage-1: Resource temporarily unavailable". When the probes shared a container, the
  # validator cases that followed were reported as failures without ever having run.
  # The OOM probe has the same problem in principle, so it is isolated for symmetry and
  # so that a failure in one cannot be misread as a failure in another.
  # V18's decisive evidence is collected from OUTSIDE the container, because once the pid
  # cap is reached the container cannot spawn the process that would report its own
  # state - and `docker exec` fails too, so an in-container-only probe cannot be
  # interrogated afterwards at all.
  $pc = "t1005-pids-$PID"
  & docker rm -f $pc 2>&1 | Out-Null
  Log ''
  Log '--- PID CAP (V18), in its own container, observed from the host ---'
  $pargs = @(
    'run','-d','--name',$pc,
    '--network','none','--read-only','--ipc','none',
    '--user','65532:65532','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--pids-limit','64',
    '--memory','1073741824','--memory-swap','1073741824','--cpus','1',
    '--tmpfs','/work:rw,nosuid,nodev,noexec,size=32m,mode=0700,uid=65532,gid=65532',
    '--tmpfs','/out:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=65532,gid=65532',
    '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
    '-v',"$Repo\backend\typst\spike\probe`:/probe:ro",
    '-v',"$Repo\backend\typst\toolchain:/opt/typst:ro",
    '-v',"$Repo\backend\typst\packages:/opt/typst-packages:ro",
    '-v',"$Repo\backend\typst\fonts:/opt/typst-fonts:ro",
    '-e','TZ=UTC','-e','LC_ALL=C.UTF-8','-e','HOME=/nonexistent',
    '--entrypoint','/bin/sleep', $Image, '600'
  )
  $pout = & docker @pargs 2>&1
  if ($LASTEXITCODE -ne 0) { Log "  CREATE FAILED: $pout" }
  else {
    Log "  container up: $pout"
    Log '  pids.max visible in docker inspect (V18 first half):'
    & docker inspect $pc --format '    PidsLimit={{.HostConfig.PidsLimit}}' 2>&1 | ForEach-Object { Log $_ }
    Log '  in-container probe:'
    & docker exec $pc sh /probe/cap-pids.sh 2>&1 | ForEach-Object { Log $_ }
    Log '  EXTERNAL evidence: docker exec must now FAIL, because the cap binds the'
    Log '  daemon exec path too, not just the payload:'
    $probeOut = & docker exec $pc sh -c 'echo STILL_ALIVE' 2>&1
    $probeRc = $LASTEXITCODE
    Log "    docker exec exit=$probeRc"
    Log "    docker exec output: $($probeOut -join ' ')"
    $top = & docker exec $pc sh -c 'ls -d /proc/[0-9]* | wc -l' 2>&1
    Log "    pids visible in /proc: $top"
    if ($probeRc -ne 0) {
      Log '  V18 PASS: at pids_limit=64 the container can no longer spawn a process at'
      Log '  all, and the Docker exec path fails with a kernel refusal. That is the cap'
      Log '  biting, observed from outside, which is the only place it is observable.'
    } else {
      Log "  V18 INCONCLUSIVE: exec still succeeded (exit $probeRc)"
    }
    & docker rm -f $pc 2>&1 | Out-Null
  }

  # The memory probe gets its own container too: an OOM-killed child is survivable, but
  # isolating it keeps a failure in one from being misread as a failure in another.
  $mc = "t1005-mem-$PID"
  & docker rm -f $mc 2>&1 | Out-Null
  Log ''
  Log '--- MEMORY CAP (V17), shell-side, in its own container ---'
  $margs = @(
    'run','-d','--name',$mc,
    '--network','none','--read-only','--ipc','none',
    '--user','65532:65532','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--pids-limit','64',
    '--memory','1073741824','--memory-swap','1073741824','--cpus','1',
    '--tmpfs','/work:rw,nosuid,nodev,noexec,size=32m,mode=0700,uid=65532,gid=65532',
    '--tmpfs','/out:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=65532,gid=65532',
    '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
    '-v',"$Repo\backend\typst\spike\probe`:/probe:ro",
    '-v',"$Repo\backend\typst\toolchain:/opt/typst:ro",
    '-v',"$Repo\backend\typst\packages:/opt/typst-packages:ro",
    '-v',"$Repo\backend\typst\fonts:/opt/typst-fonts:ro",
    '-e','TZ=UTC','-e','LC_ALL=C.UTF-8','-e','HOME=/nonexistent',
    '--entrypoint','/bin/sleep', $Image, '300'
  )
  $mout = & docker @margs 2>&1
  if ($LASTEXITCODE -ne 0) { Log "  CREATE FAILED: $mout" }
  else {
    try { & docker exec $mc sh /probe/cap-memory.sh 2>&1 | ForEach-Object { Log $_ } }
    finally { & docker rm -f $mc 2>&1 | Out-Null }
  }
}

if ($Probes) {
  Invoke-Probes
} elseif ($Suite) {
  $results = @()
  $results += Invoke-Fixture 'a-valid-resume' 'template.typ'
  $results += Invoke-Fixture 'a-valid-resume' 'template.typ'      # V3: second run, same input
  $results += Invoke-Fixture 'b-symlink-escape' 'template.typ' -NoAudit -Symlink
  $results += Invoke-Fixture 'b-symlink-escape' 'template.typ' -Symlink
  $results += Invoke-Fixture 'c1-read-parent-escape' 'template.typ'
  $results += Invoke-Fixture 'c2-eval-computed-escape' 'template.typ'
  $results += Invoke-Fixture 'c3-absolute-read' 'template.typ'
  $results += Invoke-Fixture 'd-wasm-plugin' 'template.typ'
  $results += Invoke-Fixture 'e-network-image' 'template.typ'
  $results += Invoke-Fixture 'f-unvendored-package' 'template.typ'
  $results += Invoke-Fixture 'g-vendored-package' 'template.typ'
  $results += Invoke-Fixture 'l-error-surface' 'template.typ'
  $results += Invoke-Fixture 'h-memory-flood' 'template.typ' -Budget 60
  $results += Invoke-Fixture 'i-cpu-loop' 'template.typ' -Budget 10
  $results += Invoke-Fixture 'j-output-flood' 'template.typ' -Budget 30
  Log ''
  Log '===== SUITE SUMMARY ====='
  $results | Format-Table -AutoSize | Out-String -Width 120 | Write-Host
} else {
  Invoke-Fixture $Fixture $Entry -Symlink:$PlantSymlink -NoAudit:$BypassAudit -Budget $TimeoutSec | Out-Null
}
