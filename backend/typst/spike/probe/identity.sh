# T1005 spike - non-root and root-filesystem write proof (assertion V4, second half).
#
# The policy's pass condition is that `id` prints `uid=65532(65532) gid=65532(65532)`
# AND a write to `/` fails with EROFS. The second half is what distinguishes "the
# container is read-only" from "the process happens to lack permission on a
# writable filesystem", so both are reported separately.
echo "--- identity ---"
id
echo "--- write to / (policy 4.3 read_only: true) ---"
if touch /rootfs-probe 2>/tmp/err; then
  echo 'WROTE-TO-ROOTFS: policy violation'
  rm -f /rootfs-probe
else
  echo "write-to-slash-refused: $(cat /tmp/err)"
fi
echo "--- write to /work (must succeed) ---"
if touch /work/.wtest 2>/tmp/err2; then echo 'work-writable: yes'; rm -f /work/.wtest
else echo "work-writable: NO - $(cat /tmp/err2)"; fi
echo "--- write to /out (must succeed) ---"
if touch /out/.wtest 2>/tmp/err3; then echo 'out-writable: yes'; rm -f /out/.wtest
else echo "out-writable: NO - $(cat /tmp/err3)"; fi
echo "--- write to the toolchain bind (must fail: ro) ---"
if touch /opt/typst/.wtest 2>/tmp/err4; then echo 'TOOLCHAIN-WRITABLE: policy violation'
else echo "toolchain-write-refused: $(cat /tmp/err4)"; fi
echo "--- write to the package bind (must fail: ro) ---"
if touch /opt/typst-packages/.wtest 2>/tmp/err5; then echo 'PACKAGES-WRITABLE: policy violation'
else echo "packages-write-refused: $(cat /tmp/err5)"; fi
echo "--- write to the fonts bind (must fail: ro) ---"
if touch /opt/typst-fonts/.wtest 2>/tmp/err6; then echo 'FONTS-WRITABLE: policy violation'
else echo "fonts-write-refused: $(cat /tmp/err6)"; fi
echo "--- capabilities held (must be empty) ---"
grep -E 'Cap(Prm|Eff|Bnd)' /proc/self/status
echo "--- docker socket present? (must be absent) ---"
if [ -e /var/run/docker.sock ]; then echo 'DOCKER-SOCKET-PRESENT: policy violation'
else echo 'docker-socket-absent'; fi
echo "--- network reachability from inside (must fail) ---"
# A shell-level egress probe is strictly more capable than anything a Typst document
# can do, so if this cannot reach anything, neither can a template.
if wget -q -T 5 -O /dev/null http://1.1.1.1/ 2>/tmp/nerr; then
  echo 'EGRESS-OPEN: policy violation'
else
  echo "egress-refused: $(cat /tmp/nerr)"
fi
if wget -q -T 5 -O /dev/null https://api.github.com/ 2>/tmp/nerr2; then
  echo 'EGRESS-OPEN(https): policy violation'
else
  echo "egress-refused(https): $(cat /tmp/nerr2)"
fi
echo "--- interfaces (network_mode none has only loopback) ---"
ip -o addr 2>/dev/null | sed 's/^/  /' || cat /proc/net/dev
echo "--- tmpfs sizes (policy 4.4) ---"
df -k /work /out /tmp 2>/dev/null | sed 's/^/  /'
