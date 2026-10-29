import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Checker, defaultSettings, postalCodeFits } from '../src/checker.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('country defaults from COUNTRY and is validated', () => {
  assert.equal(defaultSettings({}).country, 'ca');
  assert.equal(defaultSettings({ COUNTRY: 'US' }).country, 'us');
  assert.throws(() => defaultSettings({ COUNTRY: 'usa' }));
});

test('postal codes are checked against the country format', () => {
  assert.ok(postalCodeFits('M5V3L9', 'ca'));
  assert.ok(!postalCodeFits('10001', 'ca'));
  assert.ok(postalCodeFits('10001', 'us'));
  assert.ok(postalCodeFits('10001-1234', 'us'));
  assert.ok(!postalCodeFits('M5V3L9', 'us'));
  assert.ok(postalCodeFits('SW1A1AA', 'uk'));
});

test('switching country resets models and a postal code that no longer fits', async () => {
  const checker = new Checker({ env: { POSTAL_CODE: 'M5V 3L9' }, log: () => {} });
  checker.settings.model = 'MK244VC/A';
  assert.equal(await checker.updateSettings({ country: 'us' }), true);
  assert.equal(checker.settings.country, 'us');
  assert.equal(checker.settings.postalCode, '');
  assert.equal(checker.settings.model, 'all');
  await checker.updateSettings({ postalCode: '10001' });
  assert.equal(checker.settings.postalCode, '10001');
  checker.settings.postalCode = 'ABCDE';
  await assert.rejects(checker.checkOnce(), /valid zip code/);
  await assert.rejects(checker.updateSettings({ country: 'u$' }));
});

test('country update waits for an in-flight check before closing the browser', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const checkGate = deferred();
  const closeCalls = [];
  checker.store = {
    country: 'ca',
    browser: {},
    async close() {
      closeCalls.push(this.country);
    },
    async listProducts() {
      return [];
    },
  };
  checker.loadVariants = async () => {};
  checker.runCheck = async () => checkGate.promise;

  const check = checker.check();
  const update = checker.updateSettings({ country: 'us' });
  await Promise.resolve();
  assert.deepEqual(closeCalls, []);
  assert.equal(checker.store.country, 'ca');
  assert.equal(checker.settings.country, 'ca');

  checkGate.resolve();
  await Promise.all([check, update]);
  assert.deepEqual(closeCalls, ['ca']);
  assert.equal(checker.store.country, 'us');
  assert.equal(checker.settings.country, 'us');
});

test('check requested during a country switch waits for matching settings and store', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const productsGate = deferred();
  const variantsGate = deferred();
  const variantsStarted = deferred();
  let runCheckCountry;
  checker.store = {
    country: 'ca',
    async close() {},
    async listProducts() {
      return productsGate.promise;
    },
  };
  checker.loadVariants = async () => {
    variantsStarted.resolve();
    await variantsGate.promise;
  };
  checker.runCheck = async () => {
    runCheckCountry = [checker.settings.country, checker.store.country];
  };

  const update = checker.updateSettings({ country: 'us' });
  await Promise.resolve();
  const check = checker.check();
  assert.equal(runCheckCountry, undefined);

  productsGate.resolve([{ slug: 'buy-iphone/iphone-duo', name: 'iPhone Duo' }]);
  await variantsStarted.promise;
  assert.equal(runCheckCountry, undefined);
  variantsGate.resolve();
  await Promise.all([update, check]);
  assert.deepEqual(runCheckCountry, ['us', 'us']);
});

test('queued updates and a check complete in call order', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const firstProducts = deferred();
  const secondProducts = deferred();
  const secondProductsStarted = deferred();
  const events = [];
  let listCount = 0;
  checker.store = {
    country: 'ca',
    async close() {},
    async listProducts() {
      listCount++;
      events.push(`products:${this.country}`);
      if (listCount === 2) secondProductsStarted.resolve();
      return listCount === 1 ? firstProducts.promise : secondProducts.promise;
    },
  };
  checker.loadVariants = async () => {
    events.push(`variants:${checker.store.country}`);
  };
  checker.runCheck = async () => {
    events.push(`check:${checker.settings.country}:${checker.store.country}`);
  };

  const first = checker.updateSettings({ country: 'us' });
  const second = checker.updateSettings({ country: 'ca' });
  const check = checker.check();
  firstProducts.resolve([{ slug: 'buy-iphone/iphone-duo', name: 'iPhone Duo' }]);
  await secondProductsStarted.promise;
  assert.deepEqual(events, ['products:us', 'variants:us', 'products:ca']);
  secondProducts.resolve([{ slug: 'buy-iphone/iphone-duo', name: 'iPhone Duo' }]);

  await Promise.all([first, second, check]);
  assert.deepEqual(events, [
    'products:us',
    'variants:us',
    'products:ca',
    'variants:ca',
    'check:ca:ca',
  ]);
});

test('failed settings updates do not block later updates or pending checks', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const events = [];
  checker.runCheck = async () => {
    events.push(`check:${checker.settings.emailTo}`);
  };

  const failedUpdate = checker.updateSettings({ country: 'u$' });
  const check = checker.check();
  const validUpdate = checker.updateSettings({ emailTo: 'stock@example.com' });

  await assert.rejects(failedUpdate, /unsupported country/);
  await Promise.all([check, validUpdate]);
  assert.equal(checker.settings.emailTo, 'stock@example.com');
  assert.deepEqual(events, ['check:']);
});

test('empty UK postal code is rejected before opening the browser', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  let opened = false;
  checker.settings.country = 'uk';
  checker.settings.postalCode = '';
  checker.store = {
    async open() {
      opened = true;
    },
  };

  await assert.rejects(checker.checkOnce(), /valid postal code/);
  assert.equal(opened, false);
});

test('blocked checks preserve browser and cooldown, cleared on success', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const browser = {};
  checker.store = { browser, close: async () => assert.fail('preserve blocked session') };
  checker.checkOnce = async () => { throw Object.assign(new Error('HTTP 541'), { retryAfterMs: 300000 }); };
  await checker.check();
  assert.equal(checker.retryAfterMs, 300000);
  assert.equal(checker.error, 'HTTP 541');
  assert.equal(checker.store.browser, browser);
  checker.checkOnce = async () => {};
  await checker.check();
  assert.equal(checker.retryAfterMs, 0);
  assert.equal(checker.error, null);
});

test('ordinary check failures still close the browser', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  let closed = false;
  checker.store = { browser: {}, close: async () => { closed = true; } };
  checker.checkOnce = async () => { throw new Error('network error'); };
  await checker.check();
  assert.ok(closed);
  assert.equal(checker.store.browser, undefined);
  assert.equal(checker.retryAfterMs, 0);
});

function alternateChecker() {
  const checker = new Checker({ env: {}, log: () => {} });
  checker.settings.alternateColorCheck = true;
  checker.variants = { models: [
    { partNumber: 'WHITE256', dims: { dimensionColor: 'white', dimensionCapacity: '256gb' } },
    { partNumber: 'BLACK512', dims: { dimensionColor: 'black', dimensionCapacity: '512gb' } },
    { partNumber: 'BLACK256', dims: { dimensionColor: 'black', dimensionCapacity: '256gb' } },
  ] };
  const calls = [];
  checker.store = { fetchFulfillment: async (...args) => { calls.push(args); } };
  return { checker, calls, selected: [{ partNumber: 'WHITE256' }] };
}

test('optional color request runs once every ten checks and preserves selection', async () => {
  const { checker, calls, selected } = alternateChecker();
  const settings = structuredClone(checker.settings);
  checker.models = [{ partNumber: 'WHITE256', hit: false }];
  for (let i = 0; i < 9; i++) await checker.checkAlternateColor(selected);
  assert.equal(calls.length, 0);
  await checker.checkAlternateColor(selected);
  assert.deepEqual(calls, [[['BLACK256'], settings.postalCode, { maxAttempts: 1 }]]);
  for (let i = 0; i < 10; i++) await checker.checkAlternateColor(selected);
  assert.equal(calls.length, 2);
  assert.deepEqual(checker.settings, settings);
  assert.deepEqual(checker.models, [{ partNumber: 'WHITE256', hit: false }]);
});

test('extra color requests skip disabled, other products, or unavailable alternates', async () => {
  for (const scenario of ['disabled', 'otherProduct', 'allColors']) {
    const { checker, calls, selected } = alternateChecker();
    if (scenario === 'disabled') checker.settings.alternateColorCheck = false;
    if (scenario === 'otherProduct') checker.settings.product = 'buy-iphone/iphone-17';
    if (scenario === 'allColors') selected.push({ partNumber: 'BLACK256' });
    for (let i = 0; i < 10; i++) await checker.checkAlternateColor(selected);
    assert.equal(calls.length, 0);
  }
});

test('extra request failures preserve results and request cooldown', async () => {
  const { checker, selected } = alternateChecker();
  checker.store.fetchFulfillment = async () => { throw Object.assign(new Error('541'), { retryAfterMs: 300000 }); };
  checker.checkOnce = async () => checker.checkAlternateColor(selected);
  checker.alternateColorChecks = 9;
  await checker.check();
  assert.equal(checker.retryAfterMs, 300000);
  assert.equal(checker.error, null);
  assert.equal(checker.alternateColorChecks, 0);
});

test('alternate color setting is boolean and resets cadence on change', async () => {
  assert.equal(defaultSettings({}).alternateColorCheck, false);
  assert.equal(defaultSettings({ ALTERNATE_COLOR_CHECK: 'true' }).alternateColorCheck, true);
  const { checker } = alternateChecker();
  checker.alternateColorChecks = 8;
  await checker.updateSettings({ alternateColorCheck: false });
  assert.equal(checker.alternateColorChecks, 0);
  await checker.updateSettings({ alternateColorCheck: 'false' });
  assert.equal(checker.settings.alternateColorCheck, false);
});

test('distance randomizer chooses 25 or 50 miles without repeated alerts', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'stock-distance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const checker = new Checker({ env: { COUNTRY: 'us', POSTAL_CODE: '60661' }, stateFile: join(dir, 'state.json'), log: () => {} });
  checker.settings.randomizeDistance = true;
  const fixedDistance = checker.settings.maxDistanceKm;
  checker.variants = { title: 'iPhone Duo', dimensions: [], models: [{ partNumber: 'WHITE256', dims: {} }] };
  checker.loadVariants = async () => {};
  let available = true;
  checker.store = {
    browser: {}, html: '', productUrl: 'https://www.apple.com/shop/buy-iphone/iphone-duo',
    loadProductPage: async () => {},
    fetchFulfillment: async () => ({ body: { content: { pickupMessage: { stores: [{
      storeNumber: 'R1', storeName: 'Far store', storedistance: '40', storeDistanceWithUnit: '40 mi',
      partsAvailability: { WHITE256: { pickupDisplay: available ? 'available' : 'unavailable' } },
    }] } } } }),
  };
  let alerts = 0;
  checker.notifiers = () => [{ name: 'test', send: async () => { alerts++; } }];
  const random = t.mock.method(Math, 'random', () => 0.9);
  await checker.checkOnce();
  assert.equal(checker.snapshot().lastCheckDistanceKm, 50 * 1.609344);
  assert.equal(checker.models[0].hit, true);
  assert.equal(alerts, 1);
  random.mock.mockImplementation(() => 0.1);
  await checker.checkOnce();
  assert.equal(checker.snapshot().lastCheckDistanceKm, 25 * 1.609344);
  assert.equal(checker.models[0].hit, false);
  random.mock.mockImplementation(() => 0.9);
  await checker.checkOnce();
  assert.equal(alerts, 1);
  random.mock.mockImplementation(() => 0.1);
  available = false;
  await checker.checkOnce();
  available = true;
  random.mock.mockImplementation(() => 0.9);
  await checker.checkOnce();
  assert.equal(alerts, 2, 'real stock return still alerts');
  assert.equal(checker.settings.maxDistanceKm, fixedDistance);
  checker.settings.randomizeDistance = false;
  await checker.checkOnce();
  assert.equal(checker.lastCheckDistanceKm, fixedDistance);
});

test('distance randomizer defaults off and accepts boolean settings', async () => {
  assert.equal(defaultSettings({}).randomizeDistance, false);
  assert.equal(defaultSettings({ RANDOMIZE_DISTANCE: 'true' }).randomizeDistance, true);
  const checker = new Checker({ env: {}, log: () => {} });
  await checker.updateSettings({ randomizeDistance: true });
  assert.equal(checker.snapshot().settings.randomizeDistance, true);
  await checker.updateSettings({ randomizeDistance: 'false' });
  assert.equal(checker.settings.randomizeDistance, false);
});
