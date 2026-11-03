# T1005 - licence and provenance manifest for the Typst render worker

Every third-party artefact that is executed by, or can influence the output of, a
Clearance render. One entry per artefact, with the version and the SHA-256 that
`fetch-assets.sh` and the `Dockerfile` both enforce. An artefact with no entry here is
not vendored and cannot be resolved by a compile.

Normative references: `.planning/specs/clearance-v2/render-sandbox-policy.md` section 7,
`.planning/specs/clearance-v2/03-oss-and-licenses.md:85` and `:115`,
ADR-038 decision 4, ADR-041 D3.

ASCII only, by repo requirement.

---

## 1. Engine: Typst (the only executable in the image)

| Field | Value |
|---|---|
| Component | `typst` - the primary typesetter (ADR-038 decision 1) |
| Version | **0.15.1**, exact |
| Upstream | typst/typst, https://github.com/typst/typst |
| Release tag | `v0.15.1`, published 2026-07-17 |
| Asset | `typst-x86_64-unknown-linux-musl.tar.xz` |
| Asset size | 17,462,992 bytes |
| **Asset SHA-256** | `a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c` |
| **Binary SHA-256** | `29273eaa04f6d00edd0c2bec578f565fc9c65be856bfbffc894567c68ed0b237` |
| Binary size | 55,739,488 bytes |
| Target triple | `x86_64-unknown-linux-musl` (static musl; policy 7.1 mandates musl, not gnu) |
| `typst --version` | `typst 0.15.1 (9dfd3a08)` |
| **Licence** | **Apache-2.0** |
| Licence file shipped | Yes - `toolchain/LICENSE` (9,723 bytes) and `toolchain/NOTICE` (21,066 bytes), unpacked from the release archive by both the Dockerfile and `fetch-assets.sh` |
| Copyright | Copyright (c) 2019-2026 the Typst authors |

### 1.1 Why 0.15.1, deliberately (ADR-041 D3 requires a reasoned choice)

- **It is the newest release in the current line.** `v0.15.1` is what
  `https://api.github.com/repos/typst/typst/releases/latest` returned on 2026-09-30, so
  the pin is the current stable, not a laggard.
- **It clears the CVE floor.** ADR-038 records a patched memory-safety CVE in
  anything before 0.14.2 and mandates `>= 0.14.2`. 0.15.1 is two minor lines past that
  floor, and the policy's own pin (Appendix A) already names 0.15.1, so the spike and
  the policy agree.
- **Licence is Apache-2.0**, which is what the project is built on and what
  `03-oss-and-licenses.md` expects of the primary typesetter. No copyleft, no
  distribution obligation beyond shipping the NOTICE, which the image does.
- **It is the only asset shape the image can use.** The musl build is statically linked,
  so the runtime image needs no glibc and no `libstdc++`. The binary is prebuilt and
  pre-stripped, so nothing is compiled at image build time and the build has no Rust
  toolchain in it.
- **The exact-pin requirement is met with zero ambiguity.** The upstream release
  publishes the asset's own SHA-256 in its release metadata. T1005 re-read that field
  from the GitHub API and confirmed it matches the value recorded in policy 7.1 and in
  `backend/src/render/sandbox.ts` `TYPST_PIN.sha256`. That is a genuine
  independent-source check, not a value copied forward on trust.
- **Known cost, accepted and recorded:** Typst takes backwards-incompatible changes
  across minor releases. T1005 hit that directly - the MIT package `@preview/tidy:0.1.0`
  does not compile on 0.15.1 (see `packages.lock`). This is why ADR-038 makes version
  pins mandatory and why a package pin records the engine it was tested against.

### 1.2 Where this pin appears (policy 7.2: the version is recorded in three places)

1. `backend/typst/Dockerfile` - `ARG TYPST_VERSION=0.15.1` and `ARG TYPST_SHA256=a6d0...`
2. This file, `packages.lock` and the recorded image digest in the T1005 progress note
3. `backend/src/render/sandbox.ts` - `TYPST_PIN` (the machine-readable copy that
   `buildCompileArgs()` stamps onto every plan, and which rejects a template whose
   `engineVersionPins` disagree with `RENDER_TOOLCHAIN_MISMATCH`)

T1005 asserts all three agree, and asserts the running binary's SHA-256 matches the
binary digest above, from inside the worker.

### 1.3 Base image

| Field | Value |
|---|---|
| Component | `alpine` (runtime base) |
| Version | 3.20.3, pinned **by digest** |
| Digest | `sha256:1e42bbe2508154c9126d48c2b8a75420c3544343bf86fd041fb7527e017a4b4a` |
| Licence | Apache-2.0 (the musl libc is MIT; busybox is GPL-2.0-only) |
| Why Alpine | The engine is a static musl binary. Alpine is the smallest musl base that also carries a `/etc/passwd` entry for uid 65532, which assertion V4 needs, plus busybox `stat`/`find`/`sha256sum` for the broker-side staging audit. The image has no package manager, no compiler and no editor, so a code-execution escape has nothing to reach for. |
| Why pinned by digest | A floating `alpine:3.20` tag makes the image digest unreproducible, i.e. an unpinned dependency (ADR-041 D3). |

### 1.4 Rejected engine versions

| Version | Reason rejected |
|---|---|
| `latest` / any floating tag | Forbidden by policy 7.1. Resolves to a moving target. |
| A distro `typst` package | Forbidden by policy 7.1. Alpine's package version moves with the distro release, and the packaged build carries different features (notably which font sets are embedded), so the same Dockerfile would produce a different engine. |
| `cargo install typst-cli` | Forbidden by policy 7.1. Resolves a moving dependency tree, needs a Rust toolchain in the image, and cannot be digest-pinned as a unit. |
| 0.15.0, 0.14.x | Superseded by 0.15.1 within the same compatible line. There is no reason to pin an older point release when the newer one is the current upstream release. |
| 0.13.x and earlier | Below the 0.14.2 CVE floor from ADR-038. |
| `x86_64-unknown-linux-gnu` | Would drag glibc into the image for no benefit; policy 7.1 mandates musl. |
| `aarch64` / `armv7` assets | Not wrong, just not this deployment. Verified present upstream with digests `5aa8d74a...` and `44986312...`; a multi-arch port is a pin change in `packages.lock`. |

---

## 2. Fonts

The font set is a closed, vendored allowlist. That is not a nicety: risk R14 is that a
different host's installed fonts produce a different PDF, so "same input -> same bytes"
would be false. `--font-path` is the only font source, `--ignore-system-fonts` is set,
and `--ignore-embedded-fonts` is set, so the set is exactly what is listed here.

| Field | Value |
|---|---|
| Component | **Source Serif 4** |
| Version | 4.005R (tag `4.005R`, published 2023-01-20) |
| Upstream | adobe-fonts/source-serif, https://github.com/adobe-fonts/source-serif |
| Asset | `source-serif-4.005_Desktop.zip` |
| Asset size | 17,634,695 bytes |
| **Asset SHA-256** | `549fdb8f9a682bd06944298621404969f6de77c2e422ff3b8244a1dcd6a0c425` |
| **Licence** | **SIL Open Font License 1.1 (OFL-1.1)** |
| Licence file shipped | Yes - `fonts/LICENSE.md`, unpacked from the asset by `fetch-assets.sh` |
| Copyright | Copyright 2014-2023 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source' |

Vendored faces (three of the sixteen in the distribution; the set is an allowlist, so
a smaller allowlist is a smaller thing to audit):

| File | Bytes | SHA-256 |
|---|---|---|
| `SourceSerif4-Regular.ttf` | 261,868 | `e5a4ee6a3d87bb9024796be390c6771e2a0eb1883dae25effaf57ca01668e24b` |
| `SourceSerif4-Semibold.ttf` | 272,088 | `36db62940cb5728b12b1802476dc7fcf4c6c519a7bdd476ba23a4e555fc4655f` |
| `SourceSerif4-Bold.ttf` | 271,568 | `7cf4f4e1ad74f45058d5bc61716b82560442fbdcd9d3654d2dea96bf6c683d86` |

Rejected candidates:

| Candidate | Licence | Why rejected |
|---|---|---|
| DejaVu 2.37 | Bitstream Vera + Arev (permissive, not OFL) | The licence is a poor fit for an open-source product that redistributes, and the project standard is OFL. |
| Noto Serif / Noto Sans | OFL-1.1 | Correct licence, but the upstream release archives are 70-117 MB to obtain two faces. |
| Inter 4.1 | OFL-1.1 | Correct licence, 33 MB archive, and it is a UI face rather than a print text face. |

Fonts that are NOT vendored and therefore NOT available to any template: Typst's embedded
set (Libertinus Serif, New Computer Modern, New Computer Math, DejaVu Sans Mono) is
excluded by `--ignore-embedded-fonts`; the container's system has no fontconfig and no
font packages; and `/opt/typst-fonts` is the only font path. A template naming any other
family gets a compile error, which is the font-allowlist mechanism working.

---

## 3. Typst packages

| Count | Third-party Typst Universe packages | **0** |
|---|---|---|
| Count | First-party packages in the vendored tree | **1** (`@clearance/spike-probe:1.0.0`) |

The spike's compile path requires no Universe package; `packages.lock` carries the full
statement, the proof, and the procedure for adding one. The single first-party entry is
repository source under the project's own Apache-2.0 licence, and it exists only to give
the vendored-resolution mechanism a subject for assertion V12:

| Field | Value |
|---|---|
| Spec | `@clearance/spike-probe:1.0.0` |
| Namespace | `clearance` (first party; `preview` is the Typst Universe namespace) |
| Upstream | `backend/typst/packages/clearance/spike-probe/1.0.0` (tracked in git) |
| Licence | Apache-2.0 (project's own) |
| Used by | `fixtures/g-vendored-package` only |
| Product templates may import it | **No.** `spikeOnly: true`. |

Third-party candidates evaluated and rejected during T1005, with reasons, so the choice
is reviewable rather than asserted:

| Package | Version | Licence | Rejected because |
|---|---|---|---|
| `@preview/valkyrie` | 0.2.0 | GPL-3.0-only | Copyleft. Any template importing it produces a GPL-covered document. |
| `@preview/cetz` | 0.3.1 | LGPL-3.0-or-later | Weak copyleft is survivable, but its manifest declares `compiler = "0.12.0"`, i.e. it is not maintained against typst 0.15.1. A pin that breaks on every engine bump is an outage. |
| `@preview/tidy` | 0.1.0 | MIT | Closest fit - MIT and dependency-free - but it does **not compile** on typst 0.15.1: `src/tidy.typ:96` fails with `sequence does not have field "label-prefix"`. Shipping a pinned-but-broken package is worse than shipping none. |

---

## 4. What is deliberately NOT in the image

| Not present | Why |
|---|---|
| A shell wrapper / entrypoint script | Policy 13.2: `ENTRYPOINT` must not assemble, add, remove or reorder policy flags. `ENTRYPOINT` is the pinned binary, so the caller's argv is the argv. |
| A package manager (`apk`) | The image is provisioned at build time and never at run time. A package manager is a root-shell-shaped privilege that the container does not need. |
| A compiler, editor, or `git` | Nothing in a render job compiles or edits anything. Absence is the control. |
| Any `.env`, key, or secret | Policy 10.1.4: only fixed, non-secret policy values are ever passed. |
| `/var/run/docker.sock` | Forbidden by policy 4.5. The docker socket is host-root-equivalent. |
| Any host path outside the repo | Forbidden by policy 4.5. The bind allowlist is exactly three, all inside `backend/typst/`. |
| TeX Live, `pdflatex`, `tlmgr` | Policy 11.3: T1005 does not build or install TeX. LaTeX is export-only and T1042 owns it. |

---

## 5. Verification commands for this manifest

```sh
# The engine pin, from inside the worker
docker compose run --rm typst-worker --version

# The binary that actually ran, hashed inside the container
docker compose run --rm --entrypoint sha256sum typst-worker /opt/typst/typst

# The vendored font set, as the worker sees it
docker compose run --rm --entrypoint ls typst-worker /opt/typst-fonts

# The vendored package tree
docker compose run --rm --entrypoint ls typst-worker /opt/typst-packages

# Re-verify every host-side digest
docker run --rm -v "$(pwd)/backend/typst:/stage" alpine:3.20 sh /stage/fetch-assets.sh

# The licences this manifest claims are shipped are actually shipped
docker compose run --rm --entrypoint ls typst-worker /opt/typst
```

## 6. Amendment rule

Adding, removing or re-pinning anything in this file requires, together: a new entry
here with an exact version and SHA-256, a matching line in `packages.lock`, a matching
`ARG` in the `Dockerfile`, a matching entry in `fetch-assets.sh`, and a re-run of the
T1005 spike. A pin that exists in only some of those places is a defect, which is why
the spike asserts they agree instead of trusting that they do.
