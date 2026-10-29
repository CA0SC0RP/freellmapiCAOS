// Generative-media routing (image, video, and audio/TTS).
//
// Self-contained, exactly like embeddings: media models live in their OWN
// `media_models` table so they can NEVER enter the chat router's candidate pool
// (a chat request can't misroute to an image model) and never pollute the chat
// token budget. Each platform has a small adapter here; routing fails over
// across the providers serving the same modality. The rows are maintained in the
// published catalog and arrive via catalog-sync (premium on the live tier within
// ~12h, free once each model is 30 days old) — never seeded by migrations.
import { getDb } from '../db/index.js';
import { parseRetryAfterMs } from '../providers/base.js';
import { RetryHintTracker } from '../lib/retry-hint.js';
import { secondsUntilNextMonth } from './key-budget.js';
import { noteBudgetAlerts } from './budget-alerts.js';
import { getClientContext } from '../lib/client-context.js';
import { reserveProviderCredential } from './provider-credential.js';
import { pinnedExternalProviderFetch, proxyFetch } from '../lib/proxy.js';
import { bearerAuthHeader } from '../lib/credential.js';
import { isOnCooldown, setCooldown } from './ratelimit.js';
import { markKeyHealthyFromRequest } from './health.js';
import { readProviderResponseBytes, readProviderResponseJson, readProviderResponseText } from '../providers/response-body.js';
import { SPEECHIFY_BASE_URL, SPEECHIFY_VERSION } from '../providers/speechify.js';
import { TYPHOON_BASE_URL } from '../providers/typhoon.js';
import { ELECTRONHUB_BASE_URL } from '../providers/electronhub.js';
import { FREEAI_BASE_URL, freeAiAudioUrl } from '../providers/freeai.js';
import { KENARI_BASE_URL, requireKenariFreeModel } from '../providers/kenari.js';
import { PLUGSKY_BASE_URL } from '../providers/plugsky.js';

/** Platforms with a media adapter below. catalog-sync gates media rows on this
 *  (decoupled from the chat provider registry — e.g. SiliconFlow is media-only). */
export const MEDIA_PLATFORMS = new Set(['nvidia', 'pollinations', 'cloudflare', 'siliconflow', 'google', 'speechify', 'electronhub', 'freeai', 'kenari', 'plugsky']);

/** Video uses a dedicated optional catalog registry so binaries that predate
 *  this modality ignore the rows instead of accidentally ingesting them as
 *  chat models. Keep its adapter allowlist separate for the same reason. */
export const VIDEO_PLATFORMS = new Set(['pollinations', 'huggingface']);

/** Platforms whose free media path needs no API key (anonymous). */
const KEYLESS_CAPABLE = new Set(['pollinations']);

/** Platforms with a speech-to-text adapter below. catalog-sync gates the
 *  catalog's `transcriptionModels` entries on this, the way MEDIA_PLATFORMS
 *  gates the generative-media rows. */
export const TRANSCRIPTION_PLATFORMS = new Set(['groq', 'cloudflare', 'typhoon', 'mistral']);

// 'transcription' rows live in media_models like the other modalities; they
// arrive via the catalog's dedicated `transcriptionModels` array (see
// catalog-sync), never via migrations. Their per-model adapter metadata
// (native subtitle formats, upload ceiling, request flavor) rides in the
// meta_json column — see TranscriptionMeta below.
export type MediaModality = 'image' | 'video' | 'audio' | 'transcription';

export interface MediaModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  modality: MediaModality;
  priority: number;
  enabled: number;
  quota_label: string;
  key_id: number | null;
  meta_json: string | null;
}

export class MediaError extends Error {
  status: number;
  /** Optional machine-readable error code surfaced in the OpenAI-shaped body. */
  code?: string;
  /** Back-off the upstream provider stated (`Retry-After` header), in
   *  milliseconds — relayed to the client so an SDK sleeps the stated amount
   *  instead of hammering the chain, mirroring the embeddings path. */
  retryAfterMs?: number;
  constructor(message: string, status: number, code?: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ImageResult {
  platform: string;
  modelId: string;
  images: Array<{ b64_json?: string; url?: string }>;
}
export interface SpeechResult {
  platform: string;
  modelId: string;
  audio: Buffer;
  contentType: string;
}
export interface VideoResult {
  platform: string;
  modelId: string;
  video: Buffer;
  contentType: string;
}
export interface ImageParams { prompt: string; n?: number; size?: string; signal?: AbortSignal }

type MediaCapacity = 'image' | 'video' | 'transcription' | 'audio';

const activeMediaRequests: Record<MediaCapacity, number> = {
  image: 0,
  video: 0,
  transcription: 0,
  audio: 0,
};

let activeMediaTotal = 0;

let activeTranscriptionUploads = 0;

/** Reserve memory capacity before Multer buffers a transcription upload. */
export function acquireTranscriptionUploadSlot(): (() => void) | null {
  const limit = mediaConcurrencyLimit('MEDIA_MAX_CONCURRENT_TRANSCRIPTION_UPLOADS', 2);
  if (activeTranscriptionUploads >= limit) return null;
  activeTranscriptionUploads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeTranscriptionUploads -= 1;
  };
}

function mediaConcurrencyLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 128) return fallback;
  return parsed;
}

/**
 * Process-local admission control for memory-heavy media operations.
 * Requests are rejected immediately instead of accumulating in an unbounded
 * queue; every successful acquisition is released even on errors/abort.
 */
async function withMediaCapacity<T>(modality: MediaCapacity, operation: () => Promise<T>): Promise<T> {
  const globalLimit = mediaConcurrencyLimit('MEDIA_MAX_CONCURRENT', 4);
  const modalityLimit = mediaConcurrencyLimit(
    `MEDIA_MAX_CONCURRENT_${modality.toUpperCase()}`,
    modality === 'video' ? 1 : 2,
  );

  if (activeMediaTotal >= globalLimit || activeMediaRequests[modality] >= modalityLimit) {
    throw new MediaError(
      'Media capacity is temporarily full; retry shortly',
      503,
      'media_concurrency_limit',
      1000,
    );
  }

  activeMediaTotal += 1;
  activeMediaRequests[modality] += 1;
  try {
    return await operation();
  } finally {
    activeMediaTotal -= 1;
    activeMediaRequests[modality] -= 1;
  }
}

export interface SpeechParams { input: string; voice?: string; format?: string; signal?: AbortSignal }
export interface VideoParams {
  prompt: string;
  duration?: number;
  aspectRatio?: '16:9' | '9:16';
  image?: string;
  seed?: number;
  audio?: boolean;
}

// OpenAI clients commonly send one of these voice names even when the user did
// not choose a voice explicitly. Native TTS providers use unrelated voice
// vocabularies, so forwarding the value verbatim makes an otherwise ordinary
// OpenAI request fail. Keep the translation here, at the provider boundary;
// custom OpenAI-compatible endpoints still receive the caller's value as-is.
// Pollinations' openai-audio route exposes the original OpenAI TTS vocabulary.
const POLLINATIONS_VOICES = new Set([
  'alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer',
]);

const SILICONFLOW_NATIVE_VOICES = new Set([
  'alex', 'anna', 'bella', 'benjamin', 'charles', 'claire', 'david', 'diana',
]);

const SILICONFLOW_OPENAI_VOICE_MAP: Record<string, string> = {
  alloy: 'alex',
  ash: 'claire',
  ballad: 'diana',
  coral: 'bella',
  echo: 'benjamin',
  fable: 'charles',
  nova: 'anna',
  onyx: 'david',
  sage: 'benjamin',
  shimmer: 'bella',
  verse: 'charles',
  marin: 'anna',
  cedar: 'david',
};

const GEMINI_NATIVE_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
] as const;

const GEMINI_NATIVE_VOICE_LOOKUP = new Map(
  GEMINI_NATIVE_VOICES.map(voice => [voice.toLowerCase(), voice]),
);

const GEMINI_OPENAI_VOICE_MAP: Record<string, string> = {
  alloy: 'Schedar',       // even
  ash: 'Charon',          // informative
  ballad: 'Enceladus',    // breathy
  coral: 'Sulafat',       // warm
  echo: 'Iapetus',        // clear
  fable: 'Puck',          // upbeat
  nova: 'Zephyr',         // bright
  onyx: 'Gacrux',         // mature
  sage: 'Sadaltager',     // knowledgeable
  shimmer: 'Achernar',    // soft
  verse: 'Laomedeia',     // upbeat
  marin: 'Aoede',         // breezy
  cedar: 'Kore',          // firm
};

function normalizedVoice(voice?: string): string | undefined {
  const value = voice?.trim().toLowerCase();
  return value || undefined;
}

function siliconFlowVoice(modelId: string, requested?: string): string {
  const raw = requested?.trim();
  const prefix = `${modelId}:`;
  const qualifiedNative = raw?.startsWith(prefix)
    ? normalizedVoice(raw.slice(prefix.length))
    : undefined;
  const name = qualifiedNative && SILICONFLOW_NATIVE_VOICES.has(qualifiedNative)
    ? qualifiedNative
    : normalizedVoice(raw);
  const native = name && SILICONFLOW_NATIVE_VOICES.has(name) ? name : undefined;
  const mapped = name ? SILICONFLOW_OPENAI_VOICE_MAP[name] : undefined;
  return `${modelId}:${native ?? mapped ?? 'alex'}`;
}

function pollinationsVoice(requested?: string): string {
  const voice = normalizedVoice(requested);
  return voice && POLLINATIONS_VOICES.has(voice) ? voice : 'alloy';
}

function geminiVoice(requested?: string): string {
  const voice = normalizedVoice(requested);
  if (!voice) return 'Kore';
  return GEMINI_NATIVE_VOICE_LOOKUP.get(voice)
    ?? GEMINI_OPENAI_VOICE_MAP[voice]
    ?? 'Kore';
}

// Media generations are slower than chat — a cold FLUX/SDXL run can take 30-60s.
const FETCH_TIMEOUT_MS = 60_000;
// Media payloads are larger than chat JSON, but still need hard upstream caps.
const MAX_IMAGE_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_AUDIO_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_VIDEO_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Create a Buffer view over already-bounded bytes without copying large media payloads. */
function bufferView(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}
// Video providers submit long-running jobs and can legitimately need several
// minutes before the MP4 is ready. This is still bounded end-to-end.
const VIDEO_FETCH_TIMEOUT_MS = 5 * 60_000;

/** Bail out of a long-running media job whose API caller has hung up. Video is
 *  the only surface here that can poll for minutes, so without this a client
 *  that disconnects after two seconds still costs a full generation — and a
 *  second one, when the chain fails over to the next provider. */
function throwIfClientGone(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaError('client closed the request', 499);
}

export function listMediaModels(modality: MediaModality): MediaModelRow[] {
  return getDb()
    .prepare('SELECT * FROM media_models WHERE modality = ? AND enabled = 1 ORDER BY priority, id')
    .all(modality) as MediaModelRow[];
}

/** All media models (every media modality, including disabled) for the
 *  dashboard. Search engines and decision models share the table (modality
 *  'search' / 'decision') but have their own pages and APIs, so they are left
 *  out here. */
export function listAllMediaModels(): MediaModelRow[] {
  return getDb()
    .prepare("SELECT * FROM media_models WHERE modality NOT IN ('search', 'decision') ORDER BY modality, priority, id")
    .all() as MediaModelRow[];
}

interface ProviderCredential {
  release?: () => void;
  id: number | null;
  key: string | null;
  baseUrl: string | null;
}

async function mediaFetch(
  url: string,
  platform: string,
  modality: MediaModality,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
  /** The caller's own cancellation (a disconnected API client), folded in on
   *  top of the per-request timeout so a departed client drops the upstream
   *  request instead of leaving it to run out the clock. */
  clientSignal?: AbortSignal,
  /** Pin provider-supplied download URLs to a vetted public DNS answer set. */
  pinPublicDestination = false,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = clientSignal ? AbortSignal.any([timeoutSignal, clientSignal]) : timeoutSignal;
  const fetcher = pinPublicDestination ? pinnedExternalProviderFetch : proxyFetch;
  const r = await fetcher(
    url,
    { ...init, signal },
    platform,
    modality,
    timeoutMs,
  );
  if (!r.ok) {
    const body = await readProviderResponseText(r).catch(() => '');
    throw new MediaError(
      `${platform} ${r.status}: ${body.slice(0, 200)}`,
      r.status,
      undefined,
      parseRetryAfterMs(r.headers?.get('retry-after') ?? null),
    );
  }
  return r;
}

function parseSize(size?: string): [number, number] {
  if (size && /^\d+x\d+$/.test(size)) {
    const [w, h] = size.split('x').map(Number);
    return [w, h];
  }
  return [1024, 1024];
}

function parseCfKey(key: string | null): { accountId: string; token: string } {
  if (!key) throw new MediaError('cloudflare key required (account_id:token)', 401);
  const sep = key.indexOf(':');
  if (sep === -1) throw new MediaError('cloudflare key is not in account_id:token form', 500);
  return { accountId: key.slice(0, sep), token: key.slice(sep + 1) };
}

/** Adapter request flavor for a generative media row, read from meta_json.
 *  One platform can host several deployment styles: Cloudflare takes a JSON
 *  body for most image models but multipart/form-data for the FLUX.2 family.
 *  Absent meta = the platform's default style, so old rows are untouched. */
function mediaRequestStyle(row: MediaModelRow): string | null {
  if (!row.meta_json) return null;
  try {
    const parsed = JSON.parse(row.meta_json) as { requestStyle?: unknown };
    return typeof parsed?.requestStyle === 'string' ? parsed.requestStyle : null;
  } catch {
    return null;
  }
}

interface VideoMeta {
  /** Provider-native deployment id. Hugging Face model ids are mapped to fal
   *  queue ids in the catalog so runtime calls need no mutable discovery step. */
  providerModelId?: string;
}

function videoMeta(row: MediaModelRow): VideoMeta {
  if (!row.meta_json) return {};
  try {
    const parsed = JSON.parse(row.meta_json) as VideoMeta;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function contentTypeFor(fmt: string): string {
  switch (fmt) {
    case 'wav': return 'audio/wav';
    case 'opus': return 'audio/ogg';
    case 'aac': return 'audio/aac';
    case 'flac': return 'audio/flac';
    case 'pcm': return 'audio/L16';
    case 'mp3':
    default: return 'audio/mpeg';
  }
}

function parseRate(mime?: string): number | undefined {
  const m = mime?.match(/rate=(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** Wrap raw 16-bit mono PCM (what Gemini TTS returns) in a WAV header so any
 *  client can play it without knowing the sample rate out of band. */
function wrapPcmAsWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function callImageProvider(
  row: MediaModelRow,
  credential: ProviderCredential,
  p: ImageParams,
): Promise<Array<{ b64_json?: string; url?: string }>> {
  const key = credential.key;
  const fetchForClient = (url: string, platform: string, modality: MediaModality, init: RequestInit) =>
    mediaFetch(url, platform, modality, init, FETCH_TIMEOUT_MS, p.signal);
  const [w, h] = parseSize(p.size);
  switch (row.platform) {
    case 'plugsky': {
      // Both routes share the monthly image allowance. dall-e-3 is Plugsky's
      // compatibility alias for FLUX Dev, NOT OpenAI DALL-E (catalog label).
      if (!['plugsky-flux', 'dall-e-3'].includes(row.model_id)) {
        throw new MediaError('Plugsky requires a verified free image route', 400);
      }
      const r = await fetchForClient(`${PLUGSKY_BASE_URL}/images/generations`, 'plugsky', 'image', {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...bearerAuthHeader(key) },
        body: JSON.stringify({ model: row.model_id, prompt: p.prompt, n: p.n ?? 1,
          ...(p.size ? { size: p.size } : {}), response_format: 'b64_json' }),
      });
      const j = await readProviderResponseJson(r, MAX_IMAGE_RESPONSE_BYTES) as { data?: { b64_json?: unknown }[]; error?: unknown } | null;
      if (j?.error || !Array.isArray(j?.data) || !j.data.length ||
          j.data.some(i => !i || typeof i.b64_json !== 'string' || !i.b64_json.trim())) {
        throw new MediaError('plugsky returned no image data', 502);
      }
      return j.data.map(i => ({ b64_json: i.b64_json as string }));
    }
    case 'kenari': {
      requireKenariFreeModel(row.model_id);
      const r = await fetchForClient(`${KENARI_BASE_URL}/images/generations`, 'kenari', 'image', {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...bearerAuthHeader(key) },
        body: JSON.stringify({ model: row.model_id, prompt: p.prompt, n: p.n ?? 1,
          size: p.size ?? '1024x1024', response_format: 'b64_json' }),
      });
      const j = await readProviderResponseJson(r, MAX_IMAGE_RESPONSE_BYTES) as { data?: { b64_json?: unknown }[]; error?: unknown } | null;
      if (j?.error || !Array.isArray(j?.data) || !j.data.length ||
          j.data.some(i => !i || typeof i.b64_json !== 'string' || !i.b64_json.trim())) {
        throw new MediaError('kenari returned no image data', 502);
      }
      return j.data.map(i => ({ b64_json: i.b64_json as string }));
    }
    case 'custom': {
      if (!credential.baseUrl) throw new MediaError('custom image provider is missing base_url', 500);
      const body: Record<string, unknown> = { model: row.model_id, prompt: p.prompt };
      if (p.n !== undefined) body.n = p.n;
      if (p.size) body.size = p.size;
      const r = await fetchForClient(`${credential.baseUrl}/images/generations`, 'custom', 'image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearerAuthHeader(key) },
        body: JSON.stringify(body),
      });
      const j = (await readProviderResponseJson(r, MAX_IMAGE_RESPONSE_BYTES)) as { data?: { b64_json?: string; url?: string }[] };
      return (j.data ?? []).map(i => ({ b64_json: i.b64_json, url: i.url }));
    }
    case 'nvidia': {
      // NVIDIA NIM image models live at ai.api.nvidia.com/v1/genai/{model};
      // response is { artifacts: [{ base64 }] }. The hosted FLUX deployments
      // do not share one request schema: FLUX.1 Dev rejects the four-step
      // defaults used by Schnell, while FLUX.2 Klein rejects `mode` and
      // guidance fields entirely.
      let body: Record<string, unknown>;
      switch (row.model_id) {
        case 'black-forest-labs/flux.1-dev':
          body = {
            prompt: p.prompt,
            mode: 'base',
            steps: 28,
            width: 1024,
            height: 1024,
            cfg_scale: 3.5,
          };
          break;
        case 'black-forest-labs/flux.2-klein-4b':
          body = { prompt: p.prompt, steps: 4, width: 1024, height: 1024 };
          break;
        default:
          body = { prompt: p.prompt, mode: 'base', steps: 4, width: w, height: h };
      }
      const r = await fetchForClient(`https://ai.api.nvidia.com/v1/genai/${row.model_id}`, 'nvidia', 'image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      const j = (await readProviderResponseJson(r, MAX_IMAGE_RESPONSE_BYTES)) as { artifacts?: { base64?: string }[] };
      return (j.artifacts ?? []).map(a => ({ b64_json: a.base64 }));
    }
    case 'pollinations': {
      // Keyless GET image endpoint returns raw image bytes.
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(p.prompt)}?width=${w}&height=${h}&nologo=true&model=${encodeURIComponent(row.model_id)}`;
      const r = await fetchForClient(url, 'pollinations', 'image', { method: 'GET' });
      const buf = bufferView(await readProviderResponseBytes(r, MAX_IMAGE_RESPONSE_BYTES));
      return [{ b64_json: buf.toString('base64') }];
    }
    case 'cloudflare': {
      const { accountId, token } = parseCfKey(key);
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${row.model_id}`;
      // Most CF image models take a JSON body. The FLUX.2 family declares a
      // multipart input schema and rejects JSON outright ("required properties
      // at '/' are 'multipart'"), so those rows opt in through catalog meta.
      let init: RequestInit;
      if (mediaRequestStyle(row) === 'multipart') {
        // Never set Content-Type by hand — FormData supplies the boundary.
        const form = new FormData();
        form.append('prompt', p.prompt);
        form.append('width', String(w));
        form.append('height', String(h));
        init = { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form };
      } else {
        // Cloudflare's FLUX.1 Schnell schema is prompt-only; dimensions that
        // the other JSON image models accept are rejected as extra fields.
        const body = row.model_id === '@cf/black-forest-labs/flux-1-schnell'
          ? { prompt: p.prompt }
          : { prompt: p.prompt, width: w, height: h };
        init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        };
      }
      const r = await fetchForClient(url, 'cloudflare', 'image', init);
      // FLUX returns JSON { result: { image: <b64> } }; SDXL returns raw PNG bytes.
      const ct = r.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const j = (await readProviderResponseJson(r, MAX_IMAGE_RESPONSE_BYTES)) as { result?: { image?: string } };
        const b64 = j.result?.image;
        if (!b64) throw new MediaError('cloudflare returned no image', 502);
        return [{ b64_json: b64 }];
      }
      const buf = bufferView(await readProviderResponseBytes(r, MAX_IMAGE_RESPONSE_BYTES));
      return [{ b64_json: buf.toString('base64') }];
    }
    case 'siliconflow': {
      const r = await fetchForClient('https://api.siliconflow.com/v1/images/generations', 'siliconflow', 'image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: row.model_id, prompt: p.prompt, image_size: `${w}x${h}` }),
      });
      const j = (await readProviderResponseJson(r, MAX_IMAGE_RESPONSE_BYTES)) as { images?: { url?: string }[]; data?: { url?: string }[] };
      return (j.images ?? j.data ?? []).map(i => ({ url: i.url }));
    }
    default:
      throw new MediaError(`no image adapter for platform '${row.platform}'`, 500);
  }
}

async function callHuggingFaceVideo(
  row: MediaModelRow,
  key: string | null,
  p: VideoParams,
  clientSignal?: AbortSignal,
): Promise<{ video: Buffer; contentType: string }> {
  if (!key) throw new MediaError('huggingface key required', 401);
  const providerModelId = videoMeta(row).providerModelId;
  if (!providerModelId) {
    throw new MediaError(`huggingface video model '${row.model_id}' is missing providerModelId metadata`, 500);
  }

  const deadline = Date.now() + VIDEO_FETCH_TIMEOUT_MS;
  const remaining = () => Math.max(1, deadline - Date.now());
  const query = '?_subdomain=queue';
  const queueUrl = `https://router.huggingface.co/fal-ai/${providerModelId}${query}`;
  const submitted = await mediaFetch(queueUrl, 'huggingface', 'video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      prompt: p.prompt,
      ...(p.seed !== undefined ? { seed: p.seed } : {}),
    }),
  }, remaining(), clientSignal);
  const queue = (await readProviderResponseJson(submitted)) as {
    request_id?: string;
    status?: string;
    response_url?: string;
  };
  if (!queue.request_id || !queue.response_url) {
    throw new MediaError('huggingface returned no video job id', 502);
  }

  // Validate upstream job metadata before using it to build authenticated poll URLs.
  let responsePath: string;
  try {
    const responseUrl = new URL(queue.response_url);
    const modelPath = providerModelId.startsWith('fal-ai/')
      ? providerModelId.slice('fal-ai/'.length)
      : providerModelId;
    if (
      responseUrl.protocol !== 'https:' ||
      responseUrl.hostname !== 'queue.fal.run' ||
      responseUrl.port !== '' ||
      responseUrl.username !== '' ||
      responseUrl.password !== '' ||
      responseUrl.search !== '' ||
      responseUrl.hash !== '' ||
      !/^[A-Za-z0-9_-]+$/.test(queue.request_id) ||
      responseUrl.pathname !== `/fal-ai/${modelPath}/requests/${queue.request_id}`
    ) {
      throw new Error('unexpected queue URL');
    }
    responsePath = responseUrl.pathname;
  } catch {
    throw new MediaError('huggingface returned an invalid video job URL', 502);
  }
  const routedJobUrl = `https://router.huggingface.co/fal-ai${responsePath}`;
  let status = queue.status ?? 'IN_QUEUE';
  while (status !== 'COMPLETED') {
    if (status === 'FAILED' || status === 'CANCELLED') {
      throw new MediaError(`huggingface video job ${status.toLowerCase()}`, 502);
    }
    if (remaining() <= 1) throw new MediaError('huggingface video generation timed out', 504);
    throwIfClientGone(clientSignal);
    await new Promise(resolve => setTimeout(resolve, 500));
    const polled = await mediaFetch(`${routedJobUrl}/status${query}`, 'huggingface', 'video', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    }, remaining(), clientSignal);
    const state = (await readProviderResponseJson(polled)) as { status?: string; error?: string };
    if (!state.status) throw new MediaError('huggingface returned an invalid video job status', 502);
    status = state.status;
  }

  const completed = await mediaFetch(`${routedJobUrl}${query}`, 'huggingface', 'video', {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  }, remaining(), clientSignal);
  const result = (await readProviderResponseJson(completed)) as { video?: { url?: string; content_type?: string } };
  const videoUrl = result.video?.url;
  if (!videoUrl) throw new MediaError('huggingface returned no video URL', 502);
  // This URL is supplied by an upstream response, so fetch it only over HTTPS,
  // reject private destinations and redirects, and pin the socket to the vetted
  // public DNS answer set to prevent a DNS-rebinding gap.
  const downloaded = await mediaFetch(
    videoUrl, 'huggingface', 'video', { method: 'GET' }, remaining(), clientSignal, true,
  );
  const video = bufferView(await readProviderResponseBytes(downloaded, MAX_VIDEO_RESPONSE_BYTES));
  return {
    video,
    contentType: downloaded.headers.get('content-type') ?? result.video?.content_type ?? 'video/mp4',
  };
}

async function callVideoProvider(
  row: MediaModelRow,
  credential: ProviderCredential,
  p: VideoParams,
  clientSignal?: AbortSignal,
): Promise<{ video: Buffer; contentType: string }> {
  const key = credential.key;
  switch (row.platform) {
    case 'pollinations': {
      if (!key) throw new MediaError('pollinations key required', 401);
      // Every Pollinations video model advertises its own allowed durations
      // (nova-reel 6-120 in steps of 6, veo 4/6/8, minimax-h3 exactly 5,
      // wan 5/10/15, seedance-2.5 exactly 4...). There is no length that is
      // valid everywhere, so an omitted `duration` is left off the query and
      // the provider applies the model's own default instead of a guess that
      // would 400 on most of the roster.
      const duration = p.duration;
      if (duration !== undefined && row.model_id === 'nova-reel'
          && (duration < 6 || duration > 120 || duration % 6 !== 0)) {
        throw new MediaError('nova-reel duration must be a multiple of 6 between 6 and 120 seconds', 400);
      }
      const params = new URLSearchParams({ model: row.model_id });
      if (duration !== undefined) params.set('duration', String(duration));
      if (p.aspectRatio) params.set('aspectRatio', p.aspectRatio);
      if (p.image) params.set('image', p.image);
      if (p.seed !== undefined) params.set('seed', String(p.seed));
      if (p.audio !== undefined) params.set('audio', String(p.audio));
      const r = await mediaFetch(
        `https://gen.pollinations.ai/video/${encodeURIComponent(p.prompt)}?${params}`,
        'pollinations',
        'video',
        { method: 'GET', headers: { Authorization: `Bearer ${key}` } },
        VIDEO_FETCH_TIMEOUT_MS,
        clientSignal,
      );
      return {
        video: bufferView(await readProviderResponseBytes(r, MAX_VIDEO_RESPONSE_BYTES)),
        contentType: r.headers.get('content-type') ?? 'video/mp4',
      };
    }
    case 'huggingface':
      return callHuggingFaceVideo(row, key, p, clientSignal);
    default:
      throw new MediaError(`no video adapter for platform '${row.platform}'`, 500);
  }
}

async function callSpeechProvider(
  row: MediaModelRow,
  credential: ProviderCredential,
  p: SpeechParams,
): Promise<{ audio: Buffer; contentType: string }> {
  const key = credential.key;
  const fetchForClient = (url: string, platform: string, modality: MediaModality, init: RequestInit) =>
    mediaFetch(url, platform, modality, init, FETCH_TIMEOUT_MS, p.signal);
  switch (row.platform) {
    case 'freeai': {
      if (!key) throw new MediaError('Free.ai API key required', 401);
      if (row.model_id !== 'kokoro') throw new MediaError('Free.ai currently supports only the tested Kokoro speech route', 400);
      if (p.format && p.format !== 'wav') throw new MediaError('Free.ai Kokoro supports wav output through this adapter', 400);
      const standardVoices = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
      const voice = !p.voice || standardVoices.has(p.voice.toLowerCase()) ? 'af_heart' : p.voice;
      const r = await fetchForClient(`${FREEAI_BASE_URL}/v1/tts/`, 'freeai', 'audio', {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...bearerAuthHeader(key) },
        body: JSON.stringify({ model: row.model_id, text: p.input, voice }),
      });
      const body: unknown = await readProviderResponseJson(r, MAX_AUDIO_RESPONSE_BYTES);
      if (body && typeof body === 'object' && 'queued' in body && body.queued === true) {
        // The website uses session-based polling for queued jobs; its
        // API status endpoint did not expose our tested job. Never follow an
        // arbitrary poll_url or submit the same generation again automatically.
        throw new MediaError('Free.ai queued this speech job; audio is not yet available. Check the Free.ai account history before retrying.', 502, 'upstream_queued');
      }
      const url = freeAiAudioUrl(body);
      if (!url) throw new MediaError('Free.ai returned a missing or unsafe audio URL', 502);
      // Output is public on the same fixed host. Never forward the credential,
      // follow redirects or download arbitrary URLs supplied by an upstream.
      const output = await fetchForClient(url, 'freeai', 'audio', { method: 'GET', redirect: 'error' });
      const maxBytes = 20 * 1024 * 1024;
      if (!output.body) {
        throw new MediaError('Free.ai speech output is missing', 502);
      }
      // Use the shared bounded reader so a failed stream is cancelled and the
      // response is not retained twice as per-chunk Buffers plus Buffer.concat.
      let audio: Buffer;
      try {
        audio = bufferView(await readProviderResponseBytes(output, maxBytes));
      } catch (error) {
        if (error instanceof Error && /exceeded.*byte limit/.test(error.message)) {
          throw new MediaError('Free.ai speech output is too large', 502);
        }
        throw error;
      }
      if (audio.length <= 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
        throw new MediaError('Free.ai returned no recognized WAV audio', 502);
      }
      return { audio, contentType: 'audio/wav' };
    }
    case 'speechify': {
      const fmt = p.format ?? 'mp3';
      // Speechify exposes ogg, not OpenAI's opus name. Do not silently return
      // a different codec for unsupported formats such as pcm or flac.
      if (!['mp3', 'wav', 'ogg', 'aac'].includes(fmt)) {
        throw new MediaError('Speechify supports mp3, wav, ogg and aac audio formats', 400);
      }
      const standardVoices = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
      const voice = !p.voice || standardVoices.has(p.voice.toLowerCase()) ? 'alec' : p.voice;
      const r = await fetchForClient(`${SPEECHIFY_BASE_URL}/audio/speech`, 'speechify', 'audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Speechify-Version': SPEECHIFY_VERSION },
        body: JSON.stringify({ model: row.model_id, input: p.input, voice_id: voice, audio_format: fmt }),
      });
      const j = await readProviderResponseJson(r, MAX_AUDIO_RESPONSE_BYTES) as { audio_data?: unknown; audio_format?: unknown };
      const b64 = j.audio_data;
      if (typeof b64 !== 'string' || !b64 || b64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) {
        throw new MediaError('Speechify returned missing or invalid base64 audio', 502);
      }
      if (j.audio_format !== fmt) throw new MediaError('Speechify returned a different audio format', 502);
      return { audio: Buffer.from(b64, 'base64'), contentType: fmt === 'ogg' ? 'audio/ogg' : contentTypeFor(fmt) };
    }
    case 'electronhub': {
      // Only the container formats exercised by this adapter are supported.
      // Gemini TTS may return WAV even for response_format=mp3. Detect the
      // actual bytes instead of labelling WAV as MP3 or accepting a JSON error.
      const format = p.format ?? 'mp3';
      if (!['mp3', 'wav'].includes(format)) {
        throw new MediaError('ElectronHub speech supports mp3 and wav output through this adapter', 400);
      }
      const defaultVoice = row.model_id === 'humain-tts' ? 'sara'
        : row.model_id.startsWith('gemini-') ? 'Kore' : 'alloy';
      const voice = !p.voice || p.voice === 'alloy' ? defaultVoice : p.voice;
      const r = await fetchForClient(`${ELECTRONHUB_BASE_URL}/audio/speech`, 'electronhub', 'audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearerAuthHeader(key) },
        body: JSON.stringify({ model: row.model_id, input: p.input, voice, response_format: format }),
      });
      const audio = bufferView(await readProviderResponseBytes(r, MAX_AUDIO_RESPONSE_BYTES));
      const wav = audio.length > 44 && audio.toString('ascii', 0, 4) === 'RIFF'
        && audio.toString('ascii', 8, 12) === 'WAVE';
      const mp3 = audio.length > 10 && (audio.toString('ascii', 0, 3) === 'ID3'
        || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0 && (audio[1] & 0x06) !== 0));
      if (!wav && !mp3) throw new MediaError('ElectronHub returned no recognized speech audio', 502);
      return { audio, contentType: wav ? 'audio/wav' : 'audio/mpeg' };
    }
    case 'custom': {
      if (!credential.baseUrl) throw new MediaError('custom audio provider is missing base_url', 500);
      const fmt = p.format ?? 'mp3';
      const body: Record<string, unknown> = { model: row.model_id, input: p.input };
      if (p.voice) body.voice = p.voice;
      if (p.format) body.response_format = p.format;
      const r = await fetchForClient(`${credential.baseUrl}/audio/speech`, 'custom', 'audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearerAuthHeader(key) },
        body: JSON.stringify(body),
      });
      return {
        audio: bufferView(await readProviderResponseBytes(r, MAX_AUDIO_RESPONSE_BYTES)),
        contentType: r.headers.get('content-type') ?? contentTypeFor(fmt),
      };
    }
    case 'cloudflare': {
      const { accountId, token } = parseCfKey(key);
      const r = await fetchForClient(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${row.model_id}`, 'cloudflare', 'audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // MeloTTS has a language selector, not a voice selector. In particular,
        // OpenAI's default `alloy` must never be sent as `lang`.
        body: JSON.stringify({ prompt: p.input, lang: 'en' }),
      });
      const j = (await readProviderResponseJson(r, MAX_AUDIO_RESPONSE_BYTES)) as { result?: { audio?: string } };
      const b64 = j.result?.audio;
      if (!b64) throw new MediaError('cloudflare returned no audio', 502);
      return { audio: Buffer.from(b64, 'base64'), contentType: 'audio/mpeg' };
    }
    case 'siliconflow': {
      const fmt = p.format ?? 'mp3';
      const r = await fetchForClient('https://api.siliconflow.com/v1/audio/speech', 'siliconflow', 'audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: row.model_id,
          input: p.input,
          voice: siliconFlowVoice(row.model_id, p.voice),
          response_format: fmt,
        }),
      });
      return { audio: bufferView(await readProviderResponseBytes(r, MAX_AUDIO_RESPONSE_BYTES)), contentType: contentTypeFor(fmt) };
    }
    case 'pollinations': {
      // OpenAI-shaped chat-completions with the audio modality returns b64 audio.
      // The anonymous tier needs no key; only send one when it's a real sk_ token.
      const realKey = key && key.startsWith('sk_') ? key : null;
      const r = await fetchForClient('https://gen.pollinations.ai/v1/chat/completions', 'pollinations', 'audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(realKey ? { Authorization: `Bearer ${realKey}` } : {}) },
        body: JSON.stringify({
          model: row.model_id,
          modalities: ['text', 'audio'],
          audio: { voice: pollinationsVoice(p.voice), format: p.format ?? 'mp3' },
          messages: [{ role: 'user', content: p.input }],
        }),
      });
      const j = (await readProviderResponseJson(r, MAX_AUDIO_RESPONSE_BYTES)) as { choices?: { message?: { audio?: { data?: string } } }[] };
      const b64 = j.choices?.[0]?.message?.audio?.data;
      if (!b64) throw new MediaError('pollinations returned no audio', 502);
      return { audio: Buffer.from(b64, 'base64'), contentType: contentTypeFor(p.format ?? 'mp3') };
    }
    case 'google': {
      // Older Gemini TTS returns PCM; newer models return an entire WAV file.
      // Preserve WAV bytes instead of wrapping the container a second time.
      const r = await fetchForClient(
        `https://generativelanguage.googleapis.com/v1beta/models/${row.model_id}:generateContent`,
        'google',
        'audio',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key ?? '' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: p.input }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: geminiVoice(p.voice) } } },
            },
          }),
        },
      );
      const j = (await readProviderResponseJson(r, MAX_AUDIO_RESPONSE_BYTES)) as {
        candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
      };
      const part = j.candidates?.[0]?.content?.parts?.find(pt => pt.inlineData?.data);
      const b64 = part?.inlineData?.data;
      if (!b64) throw new MediaError('gemini returned no audio', 502);
      const audio = Buffer.from(b64, 'base64');
      const isWav = audio.length >= 44 && audio.subarray(0, 4).toString() === 'RIFF' && audio.subarray(8, 12).toString() === 'WAVE';
      if (isWav) return { audio, contentType: 'audio/wav' };
      if (/^audio\/(?:x-)?wav(?:;|$)/i.test(part?.inlineData?.mimeType ?? '')) {
        throw new MediaError('gemini returned malformed WAV audio', 502);
      }
      const rate = parseRate(part?.inlineData?.mimeType) ?? 24000;
      return { audio: wrapPcmAsWav(audio, rate), contentType: 'audio/wav' };
    }
    default:
      throw new MediaError(`no speech adapter for platform '${row.platform}'`, 500);
  }
}

/** Map the request's `model` to a candidate chain within one modality:
 *  'auto'/empty → every enabled provider for the modality (failover order),
 *  a provider model id → just that row. */
function resolveMediaChain(model: string | undefined, modality: MediaModality): MediaModelRow[] {
  const rows = listMediaModels(modality);
  if (rows.length === 0) {
    throw new MediaError(`No enabled ${modality} providers configured.`, 503);
  }
  if (!model || model === 'auto') return rows;
  const matches = rows.filter(r => r.model_id === model);
  if (matches.length === 0) {
    throw new MediaError(`Unknown ${modality} model '${model}'. Use 'auto' or a provider model id.`, 400);
  }
  return matches;
}

function logMedia(row: Pick<MediaModelRow, 'platform' | 'model_id' | 'modality'>, keyId: number | null, status: 'success' | 'error', latencyMs: number, error: string | null): void {
  try {
    const client = getClientContext();
    getDb()
      .prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type, client_ip, client_user_agent, client_agent)
                VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`)
      .run(row.platform, row.model_id, keyId, status, latencyMs, error, row.modality, client.ip, client.userAgent, client.agent);
    // A served media request is evidence the key works, the same as a served
    // chat request (#1493) or a served search (#1612): stamp last_healthy_at
    // and lift an 'unknown'/'error' key out of the pool's cold corner.
    if (status === 'success' && keyId != null) markKeyHealthyFromRequest(keyId);
    // Soft budget alert (#1158 follow-on), same hook as the chat path.
    if (status === 'success' && keyId != null) noteBudgetAlerts(keyId);
  } catch (e) {
    console.error('Failed to log media request:', e);
  }
}

function chainError(modality: MediaModality, lastError: MediaError | null, hints: RetryHintTracker): MediaError {
  // Only statuses the CALLER can act on are passed through. 400 (bad prompt,
  // duration the model does not accept) and 413 (upload too large) describe
  // the caller's own request, and 429 is the long-standing rate-limit signal.
  // An upstream 401 is deliberately NOT among them: it means the operator's
  // provider key was rejected, and forwarding it would tell an OpenAI client
  // its own gateway key is bad — which sends SDKs into a credential error
  // instead of the retryable upstream failure this actually is.
  const status = lastError && [400, 413, 429].includes(lastError.status)
    ? lastError.status
    : 502;
  return new MediaError(
    `All ${modality} providers failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ' (no usable keys)'}.`,
    status,
    lastError?.code,
    // A 429 from one provider is failed over, so its Retry-After is only the
    // client's business when EVERY provider was rate limited with a stated
    // delay — then the soonest one (same rule as the chat exhaustion path).
    status === 429 ? hints.retryAfterMs() : undefined,
  );
}

/** Generate image(s), failing over across providers serving the modality. */
async function runImageGenerationInternal(model: string | undefined, params: ImageParams): Promise<ImageResult> {
  const chain = resolveMediaChain(model, 'image');
  let lastError: MediaError | null = null;
  // Only a chain rate limited end to end earns a Retry-After (the soonest).
  const hints = new RetryHintTracker();
  for (const row of chain) {
    throwIfClientGone(params.signal);
    const { credential, budgetBlocked } = KEYLESS_CAPABLE.has(row.platform)
      ? { credential: { id: null, key: null, baseUrl: null, release: () => {} }, budgetBlocked: false }
      : reserveProviderCredential(row, 0);
    if (!credential) {
      if (budgetBlocked) {
        lastError = new MediaError('Monthly key budget exhausted', 429, 'quota_exceeded');
        hints.record(429, secondsUntilNextMonth() * 1000);
      }
      continue;
    }
    const started = Date.now();
    try {
      const images = await callImageProvider(row, credential, params);
      if (!images.length || images.every(i => !i.b64_json && !i.url)) {
        throw new MediaError('upstream returned no image', 502);
      }
      logMedia(row, credential.id, 'success', Date.now() - started, null);
      return { platform: row.platform, modelId: row.model_id, images };
    } catch (err: any) {
      if (params.signal?.aborted) throw new MediaError('client closed the request', 499);
      const e = err instanceof MediaError ? err : new MediaError(String(err?.message ?? err), 502);
      logMedia(row, credential.id, 'error', Date.now() - started, e.message.slice(0, 300));
      lastError = e;
      hints.record(e.status, e.retryAfterMs);
    } finally {
      credential.release();
    }
  }
  throw chainError('image', lastError, hints);
}

/** Generate a video, failing over across catalogued text-to-video providers.
 *  `clientSignal` is the API caller's connection: when it aborts, the in-flight
 *  upstream request is dropped and no further provider is tried. */
async function runVideoGenerationInternal(
  model: string | undefined,
  params: VideoParams,
  clientSignal?: AbortSignal,
): Promise<VideoResult> {
  const chain = resolveMediaChain(model, 'video');
  let lastError: MediaError | null = null;
  // Only a chain rate limited end to end earns a Retry-After (the soonest).
  const hints = new RetryHintTracker();
  for (const row of chain) {
    throwIfClientGone(clientSignal);
    const { credential, budgetBlocked } = reserveProviderCredential(row, 0,
      keyId => isOnCooldown(row.platform, row.model_id, keyId));
    if (!credential) {
      if (budgetBlocked) {
        lastError = new MediaError('Monthly key budget exhausted', 429, 'quota_exceeded');
        hints.record(429, secondsUntilNextMonth() * 1000);
      }
      continue;
    }
    const started = Date.now();
    try {
      const out = await callVideoProvider(row, credential, params, clientSignal);
      if (!out.video.length) throw new MediaError('upstream returned no video', 502);
      logMedia(row, credential.id, 'success', Date.now() - started, null);
      return { platform: row.platform, modelId: row.model_id, ...out };
    } catch (err: any) {
      const e = err instanceof MediaError ? err : new MediaError(String(err?.message ?? err), 502);
      logMedia(row, credential.id, 'error', Date.now() - started, e.message.slice(0, 300));
      if (e.status === 429 && credential.id != null) setCooldown(row.platform, row.model_id, credential.id);
      lastError = e;
      hints.record(e.status, e.retryAfterMs);
      // A caller that hung up gets no second generation charged to its account.
      throwIfClientGone(clientSignal);
    } finally {
      credential.release();
    }
  }
  throw chainError('video', lastError, hints);
}

// ---------------------------------------------------------------------------
// Speech-to-text (/v1/audio/transcriptions)
//
// STT models live in media_models with modality='transcription', maintained
// by the published catalog's `transcriptionModels` array (see catalog-sync)
// — never hardcoded here, never seeded by migrations. A user can also
// register their own OpenAI-compatible STT endpoint (platform 'custom') from
// the Keys page; those rows are keyed to an api_keys row and are never touched
// by catalog-sync. The per-platform
// adapters below are pure transport; everything model-specific (native
// subtitle support, upload ceiling, request flavor) rides on the catalog
// entry and lands in the row's meta_json. On an install that has never
// synced a catalog listing transcription models, the endpoint returns an
// OpenAI-shaped 503 with code 'no_transcription_models' until the first
// sync lands. Key selection, failover, cooldowns, and request logging reuse
// the exact same machinery as the other media modalities above.

/** Per-model adapter metadata carried on the catalog entry (meta_json). */
export interface TranscriptionMeta {
  /** Subtitle formats the provider returns natively (e.g. ['vtt']). Formats
   *  not produced natively by the chain are refused with 400 at the route. */
  subtitleFormats?: string[];
  /** Provider upload ceiling in bytes; absent = MAX_TRANSCRIPTION_BYTES. */
  maxBytes?: number | null;
  /** Adapter request flavor where one platform hosts more than one deployment
   *  style. Cloudflare: 'json' = JSON body with base64 audio (large-v3-turbo),
   *  'binary' = raw bytes (plain whisper, the default). */
  requestStyle?: string | null;
}

/** Global upload ceiling enforced by the route (multer) so it can reject
 *  early with a clean OpenAI-shaped 413 instead of buffering an upload no
 *  provider can accept. Per-model catalog `maxBytes` may only lower this. */
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

/** A transcription candidate: a media_models row with its meta decoded. */
interface SttCandidate {
  platform: string;
  modelId: string;
  /** The api_keys row this model is bound to, or null to pick any healthy key
   *  for the platform. Custom endpoints ALWAYS carry one: reserveProviderCredential
   *  refuses to guess a key for platform 'custom', so dropping this here would
   *  silently skip every custom STT row. */
  keyId: number | null;
  nativeSubtitles: Set<string>;
  maxBytes: number;
  requestStyle: string | null;
}

function parseTranscriptionMeta(raw: string | null): TranscriptionMeta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as TranscriptionMeta;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function toSttCandidate(row: MediaModelRow): SttCandidate {
  const meta = parseTranscriptionMeta(row.meta_json);
  const maxBytes =
    typeof meta.maxBytes === 'number' && meta.maxBytes > 0
      ? Math.min(meta.maxBytes, MAX_TRANSCRIPTION_BYTES)
      : MAX_TRANSCRIPTION_BYTES;
  return {
    platform: row.platform,
    modelId: row.model_id,
    keyId: row.key_id,
    nativeSubtitles: new Set(Array.isArray(meta.subtitleFormats) ? meta.subtitleFormats : []),
    maxBytes,
    requestStyle: typeof meta.requestStyle === 'string' ? meta.requestStyle : null,
  };
}

/** Model ids that mean "let the router decide". `whisper-1` is what stock
 *  OpenAI clients send by default, so it must route rather than 400. */
const TRANSCRIPTION_AUTO_IDS = new Set(['auto', 'whisper-1']);

export interface TranscriptionParams {
  file: Buffer;
  filename: string;
  mimeType?: string;
  language?: string;
  prompt?: string;
  temperature?: number;
  /** 'json' | 'text' | 'verbose_json' | 'vtt' (srt is rejected at the route). */
  responseFormat: string;
  /** Abort upstream work when the requesting client disconnects. */
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  platform: string;
  modelId: string;
  text: string;
  language?: string;
  duration?: number;
  segments?: unknown[];
  vtt?: string;
}

function resolveTranscriptionChain(model: string | undefined, responseFormat: string): SttCandidate[] {
  let chain = listMediaModels('transcription').map(toSttCandidate);
  if (chain.length === 0) {
    // Never-synced install (or the catalog retired every STT model): the
    // registry only ever arrives via catalog-sync, so tell the caller to wait
    // for / trigger a sync rather than pretending the model id is wrong.
    throw new MediaError(
      'No transcription models are configured yet. The registry arrives via catalog sync; ' +
      'wait for the next sync (or trigger one from the dashboard) and retry, ' +
      'or register your own OpenAI-compatible endpoint from the Keys page.',
      503,
      'no_transcription_models',
    );
  }
  if (model && !TRANSCRIPTION_AUTO_IDS.has(model.toLowerCase())) {
    chain = chain.filter(m => m.modelId === model);
    if (chain.length === 0) {
      throw new MediaError(
        `Unknown transcription model '${model}'. Use 'auto', 'whisper-1', or a provider model id.`,
        400,
      );
    }
  }
  if (responseFormat === 'vtt') {
    chain = chain.filter(m => m.nativeSubtitles.has('vtt'));
    if (chain.length === 0) {
      throw new MediaError(
        "response_format 'vtt' is only served by providers that produce it natively; " +
        'the requested model does not.',
        400,
      );
    }
  }
  return chain;
}

async function callTranscriptionProvider(
  m: SttCandidate,
  credential: ProviderCredential,
  p: TranscriptionParams,
): Promise<Omit<TranscriptionResult, 'platform' | 'modelId'>> {
  const key = credential.key;
  switch (m.platform) {
    case 'mistral': {
      // Voxtral accepts multipart file/model, language and temperature, not
      // Whisper's prompt or response_format. Normalize JSON/text locally.
      const form = new FormData();
      form.append('file', new Blob([p.file], { type: p.mimeType || 'application/octet-stream' }), p.filename);
      form.append('model', m.modelId);
      if (p.language) form.append('language', p.language);
      if (p.temperature !== undefined) form.append('temperature', String(p.temperature));
      const r = await mediaFetch('https://api.mistral.ai/v1/audio/transcriptions', 'mistral', 'transcription', {
        method: 'POST', redirect: 'error', headers: { ...bearerAuthHeader(key) }, body: form,
      }, FETCH_TIMEOUT_MS, p.signal);
      const j = await readProviderResponseJson(r, MAX_TRANSCRIPTION_RESPONSE_BYTES) as { text?: unknown; language?: unknown; segments?: unknown; error?: unknown } | null;
      if (j?.error || typeof j?.text !== 'string') throw new MediaError('mistral returned no transcription text', 502);
      return { text: j.text, language: typeof j.language === 'string' ? j.language : undefined,
        segments: Array.isArray(j.segments) ? j.segments : undefined };
    }
    case 'typhoon': {
      // The tested API accepts file + model and returns {text, usage}.
      // Do not forward Whisper-only options or claim native subtitle support.
      // The route derives text/JSON response formats from this normalized result.
      const form = new FormData();
      form.append('file', new Blob([p.file], { type: p.mimeType || 'application/octet-stream' }), p.filename);
      form.append('model', m.modelId);
      const r = await mediaFetch(`${TYPHOON_BASE_URL}/audio/transcriptions`, 'typhoon', 'transcription', {
        method: 'POST',
        headers: { ...bearerAuthHeader(key) },
        body: form,
      }, FETCH_TIMEOUT_MS, p.signal);
      const j = (await readProviderResponseJson(r, MAX_TRANSCRIPTION_RESPONSE_BYTES)) as { text?: unknown } | null;
      if (!j || typeof j.text !== 'string') throw new MediaError('typhoon returned no transcription text', 502);
      return { text: j.text };
    }
    case 'custom': {
      // Any OpenAI-compatible STT server (faster-whisper-server, LocalAI,
      // whisper.cpp's server, vLLM…). Same multipart shape as groq below;
      // only the base URL and the optional key differ.
      if (!credential.baseUrl) throw new MediaError('custom transcription provider is missing base_url', 500);
      const form = new FormData();
      form.append('file', new Blob([p.file], { type: p.mimeType || 'application/octet-stream' }), p.filename);
      form.append('model', m.modelId);
      if (p.language) form.append('language', p.language);
      if (p.prompt) form.append('prompt', p.prompt);
      if (p.temperature !== undefined) form.append('temperature', String(p.temperature));
      // 'text' is derived locally from the json shape so failover output stays
      // uniform; 'vtt' never reaches here (no native subtitle support is
      // declared for custom rows, so resolveTranscriptionChain filters them).
      form.append('response_format', p.responseFormat === 'verbose_json' ? 'verbose_json' : 'json');
      // Never set Content-Type by hand — FormData supplies the boundary.
      const r = await mediaFetch(`${credential.baseUrl}/audio/transcriptions`, 'custom', 'transcription', {
        method: 'POST',
        headers: { ...bearerAuthHeader(key) },
        body: form,
      }, FETCH_TIMEOUT_MS, p.signal);
      const j = (await readProviderResponseJson(r, MAX_TRANSCRIPTION_RESPONSE_BYTES)) as { text?: string; language?: string; duration?: number; segments?: unknown[] };
      if (typeof j.text !== 'string') throw new MediaError('custom endpoint returned no transcription text', 502);
      return { text: j.text, language: j.language, duration: j.duration, segments: j.segments };
    }
    case 'groq': {
      // Groq's OpenAI-compatible audio endpoint takes multipart form data.
      // Never set Content-Type by hand — FormData supplies the boundary.
      const form = new FormData();
      form.append('file', new Blob([p.file], { type: p.mimeType || 'application/octet-stream' }), p.filename);
      form.append('model', m.modelId);
      if (p.language) form.append('language', p.language);
      if (p.prompt) form.append('prompt', p.prompt);
      if (p.temperature !== undefined) form.append('temperature', String(p.temperature));
      // Groq supports json/verbose_json/text natively; text is derived locally
      // from the json shape so failover output stays uniform.
      form.append('response_format', p.responseFormat === 'verbose_json' ? 'verbose_json' : 'json');
      const r = await mediaFetch('https://api.groq.com/openai/v1/audio/transcriptions', 'groq', 'transcription', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      }, FETCH_TIMEOUT_MS, p.signal);
      const j = (await readProviderResponseJson(r, MAX_TRANSCRIPTION_RESPONSE_BYTES)) as { text?: string; language?: string; duration?: number; segments?: unknown[] };
      if (typeof j.text !== 'string') throw new MediaError('groq returned no transcription text', 502);
      return { text: j.text, language: j.language, duration: j.duration, segments: j.segments };
    }
    case 'cloudflare': {
      const { accountId, token } = parseCfKey(key);
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${m.modelId}`;
      const init: RequestInit = m.requestStyle === 'json'
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              audio: p.file.toString('base64'),
              ...(p.language ? { language: p.language } : {}),
              ...(p.prompt ? { initial_prompt: p.prompt } : {}),
            }),
          }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` },
            body: p.file,
          };
      const r = await mediaFetch(url, 'cloudflare', 'transcription', init, FETCH_TIMEOUT_MS, p.signal);
      const j = (await readProviderResponseJson(r, MAX_TRANSCRIPTION_RESPONSE_BYTES)) as {
        result?: {
          text?: string;
          vtt?: string;
          segments?: unknown[];
          transcription_info?: { language?: string; duration?: number };
        };
      };
      const result = j.result;
      if (!result || typeof result.text !== 'string') {
        throw new MediaError('cloudflare returned no transcription text', 502);
      }
      return {
        text: result.text,
        language: result.transcription_info?.language,
        duration: result.transcription_info?.duration,
        segments: result.segments,
        vtt: typeof result.vtt === 'string' ? result.vtt : undefined,
      };
    }
    default:
      throw new MediaError(`no transcription adapter for platform '${m.platform}'`, 500);
  }
}

/** Transcribe audio, failing over across STT providers. 429s bench the
 *  (platform, model, key) triple through the standard cooldown machinery so a
 *  rate-limited key is skipped on subsequent requests, exactly like chat. */
async function runTranscriptionInternal(model: string | undefined, p: TranscriptionParams): Promise<TranscriptionResult> {
  const chain = resolveTranscriptionChain(model, p.responseFormat);
  const usable = chain.filter(m => p.file.length <= m.maxBytes);
  if (usable.length === 0) {
    const maxMb = Math.max(...chain.map(m => m.maxBytes)) / (1024 * 1024);
    throw new MediaError(`Audio file exceeds the ${maxMb} MB provider upload limit.`, 413);
  }
  let lastError: MediaError | null = null;
  // Only a chain rate limited end to end earns a Retry-After (the soonest).
  const hints = new RetryHintTracker();
  for (const m of usable) {
    throwIfClientGone(p.signal);
    const { credential, budgetBlocked } = reserveProviderCredential({ platform: m.platform, key_id: m.keyId }, 0,
      keyId => isOnCooldown(m.platform, m.modelId, keyId));
    if (!credential) {
      if (budgetBlocked) {
        lastError = new MediaError('Monthly key budget exhausted', 429, 'quota_exceeded');
        hints.record(429, secondsUntilNextMonth() * 1000);
      }
      continue;
    }
    const logRow = { platform: m.platform, model_id: m.modelId, modality: 'transcription' as const };
    const started = Date.now();
    try {
      const out = await callTranscriptionProvider(m, credential, p);
      if (p.responseFormat === 'vtt' && !out.vtt) {
        throw new MediaError('upstream returned no vtt subtitles', 502);
      }
      logMedia(logRow, credential.id, 'success', Date.now() - started, null);
      return { platform: m.platform, modelId: m.modelId, ...out };
    } catch (err: any) {
      if (p.signal?.aborted) throw new MediaError('client closed the request', 499);
      const e = err instanceof MediaError ? err : new MediaError(String(err?.message ?? err), 502);
      logMedia(logRow, credential.id, 'error', Date.now() - started, e.message.slice(0, 300));
      if (e.status === 429 && credential.id != null) {
        setCooldown(m.platform, m.modelId, credential.id);
      }
      lastError = e;
      hints.record(e.status, e.retryAfterMs);
    } finally {
      credential.release();
    }
  }
  throw chainError('transcription', lastError, hints);
}

/** Synthesize speech, failing over across providers serving the modality. */
async function runSpeechInternal(model: string | undefined, params: SpeechParams): Promise<SpeechResult> {
  const chain = resolveMediaChain(model, 'audio');
  let lastError: MediaError | null = null;
  // Only a chain rate limited end to end earns a Retry-After (the soonest).
  const hints = new RetryHintTracker();
  for (const row of chain) {
    throwIfClientGone(params.signal);
    const { credential, budgetBlocked } = KEYLESS_CAPABLE.has(row.platform)
      ? { credential: { id: null, key: null, baseUrl: null, release: () => {} }, budgetBlocked: false }
      : reserveProviderCredential(row, 0);
    if (!credential) {
      if (budgetBlocked) {
        lastError = new MediaError('Monthly key budget exhausted', 429, 'quota_exceeded');
        hints.record(429, secondsUntilNextMonth() * 1000);
      }
      continue;
    }
    const started = Date.now();
    try {
      const out = await callSpeechProvider(row, credential, params);
      if (!out.audio.length) throw new MediaError('upstream returned no audio', 502);
      logMedia(row, credential.id, 'success', Date.now() - started, null);
      return { platform: row.platform, modelId: row.model_id, audio: out.audio, contentType: out.contentType };
    } catch (err: any) {
      if (params.signal?.aborted) throw new MediaError('client closed the request', 499);
      const e = err instanceof MediaError ? err : new MediaError(String(err?.message ?? err), 502);
      logMedia(row, credential.id, 'error', Date.now() - started, e.message.slice(0, 300));
      lastError = e;
      hints.record(e.status, e.retryAfterMs);
    } finally {
      credential.release();
    }
  }
  throw chainError('audio', lastError, hints);
}


/** Generate images with bounded process-wide and per-modality concurrency. */
export function runImageGeneration(model: string | undefined, params: ImageParams): Promise<ImageResult> {
  return withMediaCapacity('image', () => runImageGenerationInternal(model, params));
}

/** Generate video with bounded process-wide and per-modality concurrency. */
export function runVideoGeneration(
  model: string | undefined,
  params: VideoParams,
  clientSignal?: AbortSignal,
): Promise<VideoResult> {
  return withMediaCapacity('video', () => runVideoGenerationInternal(model, params, clientSignal));
}

/** Transcribe audio with bounded process-wide and per-modality concurrency. */
export function runTranscription(model: string | undefined, params: TranscriptionParams): Promise<TranscriptionResult> {
  return withMediaCapacity('transcription', () => runTranscriptionInternal(model, params));
}

/** Synthesize speech with bounded process-wide and per-modality concurrency. */
export function runSpeech(model: string | undefined, params: SpeechParams): Promise<SpeechResult> {
  return withMediaCapacity('audio', () => runSpeechInternal(model, params));
}
