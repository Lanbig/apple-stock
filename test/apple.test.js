import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppleStore } from '../src/apple.js';

function storeWithResponses(statuses) {
  const store = new AppleStore({ country: 'us', product: 'iphone-duo' });
  const calls = { requests: [], waits: [], reloads: 0 };
  store.page = {
    async evaluate(fn, path) {
      calls.requests.push(path);
      return { status: statuses.shift(), text: '{"body":{"content":{}}}' };
    },
    async waitForTimeout(ms) { calls.waits.push(ms); },
  };
  store.loadProductPage = async () => { calls.reloads++; };
  store.newSession = async () => { assert.fail('must preserve session cookies'); };
  return { store, calls };
}

test('fulfillment recovers from 541 with fresh URLs and unchanged selection', async () => {
  const { store, calls } = storeWithResponses([541, 200]);
  assert.deepEqual(await store.fetchFulfillment(['ABC/A', 'DEF/A'], '10001'), { body: { content: {} } });
  assert.equal(calls.reloads, 1);
  assert.deepEqual(calls.waits, [5000]);
  const url = new URL(calls.requests[0], 'https://www.apple.com');
  const retry = new URL(calls.requests[1], 'https://www.apple.com');
  assert.equal(url.pathname, '/shop/fulfillment-messages');
  assert.equal(url.searchParams.get('parts.0'), 'ABC/A');
  assert.equal(url.searchParams.get('parts.1'), 'DEF/A');
  assert.equal(url.searchParams.get('location'), '10001');
  assert.ok(url.searchParams.get('_'));
  assert.notEqual(url.searchParams.get('_'), retry.searchParams.get('_'));
  url.searchParams.delete('_');
  retry.searchParams.delete('_');
  assert.equal(url.href, retry.href);
});

test('persistent 541 is bounded and requests a five-minute cooldown', async () => {
  const { store, calls } = storeWithResponses([541, 541, 541]);
  await assert.rejects(store.fetchFulfillment(['ABC/A'], '10001'), (error) => {
    assert.match(error.message, /Apple blocked.*541/);
    assert.equal(error.retryAfterMs, 300000);
    return true;
  });
  assert.equal(calls.requests.length, 3);
  assert.equal(calls.reloads, 1);
  assert.deepEqual(calls.waits, [5000, 15000]);
});

test('invalid fulfillment requests fail immediately instead of retrying', async () => {
  const { store, calls } = storeWithResponses([400]);
  await assert.rejects(store.fetchFulfillment(['ABC/A'], '10001'), /HTTP 400/);
  assert.equal(calls.requests.length, 1);
  assert.deepEqual(calls.waits, []);
});

test('rate limits request a cooldown without reloading', async () => {
  const { store, calls } = storeWithResponses([429, 429, 429]);
  await assert.rejects(store.fetchFulfillment(['ABC/A'], '10001'), { retryAfterMs: 300000 });
  assert.equal(calls.reloads, 0);
});

test('browser requests disable caching, have a timeout and unique trace headers', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return { status: 200, text: async () => '{"body":{}}' };
  });
  const store = new AppleStore({ country: 'ca', product: 'iphone-duo' });
  store.page = { evaluate: (fn, arg) => fn(arg) };
  await store.fetchFulfillment(['ABC/A'], 'M5V3L9');
  await store.fetchFulfillment(['ABC/A'], 'M5V3L9');
  assert.match(requests[0].url, /^\/ca\/shop\/fulfillment-messages\?/);
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(requests[0].options.cache, 'no-store');
  assert.notEqual(requests[0].url, requests[1].url);
  assert.notEqual(requests[0].options.headers['x-aos-ui-fetch-call-1'], requests[1].options.headers['x-aos-ui-fetch-call-1']);
});

test('single-attempt requests never retry or reload on 541', async () => {
  const { store, calls } = storeWithResponses([541]);
  await assert.rejects(store.fetchFulfillment(['ABC/A'], '10001', { maxAttempts: 1 }), { retryAfterMs: 300000 });
  assert.equal(calls.requests.length, 1);
  assert.equal(calls.reloads, 0);
  assert.deepEqual(calls.waits, []);
});
