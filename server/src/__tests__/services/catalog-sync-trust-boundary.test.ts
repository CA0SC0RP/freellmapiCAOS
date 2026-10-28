import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb, getSetting, initDb, setSetting } from '../../db/index.js';
import { catalogShapeProblems, SETTING_LICENSE_KEY, syncCatalog } from '../../services/catalog-sync.js';

describe('catalog sync trust boundary', () => {
  it('rejects unknown task tags instead of treating them as verified capabilities', () => {
    const problems = catalogShapeProblems({
      version: '2099.01.01',
      generatedAt: new Date().toISOString(),
      tier: 'live',
      models: [{
        platform: 'groq',
        modelId: 'unknown-tag-model',
        displayName: 'Unknown Tag Model',
        intelligenceRank: 1,
        speedRank: 1,
        sizeLabel: 'Small',
        limits: { rpm: 1, rpd: 1, tpm: 1, tpd: 1 },
        monthlyTokenBudget: '0',
        contextWindow: 1024,
        enabled: true,
        supportsVision: false,
        supportsTools: false,
        taskTags: ['magic-capability'],
      }],
      quirks: [],
    });
    expect(problems).toContain('models[0] taskTags contains an unknown or non-string tag');
  });

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CATALOG_BASE_URL;
    delete process.env.CATALOG_PUBKEY;
    setSetting(SETTING_LICENSE_KEY, '');
  });

  it('rejects an unsigned catalog and preserves the last applied version', async () => {
    process.env.CATALOG_BASE_URL = 'https://catalog.test';
    setSetting('catalog_applied_version', '2026.10.01');
    setSetting('catalog_applied_tier', 'monthly');

    const payload = {
      version: '2099.01.01',
      generatedAt: new Date().toISOString(),
      tier: 'live',
      models: [{
        platform: 'groq',
        modelId: 'unsigned-catalog-model',
        displayName: 'Unsigned Catalog Model',
        intelligenceRank: 1,
        speedRank: 1,
        sizeLabel: 'Small',
        limits: { rpm: 1, rpd: 1, tpm: 1, tpd: 1 },
        monthlyTokenBudget: null,
        contextWindow: 1024,
        enabled: true,
        supportsVision: false,
        supportsTools: false,
      }],
      quirks: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await syncCatalog(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, action: 'error' });
    expect((result as { detail?: string }).detail).toContain('missing signature');
    expect(getSetting('catalog_applied_version')).toBe('2026.10.01');
    expect(getSetting('catalog_applied_tier')).toBe('monthly');
    expect(
      getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE model_id = 'unsigned-catalog-model'").get(),
    ).toEqual({ n: 0 });
  });

  it('accepts a correctly signed catalog from the configured trusted key', async () => {
    process.env.CATALOG_BASE_URL = 'https://catalog.test';
    setSetting('catalog_applied_version', '2026.10.01');
    setSetting('catalog_applied_tier', 'monthly');

    const crypto = await import('node:crypto');
    const trusted = crypto.generateKeyPairSync('ed25519');
    process.env.CATALOG_PUBKEY = trusted.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const payload = {
      version: '2099.01.01',
      generatedAt: new Date().toISOString(),
      tier: 'live',
      models: [{
        platform: 'groq',
        modelId: 'trusted-signature-model',
        displayName: 'Trusted Signature Model',
        intelligenceRank: 1,
        speedRank: 1,
        sizeLabel: 'Small',
        limits: { rpm: 1, rpd: 1, tpm: 1, tpd: 1 },
        monthlyTokenBudget: '0',
        contextWindow: 1024,
        enabled: true,
        supportsVision: false,
        supportsTools: false,
        taskTags: ['coding', 'reasoning'],
      }],
      quirks: [],
    };
    const bytes = Buffer.from(JSON.stringify(payload));
    const signature = crypto.sign(null, bytes, trusted.privateKey).toString('base64');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-catalog-signature': signature },
    })));

    const result = await syncCatalog(true);

    expect(result).toMatchObject({ ok: true, action: 'applied', version: '2099.01.01' });
    expect(getSetting('catalog_applied_version')).toBe('2099.01.01');
    expect(getSetting('catalog_applied_tier')).toBe('live');
    expect(
      getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE model_id = 'trusted-signature-model'").get(),
    ).toEqual({ n: 1 });
    expect(
      getDb().prepare("SELECT task_tags_json FROM models WHERE model_id = 'trusted-signature-model'").get(),
    ).toEqual({ task_tags_json: '[\"coding\",\"reasoning\"]' });
  });

  it('rejects a catalog signed by an untrusted key and preserves the applied catalog', async () => {
    process.env.CATALOG_BASE_URL = 'https://catalog.test';
    setSetting('catalog_applied_version', '2026.10.01');
    setSetting('catalog_applied_tier', 'monthly');

    const trusted = (await import('node:crypto')).generateKeyPairSync('ed25519');
    const attacker = (await import('node:crypto')).generateKeyPairSync('ed25519');
    process.env.CATALOG_PUBKEY = trusted.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const payload = {
      version: '2099.01.01',
      generatedAt: new Date().toISOString(),
      tier: 'live',
      models: [{
        platform: 'groq',
        modelId: 'untrusted-signature-model',
        displayName: 'Untrusted Signature Model',
        intelligenceRank: 1,
        speedRank: 1,
        sizeLabel: 'Small',
        limits: { rpm: 1, rpd: 1, tpm: 1, tpd: 1 },
        monthlyTokenBudget: null,
        contextWindow: 1024,
        enabled: true,
        supportsVision: false,
        supportsTools: false,
      }],
      quirks: [],
    };
    const bytes = Buffer.from(JSON.stringify(payload));
    const signature = (await import('node:crypto')).sign(null, bytes, attacker.privateKey).toString('base64');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-catalog-signature': signature },
    })));

    const result = await syncCatalog(true);

    expect(result).toMatchObject({ ok: false, action: 'error' });
    expect((result as { detail?: string }).detail).toContain('signature verification FAILED');
    expect(getSetting('catalog_applied_version')).toBe('2026.10.01');
    expect(getSetting('catalog_applied_tier')).toBe('monthly');
    expect(
      getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE model_id = 'untrusted-signature-model'").get(),
    ).toEqual({ n: 0 });
  });

  it('does not apply a catalog when the network request fails', async () => {
    process.env.CATALOG_BASE_URL = 'https://catalog.test';
    setSetting('catalog_applied_version', '2026.10.01');
    setSetting('catalog_applied_tier', 'monthly');

    const fetchMock = vi.fn().mockRejectedValue(new Error('simulated network outage'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await syncCatalog(true);

    expect(result).toMatchObject({ ok: false, action: 'error' });
    expect((result as { detail?: string }).detail).toContain('simulated network outage');
    expect(getSetting('catalog_applied_version')).toBe('2026.10.01');
    expect(getSetting('catalog_applied_tier')).toBe('monthly');
  });
});
