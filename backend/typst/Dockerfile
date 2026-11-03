# T1005 - Typst render worker image. One container = one compile.
#
# NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md (sections 4 and 7)
# Machine-readable policy: backend/src/render/sandbox.ts
# Task: T1005
#
# WHAT THIS IMAGE IS
#   A pinned, verified Typst binary and nothing else. The compile argv is supplied by
#   the caller (the broker, one job per container). This image deliberately has NO
#   shell entrypoint wrapper: policy section 13.2 forbids an ENTRYPOINT that
#   assembles, adds, removes or reorders policy flags, so ENTRYPOINT IS the pinned
#   binary and the caller's argv is passed through verbatim.
#
# WHY ALPINE AND NOT SCRATCH
#   The typst asset is `x86_64-unknown-linux-musl` (mandated by policy 7.1: a static
#   musl build, so no glibc and no distro package). Alpine is the smallest musl base
#   that carries a /etc/passwd entry for the non-root uid, which assertion V4 needs
#   (`id` must print `uid=65532(65532)`), plus busybox `stat`/`find`/`sha256sum` for the
#   broker-side lstat audit and the runtime digest self-check. This image is NOT a
#   general-purpose shell: there is no `sh -c` here, no package manager, and no text
#   editor, so a code-execution escape has nothing to reach for.
#
# PINNING (ADR-041 D3: exact version, recorded licence, recorded dependency info)
#   - base image: alpine 3.20.3 pinned BY DIGEST (a floating `alpine:3.20` would make
#     the image digest unreproducible, and would be an unpinned dependency).
#   - typst: exact version 0.15.1, exact asset, exact SHA-256 verified with
#     `sha256sum -c` BEFORE unpacking, so an upstream asset swap fails the BUILD
#     rather than a user's render. `typst:latest`, a distro `typst` package and
#     `cargo install typst-cli` are forbidden by policy 7.1 (each moves).
#   - fonts and Typst Universe packages are NOT baked in: they are separate read-only
#     binds (policy 4.5) and are vendored by backend/typst/fetch-assets.sh, which
#     verifies the same digests recorded in backend/typst/LICENSES.md.
#
# NETWORK
#   The BUILD downloads typst once (policy 7.1: "downloaded at image build time
#   only"). The CONTAINER has no network at all: compose sets `network_mode: "none"`,
#   which is the enforcement point for risks R6 and R8. Nothing here re-fetches at
#   container start; `typst update` is never invoked.

# Pinned by digest, not by tag.
ARG ALPINE_DIGEST=sha256:1e42bbe2508154c9126d48c2b8a75420c3544343bf86fd041fb7527e017a4b4a

# ---------------------------------------------------------------------------
# Stage 1 - fetch and verify the pinned typst release. Discarded afterwards.
# ---------------------------------------------------------------------------
FROM alpine:3.20.3@${ALPINE_DIGEST} AS fetch

# Exact pin. Changing any of these three is a TOOLCHAIN BUMP, which invalidates
# every rendered artifact's cache key (policy 10.4 keys the cache on engineVersion).
ARG TYPST_VERSION=0.15.1
ARG TYPST_ASSET=typst-x86_64-unknown-linux-musl.tar.xz
ARG TYPST_SHA256=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c

# HERMETIC BY DEFAULT, NETWORK BY OPT-IN.
#
# The asset in ./backend/typst/typst-dist/ is preferred, and it is ALWAYS re-verified
# with `sha256sum -c` before it is unpacked - a staged copy is checked, never trusted.
# So on a normal build there is no network access at all, which is the desirable
# property for a supply-chain-pinned build: the bytes are the bytes a human already
# hashed on this host.
#
# Set TYPST_FETCH_REMOTE=1 to force a download instead, for a host that wants the
# image build to be the only place the archive ever exists. Either path ends in the
# same `sha256sum -c`, so the two are equivalent as far as integrity is concerned.
#
# T1005 measured why this matters: on the build host used for the spike, the container
# network refused connections to the release CDN (github.com:185.199.109.133 - ECONN
# REFUSED) while the WINDOWS host reached it fine. A build that assumed egress would
# have been unrunnable on exactly the machine doing the work. The pin is what makes
# that survivable, not a workaround: without a recorded digest there would be no way to
# tell a blocked download from a substituted asset.
COPY typst-dist/ /dist/

RUN set -eux; \
    mkdir -p /toolchain; \
    if [ "${TYPST_FETCH_REMOTE:-0}" = "1" ]; then \
      echo "TYPST_FETCH_REMOTE=1: downloading ${TYPST_ASSET} from upstream"; \
      wget -q -O /tmp/typst.tar.xz \
        "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/${TYPST_ASSET}"; \
    else \
      echo "using the pre-staged ./backend/typst/typst-dist/${TYPST_ASSET}"; \
      cp "/dist/${TYPST_ASSET}" /tmp/typst.tar.xz; \
    fi; \
    echo "${TYPST_SHA256}  /tmp/typst.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/typst.tar.xz -C /toolchain --strip-components=1; \
    rm -f /tmp/typst.tar.xz; \
    test -x /toolchain/typst; \
    test -s /toolchain/LICENSE; \
    /toolchain/typst --version; \
    printf '%s\n' "${TYPST_VERSION}" > /toolchain/PIN; \
    sha256sum /toolchain/typst > /toolchain/PIN.sha256

# ---------------------------------------------------------------------------
# Stage 2 - the worker. Alpine (musl) + the verified toolchain. No compiler, no
# package manager, no shell wrapper, non-root, read-only root filesystem at runtime.
# ---------------------------------------------------------------------------
FROM alpine:3.20.3@${ALPINE_DIGEST}

LABEL org.opencontainers.image.title="clearance typst-worker" \
      org.opencontainers.image.description="Pinned Typst 0.15.1 render worker, one compile per container" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.clearance.typst.version="0.15.1" \
      io.clearance.policy=".planning/specs/clearance-v2/render-sandbox-policy.md"

# Non-root identity, created as the numeric name 65532 so that `id` prints
# `uid=65532(65532) gid=65532(65532)` (assertion V4) rather than an unresolvable uid.
# HOME is /nonexistent per policy 3.4: the container must have no HOME state at all.
RUN set -eux; \
    printf '65532:x:65532:65532:typst:/nonexistent:/sbin/nologin\n' >> /etc/passwd; \
    printf '65532:x:65532:\n' >> /etc/group; \
    printf 'CLEARANCE_CANARY_T1005_7f3a91c4 do-not-exfiltrate\n' > /etc/clearance-spike-canary.txt; \
    chmod 0444 /etc/clearance-spike-canary.txt; \
    mkdir -p /opt/typst /work /out

# The verified toolchain. At runtime /opt/typst is shadowed by the read-only bind of
# ./backend/typst/toolchain (policy 4.5); both copies are the same bytes, which the
# spike asserts by digest at runtime. Keeping it in the image means the image alone is
# a complete, self-contained worker.
COPY --from=fetch /toolchain/ /opt/typst/

WORKDIR /work

# uid/gid 65532 in the IMAGE too, so the guarantee survives `docker run` with no
# --user flag (policy 4.2).
USER 65532:65532

# No ENV is set on purpose. Every environment value the worker needs is a fixed,
# non-secret policy value passed by compose / by the broker (policy 10.1.4); putting
# them in the image would make `docker inspect` the only place they exist, and would
# let a future edit widen the sandbox without a compose diff.
#
# There is deliberately NO CMD and NO shell wrapper: the caller's argv is the argv.
ENTRYPOINT ["/opt/typst/typst"]
