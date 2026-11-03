import { describe, it, expect } from 'vitest';
import {
  isUrlAllowed,
  isRedirectAllowed,
  isInScope,
  isResolvedIpAllowed,
  isUrlAllowedWithResolvedIp,
  type GuardVerdict,
} from './guard.js';

function mustDeny(v: GuardVerdict): string {
  expect(v.allowed).toBe(false);
  if (v.allowed) throw new Error('expected deny, got allow');
  return v.reason;
}

function mustAllow(v: GuardVerdict): void {
  expect(v).toEqual({ allowed: true });
}

describe('isUrlAllowed — positive cases', () => {
  const allowed: string[] = [
    'https://careers.example.com/jobs/123',
    'https://example.org/',
    'http://example.org/plain-http-is-still-http',
    'https://example.com:8443/with-port',
    'HTTPS://Careers.Example.COM./mixed-case-and-trailing-dot',
    'https://acme.io/jobs?q=engineer&page=2#results',
  ];
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      mustAllow(isUrlAllowed(url));
    });
  }

  it('allows public boundary addresses next to private ranges', () => {
    mustAllow(isUrlAllowed('http://172.32.0.1/'));
    mustAllow(isUrlAllowed('http://172.15.255.255/'));
    mustAllow(isUrlAllowed('http://11.0.0.1/'));
    mustAllow(isUrlAllowed('http://8.8.8.8/'));
    mustAllow(isUrlAllowed('http://1.1.1.1/'));
  });
});

describe('isUrlAllowed — rejected schemes', () => {
  const urls: string[] = [
    'file:///etc/passwd',
    'data:text/html,<h1>hi</h1>',
    'ftp://example.com/file',
    'javascript:alert(1)',
    'ws://example.com/socket',
    'wss://example.com/socket',
    'dict://example.com/word',
    'gopher://example.com/',
    '//example.com/protocol-relative',
    'example.com/no-scheme',
    '',
    '   ',
  ];
  for (const url of urls) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      const reason = mustDeny(isUrlAllowed(url));
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(0);
    });
  }
});

describe('isUrlAllowed — credentials in URL (no auth-wall bypassing)', () => {
  const urls: string[] = [
    'https://user:pass@careers.example.com/',
    'https://user@careers.example.com/',
    'http://admin:s3cret@8.8.8.8/',
    'http://careers.example.com@127.0.0.1/',
  ];
  for (const url of urls) {
    it(`rejects ${url}`, () => {
      expect(mustDeny(isUrlAllowed(url))).toContain('credentials');
    });
  }
});

describe('isUrlAllowed — loopback', () => {
  const urls: string[] = [
    'http://127.0.0.1/',
    'http://127.0.0.2:8080/',
    'http://127.1/',
    'http://127.0.1/',
    'http://0x7f.0.0.1/',
    'http://0x7f000001/',
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://017700000001/',
    'http://localhost/',
    'http://LOCALHOST/',
    'http://localhost./',
    'http://localhost:3000/admin',
    'http://sub.localhost/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
  ];
  for (const url of urls) {
    it(`rejects ${url}`, () => {
      mustDeny(isUrlAllowed(url));
    });
  }
});

describe('isUrlAllowed — link-local, private, multicast, unspecified', () => {
  const cases: Array<[string, string]> = [
    ['http://169.254.10.20/', 'link-local'],
    ['http://[fe80::1]/', 'link-local'],
    ['http://10.1.2.3/', 'private'],
    ['http://10.0.0.1/', 'private'],
    ['http://0x0a000001/', 'private'],
    ['http://172.16.0.1/', 'private'],
    ['http://172.31.255.255/', 'private'],
    ['http://192.168.1.1/', 'private'],
    ['http://3232235777/', 'private'],
    ['http://0xc0.0xa8.0x1.0x1/', 'private'],
    ['http://[fc00::1]/', 'private'],
    ['http://[fd00::dead:beef]/', 'private'],
    ['http://224.0.0.1/', 'multicast'],
    ['http://239.1.1.1/', 'multicast'],
    ['http://[ff02::1]/', 'multicast'],
    ['http://0.0.0.0/', 'unspecified'],
    ['http://[::]/', 'unspecified'],
    ['http://intranet/', 'non-public'],
    ['http://server/', 'non-public'],
  ];
  for (const [url, fragment] of cases) {
    it(`rejects ${url} (${fragment})`, () => {
      expect(mustDeny(isUrlAllowed(url))).toContain(fragment);
    });
  }
});

describe('isUrlAllowed — cloud metadata', () => {
  const urls: string[] = [
    'http://169.254.169.254/',
    'http://169.254.169.254/latest/meta-data/',
    'http://2852039166/',
    'http://0xa9fea9fe/',
    'http://0251.0376.0251.0376/',
    'http://025177524776/',
    'http://[::ffff:169.254.169.254]/',
    'http://100.100.100.200/',
    'http://metadata.google.internal/',
    'http://jobs.metadata.google.internal/',
    'http://METADATA.GOOGLE.INTERNAL./',
    'http://metadata.goog/',
    'http://[fd00:ec2::254]/',
  ];
  for (const url of urls) {
    it(`rejects ${url}`, () => {
      expect(mustDeny(isUrlAllowed(url))).toContain('metadata');
    });
  }
});

describe('isUrlAllowed — malformed input never throws', () => {
  const inputs: unknown[] = [
    '',
    '   ',
    'not a url',
    'http://',
    'http://???',
    '://missing-scheme',
    'http://1.2.3.4.5/',
    'http://999.999.999.999/',
    'http://[:::]/',
    'http://[::ffff::1]/',
    null,
    undefined,
    42,
    {},
  ];
  for (const input of inputs) {
    it(`denies ${JSON.stringify(input)} without throwing`, () => {
      let verdict: GuardVerdict;
      expect(() => {
        verdict = isUrlAllowed(input as string);
      }).not.toThrow();
      mustDeny(verdict!);
    });
  }
});

describe('isRedirectAllowed', () => {
  it('allows a same-host redirect', () => {
    mustAllow(
      isRedirectAllowed(
        'https://careers.example.com/a',
        'https://careers.example.com/b',
      ),
    );
  });

  it('allows a same-registrable-domain subdomain redirect', () => {
    mustAllow(
      isRedirectAllowed(
        'https://careers.example.com/a',
        'https://jobs.example.com/b',
      ),
    );
  });

  it('allows a subdomain redirect under a two-label suffix', () => {
    mustAllow(
      isRedirectAllowed(
        'https://careers.example.co.uk/a',
        'https://jobs.example.co.uk/b',
      ),
    );
  });

  it('rejects a cross-domain redirect', () => {
    expect(
      mustDeny(
        isRedirectAllowed(
          'https://careers.example.com/a',
          'https://other.com/b',
        ),
      ),
    ).toContain('registrable-domain');
  });

  it('rejects a lookalike suffix redirect', () => {
    mustDeny(
      isRedirectAllowed(
        'https://careers.example.com/a',
        'https://example.com.evil.com/b',
      ),
    );
  });

  it('rejects a redirect whose target is a blocked address', () => {
    expect(
      mustDeny(
        isRedirectAllowed(
          'https://careers.example.com/a',
          'http://169.254.169.254/',
        ),
      ),
    ).toContain('redirect target rejected');
  });

  it('rejects a redirect from a malformed source', () => {
    mustDeny(isRedirectAllowed('not a url', 'https://example.com/'));
  });

  it('rejects IP-literal redirects to a different address', () => {
    mustDeny(isRedirectAllowed('http://8.8.8.8/a', 'http://1.1.1.1/b'));
  });

  it('allows an IP-literal redirect to the same address', () => {
    mustAllow(isRedirectAllowed('http://8.8.8.8/a', 'http://8.8.8.8/b'));
  });
});

describe('isInScope', () => {
  const page = 'https://careers.example.com/jobs';

  it('allows an absolute same-host link', () => {
    mustAllow(isInScope(page, 'https://careers.example.com/jobs/1'));
  });

  it('allows a relative link resolved against the page', () => {
    mustAllow(isInScope(page, '/jobs/1'));
    mustAllow(isInScope(page, 'jobs/1'));
  });

  it('rejects a different-host link even on the same registrable domain', () => {
    expect(mustDeny(isInScope(page, 'https://jobs.example.com/1'))).toContain(
      'out of run scope',
    );
  });

  it('rejects an off-site link', () => {
    mustDeny(isInScope(page, 'https://other.com/'));
  });

  it('propagates the SSRF verdict for an in-scope-looking target', () => {
    mustDeny(isInScope(page, 'https://careers.example.com@127.0.0.1/'));
  });

  it('rejects a malformed page URL without throwing', () => {
    mustDeny(isInScope('not a url', 'https://careers.example.com/'));
    expect(() =>
      isInScope('not a url', 'https://careers.example.com/'),
    ).not.toThrow();
  });
});

describe('isResolvedIpAllowed — pre-resolved entry point', () => {
  it('allows a public address', () => {
    mustAllow(isResolvedIpAllowed('8.8.8.8'));
    mustAllow(isResolvedIpAllowed('1.1.1.1'));
    mustAllow(isResolvedIpAllowed('93.184.216.34'));
  });

  it('rejects private, loopback, link-local, and metadata addresses', () => {
    for (const ip of [
      '10.0.0.5',
      '172.16.9.9',
      '192.168.0.7',
      '127.0.0.1',
      '169.254.10.20',
      '169.254.169.254',
      '100.100.100.200',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'ff02::1',
      '::ffff:10.0.0.5',
      'fd00:ec2::254',
    ]) {
      expect(mustDeny(isResolvedIpAllowed(ip))).toContain(
        'resolved address rejected',
      );
    }
  });

  it('rejects hostnames, empties, and garbage without throwing', () => {
    for (const ip of ['', '   ', 'example.com', 'localhost', 'garbage', '1.2.3.4.5']) {
      let verdict: GuardVerdict;
      expect(() => {
        verdict = isResolvedIpAllowed(ip);
      }).not.toThrow();
      mustDeny(verdict!);
    }
  });
});

describe('isUrlAllowedWithResolvedIp', () => {
  it('allows a good URL with a public resolved address', () => {
    mustAllow(
      isUrlAllowedWithResolvedIp('https://careers.example.com/', '8.8.8.8'),
    );
  });

  it('rejects when the resolved address is private (rebinding)', () => {
    expect(
      mustDeny(
        isUrlAllowedWithResolvedIp('https://careers.example.com/', '10.0.0.5'),
      ),
    ).toContain('resolved address rejected');
  });

  it('rejects when the URL itself is blocked even with a good address', () => {
    mustDeny(
      isUrlAllowedWithResolvedIp('http://127.0.0.1/', '8.8.8.8'),
    );
  });
});
