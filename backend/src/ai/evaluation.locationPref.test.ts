// T406: evaluator locationPref coercion (string | string[]).
// The prompt's `Location preference` line must be unchanged for legacy
// single-string profiles and comma-joined for stored JSON arrays.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./keyManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./keyManager.js')>();
  return {
    ...actual,
    leaseNextLlmKey: vi.fn(),
    markKeySuccess: vi.fn(),
    markKeyFailure: vi.fn(),
  };
});

vi.mock('./providerModels.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providerModels.js')>();
  return {
    ...actual,
    getProviderModel: vi.fn(),
    createLlmClient: vi.fn(),
  };
});

import { leaseNextLlmKey, markKeySuccess } from './keyManager.js';
import { getProviderModel, createLlmClient } from './providerModels.js';
import {
  evaluateJob,
  formatLocationPrefForPrompt,
  type CareerProfileLike,
} from './evaluation.js';

const leaseMock = vi.mocked(leaseNextLlmKey);
const modelMock = vi.mocked(getProviderModel);
const clientMock = vi.mocked(createLlmClient);
const successMock = vi.mocked(markKeySuccess);

const FAKE_KEY = {
  id: 'key-1',
  apiKey: 'test-secret-key-abc123',
  provider: 'groq',
  source: 'database' as const,
  userId: 'user-1',
  label: null,
};

const CANNED_EVAL_JSON = JSON.stringify({
  roleSummary: 'Test role.',
  cvMatchScore: 4,
  levelFitScore: 4,
  compFitScore: 3,
  personalizationScore: 4,
  interviewPrepScore: 4,
  legitimacyScore: 5,
  overallScore: 4,
  recommendation: 'apply',
  isScam: false,
});

interface CapturedCreate {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

function stubLlm(captured: CapturedCreate[]): void {
  leaseMock.mockResolvedValue(FAKE_KEY);
  modelMock.mockResolvedValue('test-model');
  clientMock.mockReturnValue({
    chat: {
      completions: {
        create: async (params: CapturedCreate) => {
          captured.push(params);
          return { choices: [{ message: { content: CANNED_EVAL_JSON } }] };
        },
      },
    },
  } as never);
}

function locationLine(userContent: string): string {
  const line = userContent
    .split('\n')
    .find((entry) => entry.includes('Location preference:'));
  if (!line) throw new Error('Location preference line missing from prompt');
  return line;
}

const RESUME = { summary: 'Engineer' };

describe('formatLocationPrefForPrompt', () => {
  it('passes a legacy plain string through unchanged', () => {
    expect(formatLocationPrefForPrompt('Remote')).toBe('Remote');
    expect(formatLocationPrefForPrompt('Berlin')).toBe('Berlin');
  });

  it('joins a string array with commas', () => {
    expect(formatLocationPrefForPrompt(['Berlin', 'Remote'])).toBe('Berlin, Remote');
  });

  it('decodes a stored JSON-array string to the same joined display', () => {
    expect(formatLocationPrefForPrompt('["Berlin", "Remote"]')).toBe('Berlin, Remote');
  });

  it('returns empty for nullish/blank input so the prompt falls back to n/a', () => {
    expect(formatLocationPrefForPrompt(undefined)).toBe('');
    expect(formatLocationPrefForPrompt(null)).toBe('');
    expect(formatLocationPrefForPrompt('   ')).toBe('');
    expect(formatLocationPrefForPrompt([])).toBe('');
  });
});

describe('evaluateJob Location preference prompt line', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    successMock.mockResolvedValue(undefined as never);
  });

  it('renders a legacy string profile exactly as before', async () => {
    const captured: CapturedCreate[] = [];
    stubLlm(captured);
    const profile: CareerProfileLike = { locationPref: 'Remote' };
    await evaluateJob('user-1', RESUME, 'A usable job description body.', { profile });
    expect(locationLine(captured[0].messages[1].content)).toBe(
      '- Location preference: Remote '
    );
  });

  it('renders a JSON-array stored value as a comma-joined line', async () => {
    const captured: CapturedCreate[] = [];
    stubLlm(captured);
    const profile: CareerProfileLike = {
      locationPref: '["Berlin", "Remote"]',
    };
    await evaluateJob('user-1', RESUME, 'A usable job description body.', { profile });
    expect(locationLine(captured[0].messages[1].content)).toBe(
      '- Location preference: Berlin, Remote '
    );
  });

  it('renders a string[] profile the same as its joined stored form', async () => {
    const captured: CapturedCreate[] = [];
    stubLlm(captured);
    const profile: CareerProfileLike = { locationPref: ['Berlin', 'Remote'] };
    await evaluateJob('user-1', RESUME, 'A usable job description body.', { profile });
    expect(locationLine(captured[0].messages[1].content)).toBe(
      '- Location preference: Berlin, Remote '
    );
  });

  it('renders n/a when no location preference is set', async () => {
    const captured: CapturedCreate[] = [];
    stubLlm(captured);
    await evaluateJob('user-1', RESUME, 'A usable job description body.', {
      profile: {},
    });
    expect(locationLine(captured[0].messages[1].content)).toBe(
      '- Location preference: n/a '
    );
  });
});
