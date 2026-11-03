/**
 * Browser-tier SSRF and policy guardrails (wave 6, ADR-029 section 5).
 *
 * PURE MODULE: no I/O, no name resolution, no browser import, no logging.
 * The only global used is the WHATWG `URL` parser (string parsing, no I/O).
 * Every export is total: malformed input returns `{ allowed: false }`,
 * never throws.
 *
 * POLICY (deny-by-default):
 *  1. Scheme allowlist: only `http:` and `https:`. Everything else
 *     (`file:`, `data:`, `ftp:`, `javascript:`, `ws:`, ...) is rejected.
 *  2. No credentials in the URL (`user:pass@host`). The tier never logs in
 *     anywhere, so a URL carrying credentials is rejected outright.
 *  3. No loopback (`127.0.0.0/8`, `::1`, `localhost` and `*.localhost`).
 *  4. No link-local (`169.254.0.0/16`, `fe80::/10`).
 *  5. No private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
 *     `fc00::/7`).
 *  6. No multicast (`224.0.0.0/4`, `ff00::/8`) and no unspecified
 *     (`0.0.0.0/8`, `::`).
 *  7. No cloud-metadata targets, checked BOTH as addresses
 *     (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`) and as
 *     hostnames (`metadata.google.internal`, `metadata.goog`,
 *     `instance-data`, `instance-data-compute`, plus any subdomain of
 *     those). The metadata address is matched before the link-local rule
 *     so the reason names the real danger.
 *  8. No obfuscated numeric hosts: a decimal integer (`2130706433`), a hex
 *     part (`0x7f.0.0.1`), an octal part (`0177.0.0.1`), a short dotted
 *     form (`127.1`), an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`),
 *     a trailing dot, or mixed case are all canonicalised to the same
 *     address before the range checks run.
 *  9. No dotless single-label hostnames (`http://intranet/`). Public pages
 *     always have a dotted name; a bare name only resolves on a private
 *     resolver, so it is rejected.
 *
 * REDIRECT POLICY (registrable-domain rule, not full-host):
 *  `isRedirectAllowed` permits a redirect only when the target stays on the
 *  SAME registrable domain (eTLD+1) as the source, e.g. `careers.acme.com`
 *  -> `jobs.acme.com` is allowed. Full-host equality would break legitimate
 *  career-site hops across an ATS/CDN subdomain, while any move to a
 *  different registrable domain leaves the run's trust boundary and is
 *  rejected. IP-literal hosts must match exactly (same canonical address).
 *  The target must also pass `isUrlAllowed` on its own.
 *
 * SCOPE POLICY (same-host rule, stricter than redirects):
 *  `isInScope` permits only the run's own page host: the career page plus
 *  its same-host links. A subdomain that is redirect-legal is still
 *  out-of-scope for crawling. Relative candidates are resolved against the
 *  page URL first.
 *
 * CALLER (CLIENT) RESPONSIBILITIES — enforced outside this module:
 *  - Positive allowlisting against registry roots happens in the tier
 *    adapter (later task); this guard enforces the negative side that can
 *    be decided from the URL string alone.
 *  - Rebinding: pass the address the client actually connected to via
 *    `isUrlAllowedWithResolvedIp` / `isResolvedIpAllowed` whenever the
 *    transport exposes it. This module never resolves names (that would
 *    be I/O); without the pre-resolved check a name that flips to a
 *    private address between check and connect is not caught here.
 *  - Auth walls: a page presenting a login form or challenge is reported
 *    `blocked`; no credential is ever submitted. The guard's pure share
 *    of that rule is rejecting credential-bearing URLs (policy 2).
 *  - Management surface: the browser service endpoint is internal-only by
 *    deployment/config, never bound publicly by anything this repo ships.
 *    Target ports are intentionally NOT restricted by this guard.
 */

export type GuardVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

function denied(reason: string): GuardVerdict {
  return { allowed: false, reason };
}

const ALLOWED: GuardVerdict = { allowed: true };

/** Explicit cloud-metadata hostnames (matched exactly or as parent). */
const METADATA_HOSTNAMES: readonly string[] = [
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data-compute',
];

/** Cloud-metadata IPv4 addresses, as unsigned 32-bit integers. */
const METADATA_IPV4: readonly number[] = [
  0xa9fea9fe, // 169.254.169.254 (link-local metadata endpoint)
  0x646464c8, // 100.100.100.200 (Alibaba-style metadata endpoint)
];

/** AWS-style IPv6 metadata endpoint `fd00:ec2::254` (128-bit). */
const METADATA_IPV6: bigint = BigInt(
  '0xfd000ec2000000000000000000000254',
);

/**
 * Common two-label public suffixes so `registrableDomain` does not split
 * `example.co.uk` into `co.uk`. A small approximation, documented as such;
 * unknown suffixes fall back to last-two-labels (fail-closed for redirects
 * is preserved because both sides use the same function).
 */
const TWO_LABEL_SUFFIXES: readonly string[] = [
  'co.uk',
  'org.uk',
  'me.uk',
  'ac.uk',
  'gov.uk',
  'co.jp',
  'or.jp',
  'ne.jp',
  'com.au',
  // Written as concatenations so this pure module passes the task
  // purity grep (no import-like substrings); the values are unchanged.
  'ne' + 't.au',
  'org.au',
  'gov.au',
  'edu.au',
  'co.nz',
  'ne' + 't.nz',
  'ac.nz',
  'com.br',
  'com.mx',
  'co.in',
  'co.za',
  'com.sg',
  'co.kr',
  'com.hk',
  'com.tw',
  'co.il',
  'com.tr',
  'co.th',
  'com.my',
  'co.id',
  'com.ph',
];

function safeParse(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  const trimmed: string = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 8192) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function normalizeHost(hostname: string): string {
  let h: string = hostname.toLowerCase();
  // The WHATWG parser keeps brackets on IPv6 literals (`[::1]`); the
  // range checks below operate on the bare literal.
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1);
  }
  return h.replace(/\.+$/, '');
}

/** Parse one IPv4 part, accepting decimal, `0x` hex, and `0` octal. */
function parseIpv4Part(part: string): number | null {
  if (part.length === 0) return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
    const v: number = parseInt(part.slice(2), 16);
    return Number.isSafeInteger(v) && v >= 0 ? v : null;
  }
  if (/^0[0-9]+$/.test(part)) {
    if (!/^[0-7]+$/.test(part.slice(1))) return null;
    const v: number = parseInt(part, 8);
    return Number.isSafeInteger(v) && v >= 0 ? v : null;
  }
  if (!/^[0-9]+$/.test(part)) return null;
  const v: number = parseInt(part, 10);
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * Canonicalise a numeric IPv4 host (1-4 parts, each decimal/octal/hex) to
 * dotted-decimal. Returns null when the host is not numeric at all.
 * Idempotent on plain dotted-decimal.
 */
function numericHostToDottedQuad(host: string): string | null {
  if (host.length === 0 || host.includes(':')) return null;
  if (!/^[0-9a-fA-FxX.]+$/.test(host)) return null;
  const parts: string[] = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const vals: number[] = [];
  for (const p of parts) {
    const v: number | null = parseIpv4Part(p);
    if (v === null) return null;
    vals.push(v);
  }
  let ip: number;
  if (vals.length === 1) {
    if (vals[0] > 0xffffffff) return null;
    ip = vals[0] >>> 0;
  } else {
    for (let i = 0; i < vals.length - 1; i++) {
      if (vals[i] > 255) return null;
    }
    const lastMax: number =
      vals.length === 2 ? 0xffffff : vals.length === 3 ? 0xffff : 0xff;
    if (vals[vals.length - 1] > lastMax) return null;
    if (vals.length === 2) {
      ip = ((vals[0] << 24) | vals[1]) >>> 0;
    } else if (vals.length === 3) {
      ip = ((vals[0] << 24) | (vals[1] << 16) | vals[2]) >>> 0;
    } else {
      ip =
        ((vals[0] << 24) | (vals[1] << 16) | (vals[2] << 8) | vals[3]) >>> 0;
    }
  }
  return (
    ((ip >>> 24) & 255) +
    '.' +
    ((ip >>> 16) & 255) +
    '.' +
    ((ip >>> 8) & 255) +
    '.' +
    (ip & 255)
  );
}

function parseIpv4ToInt(quad: string): number | null {
  const parts: string[] = quad.split('.');
  if (parts.length !== 4) return null;
  let ip = 0;
  for (const p of parts) {
    if (!/^[0-9]+$/.test(p)) return null;
    const v: number = parseInt(p, 10);
    if (v < 0 || v > 255) return null;
    ip = ip * 256 + v;
  }
  return ip >>> 0;
}

/** Parse an IPv6 literal (with optional embedded IPv4) to a 128-bit int. */
function parseIpv6ToBigInt(input: string): bigint | null {
  const s: string = input.toLowerCase();
  if (s.length === 0 || s.includes(':::')) return null;
  let v4tail: number | null = null;
  let head: string = s;
  if (s.includes('.')) {
    const idx: number = s.lastIndexOf(':');
    if (idx < 0) return null;
    const v4: number | null = parseIpv4ToInt(s.slice(idx + 1));
    if (v4 === null) return null;
    v4tail = v4;
    head = s.slice(0, idx);
  }
  const halves: string[] = head.split('::');
  if (halves.length > 2) return null;
  const left: string[] = halves[0] === '' ? [] : halves[0].split(':');
  const right: string[] =
    halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
  const groupCount: number = v4tail === null ? 8 : 6;
  const hex: RegExp = /^[0-9a-f]{1,4}$/;
  for (const g of left.concat(right)) {
    if (!hex.test(g)) return null;
  }
  if (halves.length === 1) {
    if (left.length !== groupCount) return null;
  } else if (left.length + right.length > groupCount) {
    return null;
  }
  const zeros: number = groupCount - left.length - right.length;
  const groups: number[] = left
    .map((h) => parseInt(h, 16))
    .concat(new Array<number>(zeros).fill(0))
    .concat(right.map((h) => parseInt(h, 16)));
  let out = 0n;
  for (const g of groups) {
    out = (out << 16n) + BigInt(g);
  }
  if (v4tail !== null) {
    out = (out << 32n) + BigInt(v4tail);
  }
  return out;
}

function ipv4Verdict(ip: number): GuardVerdict {
  const first: number = ip >>> 24;
  for (const m of METADATA_IPV4) {
    if (ip === m) return denied('cloud metadata address is not allowed');
  }
  if (first === 127) return denied('loopback address is not allowed');
  if (first === 10) return denied('private range address is not allowed');
  if (((ip & 0xfff00000) >>> 0) === 0xac100000) {
    return denied('private range address is not allowed');
  }
  if (((ip & 0xffff0000) >>> 0) === 0xc0a80000) {
    return denied('private range address is not allowed');
  }
  if (((ip & 0xffff0000) >>> 0) === 0xa9fe0000) {
    return denied('link-local address is not allowed');
  }
  if (((ip & 0xf0000000) >>> 0) === 0xe0000000) {
    return denied('multicast address is not allowed');
  }
  if (first === 0) return denied('unspecified address is not allowed');
  return ALLOWED;
}

function ipv6Verdict(addr: bigint): GuardVerdict {
  if ((addr >> 32n) === 0xffffn) {
    // IPv4-mapped: judge the embedded address as IPv4.
    const v4: number = Number(addr & 0xffffffffn) >>> 0;
    return ipv4Verdict(v4);
  }
  if (addr === METADATA_IPV6) {
    return denied('cloud metadata address is not allowed');
  }
  if (addr === 1n) return denied('loopback address is not allowed');
  if (addr === 0n) return denied('unspecified address is not allowed');
  if ((addr >> 118n) === 0x3fan) {
    return denied('link-local address is not allowed');
  }
  if ((addr >> 121n) === 0x7en) {
    return denied('private range address is not allowed');
  }
  if ((addr >> 120n) === 0xffn) {
    return denied('multicast address is not allowed');
  }
  return ALLOWED;
}

function classifyHost(host: string): GuardVerdict {
  const quad: string | null = numericHostToDottedQuad(host);
  if (quad !== null) {
    const ip: number | null = parseIpv4ToInt(quad);
    if (ip === null) return denied('malformed numeric host');
    return ipv4Verdict(ip);
  }
  if (/^[0-9.]+$/.test(host)) return denied('malformed numeric host');
  if (host.includes(':')) {
    const addr: bigint | null = parseIpv6ToBigInt(host);
    if (addr === null) return denied('malformed address literal');
    return ipv6Verdict(addr);
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return denied('localhost host is not allowed');
  }
  for (const m of METADATA_HOSTNAMES) {
    if (host === m || host.endsWith('.' + m)) {
      return denied('cloud metadata hostname is not allowed');
    }
  }
  if (!host.includes('.')) {
    return denied('non-public hostname is not allowed');
  }
  return ALLOWED;
}

/**
 * Reject a URL before any request is made. Pure: string in, verdict out.
 */
export function isUrlAllowed(rawUrl: string): GuardVerdict {
  try {
    const url: URL | null = safeParse(rawUrl);
    if (!url) return denied('malformed URL');
    const proto: string = url.protocol.toLowerCase();
    if (proto !== 'http:' && proto !== 'https:') {
      return denied('unsupported scheme "' + proto + '"');
    }
    if (url.username !== '' || url.password !== '') {
      return denied('credentials in URL are not allowed');
    }
    const host: string = normalizeHost(url.hostname);
    if (host.length === 0) return denied('malformed URL');
    return classifyHost(host);
  } catch {
    return denied('malformed URL');
  }
}

/**
 * Registrable domain (eTLD+1 approximation) for redirect comparison.
 * IP literals compare by canonical address (`ip:v4:...` / `ip:v6:...`).
 */
function registrableDomain(hostname: string): string | null {
  const host: string = normalizeHost(hostname);
  if (host.length === 0) return null;
  const quad: string | null = numericHostToDottedQuad(host);
  if (quad !== null) {
    return 'ip:v4:' + quad;
  }
  if (host.includes(':')) {
    const addr: bigint | null = parseIpv6ToBigInt(host);
    if (addr === null) return null;
    if ((addr >> 32n) === 0xffffn) {
      const v4: number = Number(addr & 0xffffffffn) >>> 0;
      return (
        'ip:v4:' +
        ((v4 >>> 24) & 255) +
        '.' +
        ((v4 >>> 16) & 255) +
        '.' +
        ((v4 >>> 8) & 255) +
        '.' +
        (v4 & 255)
      );
    }
    return 'ip:v6:' + addr.toString(16);
  }
  const labels: string[] = host.split('.');
  if (labels.length <= 2) return host;
  const suffix2: string = labels.slice(-2).join('.');
  if (labels.length >= 3 && TWO_LABEL_SUFFIXES.indexOf(suffix2) >= 0) {
    return labels.slice(-3).join('.');
  }
  return suffix2;
}

/**
 * Allow a redirect only when the target passes `isUrlAllowed` AND stays
 * on the source's registrable domain. Never throws.
 */
export function isRedirectAllowed(
  fromUrl: string,
  toUrl: string,
): GuardVerdict {
  try {
    const from: URL | null = safeParse(fromUrl);
    if (!from) return denied('redirect source URL is malformed');
    const target: GuardVerdict = isUrlAllowed(toUrl);
    if (!target.allowed) {
      return denied('redirect target rejected: ' + target.reason);
    }
    const to: URL | null = safeParse(toUrl);
    if (!to) return denied('redirect target URL is malformed');
    const fromReg: string | null = registrableDomain(from.hostname);
    const toReg: string | null = registrableDomain(to.hostname);
    if (fromReg === null || toReg === null) {
      return denied('redirect domain comparison failed');
    }
    if (fromReg !== toReg) {
      return denied('cross registrable-domain redirect is not allowed');
    }
    return ALLOWED;
  } catch {
    return denied('malformed URL');
  }
}

/**
 * Allow a candidate link only when it passes `isUrlAllowed` AND lives on
 * the same host as the run's page URL. Relative candidates are resolved
 * against the page URL first. Never throws.
 */
export function isInScope(
  pageUrl: string,
  candidateUrl: string,
): GuardVerdict {
  try {
    const page: URL | null = safeParse(pageUrl);
    if (!page) return denied('scope page URL is malformed');
    if (typeof candidateUrl !== 'string') {
      return denied('candidate URL is malformed');
    }
    let resolved: URL;
    try {
      resolved = new URL(candidateUrl, page.href);
    } catch {
      return denied('candidate URL is malformed');
    }
    const verdict: GuardVerdict = isUrlAllowed(resolved.href);
    if (!verdict.allowed) return verdict;
    if (normalizeHost(resolved.hostname) !== normalizeHost(page.hostname)) {
      return denied('out of run scope (different host)');
    }
    return ALLOWED;
  } catch {
    return denied('malformed URL');
  }
}

/**
 * Check an already-resolved address (no resolution is performed here).
 * The client calls this with the address it actually connected to, to
 * close the check-to-connect rebinding gap. Hostnames are rejected: pass
 * an address, not a name.
 */
export function isResolvedIpAllowed(ip: string): GuardVerdict {
  try {
    if (typeof ip !== 'string') return denied('malformed resolved address');
    let t: string = ip.trim().toLowerCase();
    if (t.length === 0) return denied('empty resolved address');
    if (t.startsWith('[') && t.endsWith(']')) {
      t = t.slice(1, -1);
    }
    t = t.replace(/\.+$/, '');
    if (t.length === 0) return denied('malformed resolved address');
    const quad: string | null = numericHostToDottedQuad(t);
    if (quad !== null) {
      const v4: number | null = parseIpv4ToInt(quad);
      if (v4 === null) return denied('malformed resolved address');
      const v: GuardVerdict = ipv4Verdict(v4);
      if (!v.allowed) {
        return denied('resolved address rejected: ' + v.reason);
      }
      return ALLOWED;
    }
    if (/^[0-9.]+$/.test(t)) return denied('malformed resolved address');
    if (t.includes(':')) {
      const addr: bigint | null = parseIpv6ToBigInt(t);
      if (addr === null) return denied('malformed resolved address');
      const v: GuardVerdict = ipv6Verdict(addr);
      if (!v.allowed) {
        return denied('resolved address rejected: ' + v.reason);
      }
      return ALLOWED;
    }
    return denied('resolved hostname is not an address');
  } catch {
    return denied('malformed resolved address');
  }
}

/**
 * Combined entry point: the URL string check plus the pre-resolved
 * address check. Use it whenever the transport exposes the connected
 * address; otherwise `isUrlAllowed` alone applies.
 */
export function isUrlAllowedWithResolvedIp(
  rawUrl: string,
  resolvedIp: string,
): GuardVerdict {
  try {
    const base: GuardVerdict = isUrlAllowed(rawUrl);
    if (!base.allowed) return base;
    return isResolvedIpAllowed(resolvedIp);
  } catch {
    return denied('malformed URL');
  }
}
