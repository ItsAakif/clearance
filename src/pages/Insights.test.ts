import { describe, it, expect, vi, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { insightsApi } from '@/services/api/insights';

const mockData = {
  totalOpen: 1812,
  postedLast30: 52,
  topSkills: [{ skill: 'TypeScript', count: 10 }],
  workMode: [
    { mode: 'remote' as const, count: 248 },
    { mode: 'hybrid' as const, count: 62 },
  ],
  seniority: [{ level: 'lead', count: 724 }],
  salaryByRegion: [{ region: 'us', currency: 'USD', median: 180000, count: 207 }],
  topCompanies: [{ company: 'Acme', count: 5 }],
  workModeStated: 310,
  seniorityStated: 1004,
  updatedAt: '2026-10-30T12:00:00.000Z',
};

vi.mock('@/services/api/insights', () => ({
  insightsApi: { catalogue: vi.fn() },
}));

import Insights from './Insights';

beforeEach(() => {
  (insightsApi.catalogue as any).mockResolvedValue(mockData);
});

async function renderPage(): Promise<string> {
  const qc = new QueryClient();
  await qc.prefetchQuery({ queryKey: ['insights', 'catalogue'], queryFn: () => insightsApi.catalogue() });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(Insights)),
  );
}

describe('Insights page', () => {
  it('renders stated-for subtitles', async () => {
    const html = await renderPage();
    assert.match(html, /Stated for 310 of 1,812 postings\./);
    assert.match(html, /Stated for 1,004 of 1,812 postings\./);
  });

  it('renders human seniority labels', async () => {
    const html = await renderPage();
    assert.match(html, /Lead \/ Manager/);
  });

  it('renders single pay row', async () => {
    const html = await renderPage();
    assert.match(html, /USD 180,000 median/);
    assert.match(html, /207 postings/);
    assert.match(html, /US/);
  });

  it('renders header line', async () => {
    const html = await renderPage();
    assert.match(html, /Every open posting across the connected boards\. Updated/);
  });

  it('renders the total as the display anchor', async () => {
    const html = await renderPage();
    assert.match(html, /display-number[^>]*>1,812</);
    assert.match(html, /open postings/);
    assert.match(html, /52 posted in the last 30 days/);
  });

  it('renders measure width', async () => {
    const html = await renderPage();
    assert.match(html, /width:\s*100%/);
  });

  it('renders loading copy with three dots', async () => {
    // Force loading by not prefetching
    const qc = new QueryClient();
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc }, createElement(Insights)),
    );
    assert.match(html, /Loading insights\.\.\./);
  });

  it('renders empty state', async () => {
    (insightsApi.catalogue as any).mockResolvedValue({ ...mockData, totalOpen: 0 });
    const qc = new QueryClient();
    await qc.prefetchQuery({ queryKey: ['insights', 'catalogue'], queryFn: () => insightsApi.catalogue() });
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc }, createElement(Insights)),
    );
    assert.match(html, /Not enough data yet\./);
    assert.match(html, /Browse jobs/);
    (insightsApi.catalogue as any).mockResolvedValue(mockData);
  });

  it('renders distinct seniority labels', async () => {
    (insightsApi.catalogue as any).mockResolvedValue({
      ...mockData,
      seniority: [
        { level: 'staff', count: 30 },
        { level: 'principal', count: 10 },
      ],
    });
    const qc = new QueryClient();
    await qc.prefetchQuery({ queryKey: ['insights', 'catalogue'], queryFn: () => insightsApi.catalogue() });
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc }, createElement(Insights)),
    );
    assert.match(html, /Staff/);
    assert.match(html, /Principal/);
    assert.equal((html.match(/Staff \/ Principal/g) || []).length, 0);
    (insightsApi.catalogue as any).mockResolvedValue(mockData);
  });

  it('renders skills through skillLabel', async () => {
    (insightsApi.catalogue as any).mockResolvedValue({
      ...mockData,
      topSkills: [{ skill: 'amazon web services', count: 10 }],
    });
    const qc = new QueryClient();
    await qc.prefetchQuery({ queryKey: ['insights', 'catalogue'], queryFn: () => insightsApi.catalogue() });
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc }, createElement(Insights)),
    );
    assert.match(html, /AWS/);
    (insightsApi.catalogue as any).mockResolvedValue(mockData);
  });

  it('renders one-line pay row', async () => {
    const html = await renderPage();
    assert.match(html, /US/);
    assert.match(html, /USD 180,000 median, 207 postings/);
  });
});
