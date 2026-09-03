import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import worker, { stripPreamble } from '../src/index';

// No network in these tests: they cover routing, auth and validation — everything before the OpenRouter call.
const testEnv = { ...env, APP_TOKEN: 'test-token', OPENROUTER_KEY: 'unused', VERSION: 'test' } as Env;
const BASE = 'http://example.com';

async function call(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(BASE + path, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('GET', () => {
  it('/ describes the service and carries the version header', async () => {
    const res = await call('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-worker-version')).toBe('test');
    const body = (await res.json()) as { routes: string[]; version: string };
    expect(body.version).toBe('test');
    expect(body.routes).toEqual(['POST /dexa', 'POST /food']);
  });

  it('/dexa describes the feature without calling a model', async () => {
    const res = await call('/dexa');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-feature')).toBe('dexa');
    const body = (await res.json()) as { models: { primary: string } };
    expect(body.models.primary).toContain('/');
  });

  it('unknown path is 404, prototype keys are not features', async () => {
    expect((await call('/zzz')).status).toBe(404);
    expect((await call('/constructor')).status).toBe(404);
    expect((await call('/__proto__')).status).toBe(404);
  });
});

describe('HEAD', () => {
  it('mirrors GET status and headers, with no body', async () => {
    const res = await call('/dexa', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-feature')).toBe('dexa');
    expect(res.headers.get('x-worker-version')).toBe('test');
    expect(await res.text()).toBe('');
  });

  it('keeps the 404 of an unknown path', async () => {
    expect((await call('/zzz', { method: 'HEAD' })).status).toBe(404);
    expect((await call('/', { method: 'HEAD' })).status).toBe(200);
  });
});

describe('POST', () => {
  const jsonInit = (body: unknown, token?: string): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-app-token': token } : {}) },
    body: JSON.stringify(body),
  });

  it('rejects a missing or wrong token before anything else', async () => {
    expect((await call('/food', jsonInit({ text: 'hi' }))).status).toBe(401);
    expect((await call('/food', jsonInit({ text: 'hi' }, 'wrong'))).status).toBe(401);
    expect((await call('/nope', jsonInit({ text: 'hi' }, 'wrong'))).status).toBe(401);
  });

  it('returns 404 with the known features for an unknown feature', async () => {
    const res = await call('/nope', jsonInit({ text: 'hi' }, 'test-token'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { known: string[] };
    expect(body.known).toEqual(['dexa', 'food']);
  });

  it('validates the body', async () => {
    expect((await call('/food', jsonInit({}, 'test-token'))).status).toBe(400);
    const bad = await call('/food', { method: 'POST', headers: { 'x-app-token': 'test-token' }, body: '{not json' });
    expect(bad.status).toBe(400);
  });

  it('refuses oversized bodies up front', async () => {
    const res = await call('/food', {
      method: 'POST',
      headers: { 'x-app-token': 'test-token', 'content-length': String(7 * 1024 * 1024) },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });
});

describe('other methods', () => {
  it('are 405', async () => {
    expect((await call('/food', { method: 'PUT' })).status).toBe(405);
    expect((await call('/', { method: 'DELETE' })).status).toBe(405);
  });
});

describe('stripPreamble', () => {
  it('drops a leading acknowledgement and its "here is" sentence', () => {
    expect(stripPreamble('Of course. Here is a plain-language explanation.\n\nYour T-score...')).toBe('Your T-score...');
    expect(stripPreamble('Sure! Here are the estimates:\n- eggs')).toBe('- eggs');
    expect(stripPreamble('Certainly. Your T-score is low.')).toBe('Your T-score is low.');
  });

  it('leaves a real answer alone', () => {
    const answer = '**Estimated Meal Breakdown**\n\n- Two eggs';
    expect(stripPreamble(answer)).toBe(answer);
    expect(stripPreamble('Of course is an odd way to start a T-score report.')).toBe('is an odd way to start a T-score report.');
  });

  it('drops a bare "here is" paragraph but keeps one that introduces a list', () => {
    expect(stripPreamble('Here is a nutritional estimate for your meal.\n\n### Components')).toBe('### Components');
    const introducesList = 'Here are the items:\n\n- eggs';
    expect(stripPreamble(introducesList)).toBe(introducesList);
    const sameLine = 'Here is the summary. Calories: 480 kcal.';
    expect(stripPreamble(sameLine)).toBe(sameLine);
  });

  it('never returns an empty string', () => {
    expect(stripPreamble('Of course.')).toBe('Of course.');
  });
});
