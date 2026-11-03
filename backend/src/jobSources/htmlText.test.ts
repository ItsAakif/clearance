import { describe, it, expect, vi, afterEach } from 'vitest';
import { htmlToText, decodeHtmlEntities } from './htmlText.js';
import { fetchGreenhouse } from './index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decodeHtmlEntities', () => {
  it('decodes the common named entities', () => {
    expect(decodeHtmlEntities('a &amp; b')).toBe('a & b');
    expect(decodeHtmlEntities('&lt;p&gt;')).toBe('<p>');
    expect(decodeHtmlEntities('&quot;hi&quot;')).toBe('"hi"');
    expect(decodeHtmlEntities('it&#39;s')).toBe("it's");
    expect(decodeHtmlEntities('it&#x27;s')).toBe("it's");
    expect(decodeHtmlEntities('it&apos;s')).toBe("it's");
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a b');
  });

  it('decodes numeric decimal and hex entities', () => {
    expect(decodeHtmlEntities('&#65;')).toBe('A');
    expect(decodeHtmlEntities('&#x41;')).toBe('A');
    expect(decodeHtmlEntities('&#X41;')).toBe('A');
    expect(decodeHtmlEntities('&#8364;')).toBe('\u20AC');
  });

  it('leaves unknown entities literally', () => {
    expect(decodeHtmlEntities('&unknown; &copy')).toBe('&unknown; &copy');
  });

  it('decodes only a single pass (double-encoded input stays encoded once)', () => {
    // Stripe-style double-escaped payload: one pass only.
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
  });
});

describe('htmlToText', () => {
  it('passes plain text through trimmed (fast path)', () => {
    expect(htmlToText('  Build APIs at scale.  ')).toBe('Build APIs at scale.');
    expect(htmlToText('no markup here')).toBe('no markup here');
  });

  it('returns empty string for empty/undefined/null', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText(null)).toBe('');
  });

  it('strips tags and decodes entities (Greenhouse shape)', () => {
    expect(htmlToText('<p>Build &amp; ship</p>')).toBe('Build & ship');
  });

  it('decodes entities first so encoded markup is stripped, not kept', () => {
    // Decode-first order: &lt;tag&gt; becomes a real tag before stripping.
    expect(htmlToText('<p>&lt;tag&gt; &quot;q&quot; &#x27;s&#39; end</p>'))
      .toBe('"q" \'s\' end');
  });

  it('turns <br> and </p> into newlines', () => {
    expect(htmlToText('one<br>two')).toBe('one\ntwo');
    expect(htmlToText('one<br/>two')).toBe('one\ntwo');
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo');
    expect(htmlToText('<div>a</div><li>b</li>')).toBe('a\nb');
    expect(htmlToText('<h2>Head</h2>body')).toBe('Head\nbody');
  });

  it('removes <script> and <style> bodies', () => {
    expect(htmlToText('<script>alert(1)</script><p>hi</p>')).toBe('hi');
    expect(htmlToText('<STYLE>.x{color:red}</STYLE><p>hi</p>')).toBe('hi');
    expect(htmlToText('<ScRiPt type="text/javascript">var a = 1;</ScRiPt>ok')).toBe('ok');
  });

  it('handles nested and unclosed tags', () => {
    expect(htmlToText('<div><p>Hello <b>World</b></p></div>')).toBe('Hello World');
    expect(htmlToText('<p>Unclosed')).toBe('Unclosed');
    expect(htmlToText('<div><span><i>deep</i></span></div>')).toBe('deep');
  });

  it('does not let ">" inside an attribute eat the rest of the string', () => {
    const out = htmlToText('<a href="?a=1>b=2">Apply here</a>');
    expect(out).toContain('Apply here');
    expect(out).not.toContain('<a');
  });

  it('collapses excess whitespace', () => {
    expect(htmlToText('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb');
    expect(htmlToText('<p>a     b</p>')).toBe('a b');
  });

  it('is idempotent on a representative HTML string', () => {
    const html = '<div><h2>Role &amp; perks</h2><p>Build <b>fast</b> &amp; ship.<br>Remote</p>'
      + '<script>track()</script><style>.x{}</style></div>';
    const once = htmlToText(html);
    expect(once).not.toMatch(/<[^>]*>/);
    expect(once).not.toContain('&amp;');
    expect(htmlToText(once)).toBe(once);
  });

  it('strips entity-encoded markup instead of leaving decoded tags', () => {
    // Decode-first order: encoded tags become real tags, then are stripped.
    const out = htmlToText('&lt;strong&gt;Senior&lt;/strong&gt; Engineer &amp; Lead');
    expect(out).toBe('Senior Engineer & Lead');
    expect(out).not.toContain('&amp;');
  });

  it('strips a fully entity-encoded list, including the lone closing tag', () => {
    const out = htmlToText(
      '&lt;ul&gt;&lt;li&gt;Build APIs&lt;/li&gt;&lt;li&gt;Ship fast&lt;/li&gt;&lt;/ul&gt;',
    );
    expect(out).toContain('Build APIs');
    expect(out).toContain('Ship fast');
    expect(out).not.toContain('<');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('&gt;');
  });

  it('removes a lone entity-encoded closing tag mid-text', () => {
    const out = htmlToText('Great role &lt;/ul&gt; apply now');
    expect(out).toContain('Great role');
    expect(out).toContain('apply now');
    expect(out).not.toContain('</ul>');
    expect(out).not.toContain('&lt;');
  });

  it('strips double-escaped fragments with the second decode+strip pass', () => {
    const out = htmlToText(
      '&amp;lt;strong&amp;gt;Senior&amp;lt;/strong&amp;gt; Engineer',
    );
    expect(out).toBe('Senior Engineer');
    expect(out).not.toContain('<');
    expect(out).not.toContain('&');
  });

  it('removes entity-encoded script bodies', () => {
    expect(htmlToText('&lt;script&gt;evil()&lt;/script&gt;<p>hi</p>')).toBe('hi');
  });

  it('is idempotent on entity-encoded and double-escaped samples', () => {
    const samples = [
      '&lt;ul&gt;&lt;li&gt;Build APIs&lt;/li&gt;&lt;/ul&gt;',
      'Great role &lt;/ul&gt; apply now',
      '&amp;lt;strong&amp;gt;Senior&amp;lt;/strong&amp;gt; Engineer',
      '&lt;strong&gt;Senior&lt;/strong&gt; Engineer &amp; Lead',
    ];
    for (const sample of samples) {
      const once = htmlToText(sample);
      expect(once).not.toContain('&lt;');
      expect(once).not.toMatch(/<[^>]*>/);
      expect(htmlToText(once)).toBe(once);
    }
  });
});

describe('fetchGreenhouse cleans HTML descriptions', () => {
  it('maps jobs[0].content HTML to clean text', async () => {
    const payload = {
      jobs: [
        {
          id: 1,
          title: 'Backend Engineer',
          location: { name: 'Remote' },
          content: '<p>Build &amp; ship <b>APIs</b></p><script>evil()</script>',
          absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(payload), { status: 200 }),
    ));
    const rows = await fetchGreenhouse('acme', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('Build & ship APIs');
    expect(rows[0].description).not.toContain('<');
    expect(rows[0].description).not.toContain('&amp;');
  });
});
