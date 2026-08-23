import test from 'node:test';
import assert from 'node:assert/strict';
import { query, response, record, counts, rcodeOf } from './helpers.mjs';

// Each case gets a fresh module instance: upstream config and the "lists have
// been fetched" flag both live in module scope and are applied exactly once.
let instance = 0;
async function loadWorker() {
  return import(`../functions/[[path]].js?case=${instance++}`);
}

const RULES = {
  '/rules/blocklists.txt': 'ads.example\ntracker.example\n',
  '/rules/allowlists.txt': 'good.ads.example\n',
  '/rules/private_tlds.txt': 'lan\n',
  '/rules/redirect_rules.txt': 'old.example new.example\n',
  '/rules/mullvad_upstream.txt': 'github.com\n'
};

/** Stub global fetch: serve the rule files locally, route the rest to `upstream`. */
function stubFetch(upstream) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const path = new URL(url).pathname;
    if (path in RULES) return new Response(RULES[path], { status: 200 });
    calls.push({ url, body: init?.body });
    return upstream(url, init);
  };
  return calls;
}

function ctx(env = {}) {
  return { env, waitUntil() {} };
}

async function call(worker, path, { method = 'POST', body, env = {} } = {}) {
  const request = new Request(`https://dns.example.workers.dev${path}`, {
    method,
    body,
    headers: { 'CF-Connecting-IP': '203.0.113.9' }
  });
  return worker.onRequest({ request, ...ctx(env) });
}

const okUpstream = (buf) => async () => new Response(buf, { status: 200 });

test('a normal query is forwarded and answered with a TTL-derived max-age', async () => {
  const worker = await loadWorker();
  const answer = response({ answers: [record({ ttl: 90, rdata: [93, 184, 216, 34] })] });
  const calls = stubFetch(okUpstream(answer));

  const res = await call(worker, '/dns-query', { body: query({ questions: [{ name: 'example.com', type: 1 }] }) });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/dns-message');
  assert.equal(res.headers.get('cache-control'), 'max-age=90');
  assert.equal(calls.length, 1, 'exactly one upstream request');
});

test('a blocked domain is answered locally with NXDOMAIN and never reaches an upstream', async () => {
  const worker = await loadWorker();
  const calls = stubFetch(() => { throw new Error('upstream must not be called'); });

  const res = await call(worker, '/dns-query', { body: query({ questions: [{ name: 'ads.example', type: 1 }] }) });
  const body = await res.arrayBuffer();

  assert.equal(res.headers.get('x-blocked'), 'ads.example');
  assert.equal(rcodeOf(body), 3, 'NXDOMAIN');
  assert.deepEqual(counts(body), { qd: 1, an: 0, ns: 0, ar: 0 });
  assert.equal(res.headers.get('cache-control'), 'max-age=300');
  assert.equal(calls.length, 0);
});

test('an allowlisted subdomain of a blocked name is resolved normally', async () => {
  const worker = await loadWorker();
  const calls = stubFetch(okUpstream(response({ answers: [record({ ttl: 60, rdata: [93, 184, 216, 34] })] })));

  const res = await call(worker, '/dns-query', { body: query({ questions: [{ name: 'good.ads.example', type: 1 }] }) });

  assert.equal(res.headers.get('x-blocked'), null);
  assert.equal(calls.length, 1);
});

test('a private TLD is refused locally', async () => {
  const worker = await loadWorker();
  stubFetch(() => { throw new Error('upstream must not be called'); });

  const res = await call(worker, '/dns-query', { body: query({ questions: [{ name: 'router.lan', type: 1 }] }) });

  assert.equal(res.headers.get('x-blocked-private'), 'router.lan');
  assert.equal(rcodeOf(await res.arrayBuffer()), 3);
});

test('a Mullvad-listed domain goes to the geo-bypass upstream without ECS', async () => {
  const worker = await loadWorker();
  const original = query({ questions: [{ name: 'api.github.com', type: 1 }] });
  const calls = stubFetch(okUpstream(response({ answers: [record({ ttl: 300, rdata: [93, 184, 216, 34] })] })));

  const res = await call(worker, '/dns-query', { body: original });

  assert.equal(res.headers.get('x-upstream'), 'Mullvad');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /mullvad/);
  assert.deepEqual(
    Array.from(new Uint8Array(calls[0].body)),
    Array.from(new Uint8Array(original)),
    'the client subnet is not leaked to the geo-bypass resolver'
  );
});

test('a failing primary upstream falls over to the secondary', async () => {
  const worker = await loadWorker();
  const answer = response({ answers: [record({ ttl: 30, rdata: [93, 184, 216, 34] })] });
  const seen = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (new URL(url).pathname in RULES) return new Response(RULES[new URL(url).pathname], { status: 200 });
    seen.push(new URL(url).hostname);
    if (seen.length === 1) throw new Error('primary down');
    return new Response(answer, { status: 200 });
  };

  const res = await call(worker, '/dns-query', { body: query() });

  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['cloudflare-dns.com', 'dns.google']);
  assert.equal(res.headers.get('cache-control'), 'max-age=30');
});

test('both upstreams failing yields SERVFAIL that clients are told not to cache', async () => {
  const worker = await loadWorker();
  stubFetch(() => { throw new Error('down'); });

  const res = await call(worker, '/dns-query', { body: query() });
  const body = await res.arrayBuffer();

  assert.equal(res.status, 200, 'DoH reports DNS failure in the message, not the HTTP status');
  assert.equal(rcodeOf(body), 2);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('a loopback answer is re-resolved through the geo-bypass upstream', async () => {
  const worker = await loadWorker();
  const blocked = response({ answers: [record({ rdata: [127, 0, 0, 1] })] });
  const real = response({ answers: [record({ ttl: 45, rdata: [1, 1, 1, 1] })] });
  const hosts = [];
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname in RULES) return new Response(RULES[url.pathname], { status: 200 });
    hosts.push(url.hostname);
    return new Response(hosts.length === 1 ? blocked : real, { status: 200 });
  };

  const res = await call(worker, '/dns-query', { body: query() });

  assert.deepEqual(hosts, ['cloudflare-dns.com', 'dns.mullvad.net']);
  assert.equal(res.headers.get('cache-control'), 'max-age=45');
});

test('malformed and non-query messages are rejected before any upstream call', async () => {
  const worker = await loadWorker();
  const calls = stubFetch(() => { throw new Error('upstream must not be called'); });

  const tooShort = await call(worker, '/dns-query', { body: new Uint8Array([0, 1, 2]) });
  assert.equal(tooShort.status, 400);

  const isAResponse = await call(worker, '/dns-query', { body: query({ flags: 0x8180 }) });
  assert.equal(isAResponse.status, 400, 'QR=1 is a response, not something to resolve');

  const noQuestion = new Uint8Array(query());
  noQuestion[5] = 0; // QDCOUNT=0
  const empty = await call(worker, '/dns-query', { body: noQuestion });
  assert.equal(empty.status, 400);

  assert.equal(calls.length, 0);
});

test('GET carries the query base64url-encoded, and rejects a malformed parameter', async () => {
  const worker = await loadWorker();
  stubFetch(okUpstream(response({ answers: [record({ ttl: 300, rdata: [93, 184, 216, 34] })] })));
  const dns = Buffer.from(new Uint8Array(query())).toString('base64url');

  const ok = await call(worker, `/dns-query?dns=${dns}`, { method: 'GET' });
  assert.equal(ok.status, 200);

  const bad = await call(worker, '/dns-query?dns=!!!not-base64!!!', { method: 'GET' });
  assert.equal(bad.status, 400);

  const missing = await call(worker, '/dns-query', { method: 'GET' });
  assert.equal(missing.status, 400);
});

test('DOH_TOKEN gates every route and an untokened path is indistinguishable from a typo', async () => {
  const worker = await loadWorker();
  stubFetch(okUpstream(response({ answers: [record({ ttl: 300, rdata: [93, 184, 216, 34] })] })));
  const env = { DOH_TOKEN: 's3cret' };

  assert.equal((await call(worker, '/dns-query', { body: query(), env })).status, 404);
  assert.equal((await call(worker, '/dns-query/wrong', { body: query(), env })).status, 404);
  assert.equal((await call(worker, '/dns-query/s3cret', { body: query(), env })).status, 200);
  assert.equal((await call(worker, '/apple/s3cret', { method: 'GET', env })).status, 200);
});

test('without DOH_TOKEN an extra path segment is a 404', async () => {
  const worker = await loadWorker();
  stubFetch(okUpstream(response({ answers: [] })));
  assert.equal((await call(worker, '/dns-query/anything', { body: query() })).status, 404);
});

test('/debug is off unless DEBUG_ENABLED is set, and never prints an upstream in full', async () => {
  const off = await loadWorker();
  stubFetch(okUpstream(response({ answers: [] })));
  assert.equal((await call(off, '/debug', { method: 'GET' })).status, 404);

  const on = await loadWorker();
  stubFetch(okUpstream(response({ answers: [] })));
  const res = await call(on, '/debug', {
    method: 'GET',
    env: { DEBUG_ENABLED: 'true', UPSTREAM_PRIMARY: 'https://abcdef123.cloudflare-gateway.com/dns-query' }
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(body).includes('abcdef123'), 'the Gateway account slug stays masked');
  assert.equal(body.upstreams.primary, 'https://abc***.cloudflare-gateway.com/dns-query');
  assert.equal(body.adBlock.blocklist, 2);
  assert.equal(body.adBlock.allowlist, 1);
  assert.equal(body.dnsRedirect.rules, 1);
});

test('/apple serves a mobileconfig whose UUIDs are stable for a host', async () => {
  const worker = await loadWorker();
  stubFetch(okUpstream(response({ answers: [] })));

  const first = await (await call(worker, '/apple', { method: 'GET' })).text();
  const second = await (await call(worker, '/apple', { method: 'GET' })).text();

  assert.equal(first, second, 'a reinstall replaces the profile instead of stacking a duplicate');
  assert.match(first, /<string>https:\/\/dns\.example\.workers\.dev\/dns-query<\/string>/);
  assert.match(first, /com\.apple\.dnsSettings\.managed/);
});

test('an unknown route is a 404 and OPTIONS is answered without CORS by default', async () => {
  const worker = await loadWorker();
  stubFetch(okUpstream(response({ answers: [] })));

  assert.equal((await call(worker, '/nope', { method: 'GET' })).status, 404);

  const preflight = await call(worker, '/dns-query', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

test('CORS_ORIGIN adds the header to preflight and to answers', async () => {
  const worker = await loadWorker();
  stubFetch(okUpstream(response({ answers: [record({ ttl: 300, rdata: [93, 184, 216, 34] })] })));
  const env = { CORS_ORIGIN: 'https://app.example' };

  const preflight = await call(worker, '/dns-query', { method: 'OPTIONS', env });
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example');

  const answer = await call(worker, '/dns-query', { body: query(), env });
  assert.equal(answer.headers.get('access-control-allow-origin'), 'https://app.example');
});

test('an unreachable blocklist leaves the previously loaded list in place', async () => {
  const worker = await loadWorker();
  const answer = response({ answers: [record({ ttl: 300, rdata: [93, 184, 216, 34] })] });

  // First request populates the lists.
  stubFetch(okUpstream(answer));
  const blocked = await call(worker, '/dns-query', { body: query({ questions: [{ name: 'ads.example', type: 1 }] }) });
  assert.equal(blocked.headers.get('x-blocked'), 'ads.example');

  // Now the rule files start failing. Refresh runs in the background, so drive
  // it directly and wait for it before re-querying.
  let refresh;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname in RULES) return new Response('gone', { status: 500 });
    return new Response(answer, { status: 200 });
  };
  await worker.onRequest({
    request: new Request('https://dns.example.workers.dev/dns-query', { method: 'OPTIONS' }),
    env: {},
    waitUntil(p) { refresh = p; }
  });

  const again = await call(worker, '/dns-query', { body: query({ questions: [{ name: 'ads.example', type: 1 }] }) });
  await refresh;
  assert.equal(again.headers.get('x-blocked'), 'ads.example', 'a stale list still blocks; an empty one would not');
});
