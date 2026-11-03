import { describe, expect, it, vi, beforeEach } from 'vitest';

// Proves the provider-abstraction fix: a leased non-groq key must yield that
// provider's baseURL. Both boundaries are mocked — no real API is ever hit.

const openaiInstances: Array<{ apiKey?: string; baseURL?: string }> = [];

const { mockLeaseNextLlmKey, mockMarkSuccess, mockMarkFailure, completionHandler } = vi.hoisted(() => ({
  mockLeaseNextLlmKey: vi.fn(),
  mockMarkSuccess: vi.fn(),
  mockMarkFailure: vi.fn(),
  completionHandler: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat: { completions: { create: (...args: unknown[]) => unknown } };
    constructor(opts: { apiKey?: string; baseURL?: string }) {
      openaiInstances.push(opts);
      this.chat = { completions: { create: (...args: unknown[]) => completionHandler(...args) } };
    }
  },
}));

vi.mock('./keyManager.js', () => ({
  leaseNextLlmKey: mockLeaseNextLlmKey,
  markKeySuccess: mockMarkSuccess,
  markKeyFailure: mockMarkFailure,
  isRateLimitError: () => false,
}));

vi.mock('./providerModels.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providerModels.js')>();
  return {
    ...actual,
    getProviderModel: vi.fn(async () => 'test-model'),
    runLlmCompletion: async (_provider: string, _model: string, run: () => Promise<unknown>) => run(),
  };
});

function llmKey(provider: string) {
  return { id: `test-${provider}`, apiKey: 'test-key', provider, source: 'env' as const, userId: null };
}

describe('provider baseURL selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openaiInstances.length = 0;
  });

  it('interviewGenerator uses the openrouter baseURL for an openrouter key', async () => {
    mockLeaseNextLlmKey.mockResolvedValue(llmKey('openrouter'));
    completionHandler.mockResolvedValue({ choices: [{ message: { content: 'Mock answer' } }] });
    const { generateInterviewAnswer } = await import('./interviewGenerator.js');

    const answer = await generateInterviewAnswer({ question: 'Tell me about yourself.' });

    expect(answer).toBe('Mock answer');
    expect(mockLeaseNextLlmKey).toHaveBeenCalled();
    expect(openaiInstances).toHaveLength(1);
    expect(openaiInstances[0].baseURL).toBe('https://openrouter.ai/api/v1');
    expect(openaiInstances[0].apiKey).toBe('test-key');
    expect(mockMarkSuccess).toHaveBeenCalled();
    expect(completionHandler).toHaveBeenCalled();
    expect((completionHandler.mock.calls[0][0] as { model?: string }).model).toBe('test-model');
  });

  it('interviewGenerator uses the gemini baseURL for a gemini key', async () => {
    mockLeaseNextLlmKey.mockResolvedValue(llmKey('gemini'));
    completionHandler.mockResolvedValue({ choices: [{ message: { content: 'Mock answer' } }] });
    const { generateInterviewAnswer } = await import('./interviewGenerator.js');

    await generateInterviewAnswer({ question: 'Why this role?' });

    expect(openaiInstances).toHaveLength(1);
    expect(openaiInstances[0].baseURL).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
  });

  // T1110 DELETED `ai/resumeGenerator.ts` (FREEZE A-40), so these two cases can no longer run
  // through `improveResumeBullet`. The PROPERTY they guard did not move: a leased key must yield
  // THAT provider's base URL, and the only thing under test is the
  // `leaseNextLlmKey` -> `createLlmClient` -> `runLlmCompletion` chain that `providerModels.ts`
  // owns and that every live BYOK caller goes through. `interviewGenerator` (FREEZE B-21) is on
  // that same chain, so the assertions are byte-identical - only the entry point moved, and
  // openai and groq are still each leased and still each asserted, which is the whole point of
  // these two cases. Nothing about the guarantee is weaker.
  it('a leased openai key yields the openai baseURL', async () => {
    mockLeaseNextLlmKey.mockResolvedValue(llmKey('openai'));
    completionHandler.mockResolvedValue({ choices: [{ message: { content: 'Mock answer' } }] });
    const { generateInterviewAnswer } = await import('./interviewGenerator.js');

    const result = await generateInterviewAnswer({ question: 'What have you shipped?' });

    expect(result).toBe('Mock answer');
    expect(openaiInstances).toHaveLength(1);
    expect(openaiInstances[0].baseURL).toBe('https://api.openai.com/v1');
  });

  it('a leased groq key still yields the groq baseURL', async () => {
    mockLeaseNextLlmKey.mockResolvedValue(llmKey('groq'));
    completionHandler.mockResolvedValue({ choices: [{ message: { content: 'Mock answer' } }] });
    const { generateInterviewAnswer } = await import('./interviewGenerator.js');

    await generateInterviewAnswer({ question: 'What have you shipped?' });

    expect(openaiInstances).toHaveLength(1);
    expect(openaiInstances[0].baseURL).toBe('https://api.groq.com/openai/v1');
  });
});
