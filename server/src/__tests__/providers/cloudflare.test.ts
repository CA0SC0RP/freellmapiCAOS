import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudflareProvider } from '../../providers/cloudflare.js';

describe('CloudflareProvider', () => {
  let provider: CloudflareProvider;

  beforeEach(() => {
    provider = new CloudflareProvider();
  });

  it('should have correct platform and name', () => {
    expect(provider.platform).toBe('cloudflare');
    expect(provider.name).toBe('Cloudflare Workers AI');
  });

  it('should parse account_id:token key format', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'chatcmpl-cf',
          object: 'chat.completion',
          created: 123,
          model: '@cf/meta/llama-3.1-70b-instruct',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from CF!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      } as any;
    });

    const result = await provider.chatCompletion(
      'abc123:my-token-here',
      [{ role: 'user', content: 'Hi' }],
      '@cf/meta/llama-3.1-70b-instruct',
    );

    expect(capturedUrl).toContain('abc123');
    expect(capturedUrl).toContain('/ai/v1/chat/completions');
    expect(capturedHeaders['Authorization']).toBe('Bearer my-token-here');
    expect(capturedBody.model).toBe('@cf/meta/llama-3.1-70b-instruct');
    expect(result.choices[0].message.content).toBe('Hello from CF!');
  });


  it('preserves multimodal user image_url blocks', async () => {
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: async () => ({
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Image received' },
            finish_reason: 'stop',
          }],
        }),
      } as any;
    });

    const content = [
      { type: 'text', text: 'Describe this image' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AA==' },
      },
    ];

    await provider.chatCompletion(
      'test-account:test-token',
      [{ role: 'user', content } as any],
      '@cf/qwen/qwen3.8-27b',
    );

    expect(capturedBody.messages[0].content).toEqual(content);
  });

  it('preserves image_url in streaming requests', async () => {
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: false,
        status: 400,
        statusText: 'Mock stop',
        headers: new Headers(),
        json: async () => ({ error: { message: 'Mock stop' } }),
      } as any;
    });

    const content = [
      { type: 'text', text: 'Describe this image' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    ];

    await expect(
      provider.streamChatCompletion(
        'test-account:test-token',
        [{ role: 'user', content } as any],
        '@cf/qwen/qwen3.8-27b',
      ).next()
    ).rejects.toThrow();

    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.messages[0].content).toEqual(content);
  });

  it('should throw if key format is wrong', async () => {
    await expect(
      provider.chatCompletion('no-colon-here', [{ role: 'user', content: 'Hi' }], 'model')
    ).rejects.toThrow(/account_id:api_token/);
  });

  it.each([':token', 'account:', ':', '   :token', 'account:   ', ' account:token', 'account :token', 'account:token ', 'account: token'])(
    'rejects malformed key with an empty account or token (%s)', async (key) => {
      const fetchSpy = vi.spyOn(global, 'fetch');
      await expect(
        provider.chatCompletion(key, [{ role: 'user', content: 'Hi' }], 'model')
      ).rejects.toThrow(/account_id:api_token/);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  describe('validateKey', () => {
    it('validates via /user/tokens/verify when the token is user-scoped', async () => {
      const calls: string[] = [];
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        calls.push(url as string);
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ success: true, result: { status: 'active' } }),
        } as any;
      });

      expect(await provider.validateKey('acc123:tok')).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBe('https://api.cloudflare.com/client/v4/user/tokens/verify');
    });

    it('falls back to the account-scoped endpoint when /user 403s (#297)', async () => {
      const calls: string[] = [];
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        calls.push(url as string);
        if ((url as string).includes('/user/tokens/verify')) {
          return { ok: false, status: 403, json: () => Promise.resolve({}) } as any;
        }
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ success: true, result: { status: 'active' } }),
        } as any;
      });

      expect(await provider.validateKey('acc123:tok')).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/tokens/verify');
    });

    it('fails with the upstream reason when both scopes reject the token', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async () => {
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: () => Promise.resolve({ success: false, errors: [{ code: 9109, message: 'Invalid access token' }] }),
        } as any;
      });

      const result = await provider.validateKey('acc123:tok');
      expect(result).toMatchObject({ valid: false });
      expect((result as any).error).toContain('HTTP 403');
      expect((result as any).error).toContain('Invalid access token');
    });

    it('fails with the token status when the account scope reports an inactive token', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        if ((url as string).includes('/user/tokens/verify')) {
          return { ok: false, status: 403, json: () => Promise.resolve({}) } as any;
        }
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ success: true, result: { status: 'disabled' } }),
        } as any;
      });

      const result = await provider.validateKey('acc123:tok');
      expect(result).toMatchObject({ valid: false });
      expect((result as any).error).toContain('token status is "disabled"');
    });
  });

  it('should convert null assistant content to empty string (CF rejects null)', async () => {
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'chatcmpl-cf',
          object: 'chat.completion',
          created: 123,
          model: '@cf/meta/llama-3.1-70b-instruct',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'abc123:token',
      [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Karachi"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":30}' },
      ],
      '@cf/meta/llama-3.1-70b-instruct',
    );

    expect(capturedBody.messages[1].content).toBe('');
    expect(capturedBody.messages[1].tool_calls).toHaveLength(1);
  });

  it('preserves structured tool-call responses and sends required tool choice', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String((init as any).body));
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'cf-tool-test',
          object: 'chat.completion',
          created: 123,
          model: '@cf/meta/llama-3.1-70b-instruct',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_weather',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Mexico City"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        }),
      } as any;
    });

    const result = await provider.chatCompletion(
      'abc123:token',
      [{ role: 'user', content: 'What is the weather in Mexico City?' }],
      '@cf/meta/llama-3.1-70b-instruct',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: 'required',
      },
    );

    expect(capturedUrl).toBe('https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1/chat/completions');
    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.tool_choice).toBe('required');
    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls).toEqual([{
      id: 'call_weather',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Mexico City"}' },
    }]);
    expect(result.usage).toEqual({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 });
  });

});
