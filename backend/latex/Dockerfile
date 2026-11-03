# LaTeX render worker image - one container = one compile.
#
# POLICY REVERSAL (owner decision, 2026-10-31): LaTeX was export-only (ADR-042 D1).
# It now compiles SERVER-SIDE through the same sandboxed render broker as Typst, and
# this image is the pinned toolchain that makes it possible.
#
# PINNING
#   - base: debian:bookworm-slim pinned BY DIGEST (the Typst worker pins alpine the
#     same way). The amd64 manifest is the one the render host runs.
#   - TeX Live: the version Debian bookworm packages, recorded in
#     backend/src/render/sandbox.ts `LATEX_PIN.version` and verified at build time.
#   - the ONLY packages installed are the ones the exporter needs: `article`,
#     `fontenc`, `inputenc` and `geometry` live in `texlive-latex-base`; `cmap`
#     (used by the medium-professional variant) is in `texlive-latex-recommended`;
#     the default Computer Modern faces are in `texlive-fonts-recommended`.
#
# ISOLATION
#   Runtime isolation is not described here: it is applied by the broker
#   (`backend/src/render/broker/createArgs.ts`) and asserted against
#   `REQUIRED_COMPOSE_KEYS` / `REQUIRED_TMPFS` in `backend/src/render/sandbox.ts`.
#   This image is deliberately shell-free at the entrypoint: the caller's argv is the
#   argv, exactly as the Typst worker documents.
#
# The binary is exposed at the policy path `/opt/latex/pdflatex` (a symlink to the
# distro binary). The broker qualifies argv[0] against that read-only path; nothing
# is bind-mounted over it, so the worker always executes the image's own pdflatex.

ARG DEBIAN_DIGEST=sha256:a3bba7dc7dbcc1f37c2856c51fc9a7fac96608f50cb87b1b4e4d8b8c85ae988e
FROM debian:bookworm-slim@${DEBIAN_DIGEST}

LABEL org.opencontainers.image.title="clearance latex-worker" \
      org.opencontainers.image.description="Pinned TeX Live pdflatex render worker, one compile per container" \
      org.opencontainers.image.licenses="LPPL-1.3c" \
      io.clearance.policy=".planning/specs/clearance-v2/render-sandbox-policy.md"

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      texlive-latex-base \
      texlive-latex-recommended \
      texlive-fonts-recommended; \
    rm -rf /var/lib/apt/lists/*; \
    test -x /usr/bin/pdflatex; \
    /usr/bin/pdflatex --version | head -1

# Non-root identity, the same uid/gid as the Typst worker (policy 4.2). The numeric
# name keeps `id` resolvable in a read-only root filesystem.
RUN set -eux; \
    printf '65532:x:65532:65532:latex:/nonexistent:/usr/sbin/nologin\n' >> /etc/passwd; \
    printf '65532:x:65532:\n' >> /etc/group; \
    mkdir -p /opt/latex /work /out; \
    ln -s /usr/bin/pdflatex /opt/latex/pdflatex

WORKDIR /work

USER 65532:65532

# The caller's argv is the argv. No wrapper, no `sh -c`, no flags added here.
ENTRYPOINT ["/usr/bin/pdflatex"]
