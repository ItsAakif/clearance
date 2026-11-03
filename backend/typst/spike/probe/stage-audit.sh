# T1005 spike - staging audit. The spike's stand-in for the `lstat` walk that
# backend/src/render/stage.ts MUST perform before every compile (policy 3.3, 5.2.5).
#
# Two independent gates, both reported rather than assumed:
#   1. NAME: every entry must be on the staged-name allowlist. In production that is
#      `template.typ`, `data.json`, and the `metadata.json`-declared assets. This
#      spike's fixtures only ever declare the first two.
#   2. TYPE: every entry must be a regular file or a directory. A symlink, hardlink,
#      FIFO, socket or device node is refused, because typst issue #5454 is OPEN: a
#      symlink inside the root is followed by `read()` and its target's content ends
#      up in the PDF. The name gate alone would not catch a symlink NAMED
#      `data.json`, so the type gate is the load-bearing one.
#
# Exit 0 always: the harness reads the REJECT-* lines to decide whether the job should
# have been refused. It does not exit non-zero itself, so that a run can report both
# the audit finding and the compile result in one transcript.
cd /work || exit 1
echo "--- entries in /work ---"
ls -la
for f in * .[!.]*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  case "$f" in
    template.typ|data.json) ;;
    *) echo "REJECT-NAME: $f" ;;
  esac
  if [ -L "$f" ]; then
    echo "REJECT-SYMLINK: $f -> $(readlink "$f")"
  elif [ ! -f "$f" ]; then
    echo "REJECT-NOT-REGULAR: $f"
  fi
done
echo "audit-complete"
