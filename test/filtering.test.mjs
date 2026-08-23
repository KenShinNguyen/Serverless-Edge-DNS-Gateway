import test from 'node:test';
import assert from 'node:assert/strict';
import { __internals as w } from '../functions/[[path]].js';

function withLists({ block = [], allow = [], priv = [], mullvad = [] }, fn) {
  w.__resetState();
  w.__setState({ block: new Set(block), allow: new Set(allow), priv: new Set(priv), mullvad: new Set(mullvad) });
  try { fn(); } finally { w.__resetState(); }
}

test('isDomainBlocked matches subdomains of a listed apex', () => {
  withLists({ block: ['doubleclick.net'] }, () => {
    // The whole point of the wildcard lists: the apex is listed, the real
    // traffic is to a subdomain of it.
    assert.equal(w.isDomainBlocked('googleads.g.doubleclick.net'), true);
    assert.equal(w.isDomainBlocked('doubleclick.net'), true);
    assert.equal(w.isDomainBlocked('net'), false);
    assert.equal(w.isDomainBlocked('notdoubleclick.net'), false);
  });
});

test('isDomainBlocked lets a more specific allowlist entry win over a blocked apex', () => {
  withLists({ block: ['example.com'], allow: ['foo.example.com'] }, () => {
    assert.equal(w.isDomainBlocked('foo.example.com'), false);
    assert.equal(w.isDomainBlocked('bar.example.com'), true);
    assert.equal(w.isDomainBlocked('example.com'), true);
  });
});

test('isDomainBlocked lets a more specific blocklist entry win over an allowed apex', () => {
  withLists({ block: ['ads.example.com'], allow: ['example.com'] }, () => {
    assert.equal(w.isDomainBlocked('ads.example.com'), true);
    assert.equal(w.isDomainBlocked('deep.ads.example.com'), true);
    assert.equal(w.isDomainBlocked('www.example.com'), false);
  });
});

test('isDomainBlocked is inert while the blocklist is empty', () => {
  withLists({ block: [], allow: [] }, () => {
    assert.equal(w.isDomainBlocked('anything.example'), false);
  });
});

test('isDomainPrivate matches bare TLDs and reverse-DNS zones', () => {
  withLists({ priv: ['lan', 'in-addr.arpa', 'localhost'] }, () => {
    assert.equal(w.isDomainPrivate('localhost'), true);
    assert.equal(w.isDomainPrivate('router.lan'), true);
    assert.equal(w.isDomainPrivate('1.1.168.192.in-addr.arpa'), true);
    assert.equal(w.isDomainPrivate('example.com'), false);
    assert.equal(w.isDomainPrivate('notlan'), false);
  });
});

test('isMullvadDomain matches an entry and everything beneath it', () => {
  withLists({ mullvad: ['github.com'] }, () => {
    assert.equal(w.isMullvadDomain('github.com'), true);
    assert.equal(w.isMullvadDomain('api.github.com'), true);
    assert.equal(w.isMullvadDomain('nongithub.com'), false);
  });
});

test('forEachListLine keeps domains and drops comments and blank lines', () => {
  const seen = [];
  w.forEachListLine('# header\n\nads.example\n! bang comment\n  \n  spaced.example  \nlast.example', (l) => seen.push(l));
  assert.deepEqual(seen, ['ads.example', 'spaced.example', 'last.example']);
});

test('forEachListLine tolerates CRLF sources and a trailing newline', () => {
  const seen = [];
  w.forEachListLine('a.example\r\n# c\r\nb.example\r\n', (l) => seen.push(l));
  assert.deepEqual(seen, ['a.example', 'b.example']);
});

test('forEachListLine skips a comment that is indented', () => {
  const seen = [];
  w.forEachListLine('   # indented comment\n   ok.example', (l) => seen.push(l));
  assert.deepEqual(seen, ['ok.example']);
});

test('maskUpstream hides the account slug of a Gateway endpoint', () => {
  const masked = w.maskUpstream('https://abcdef123.cloudflare-gateway.com/dns-query');
  assert.equal(masked, 'https://abc***.cloudflare-gateway.com/dns-query');
  assert.ok(!masked.includes('abcdef123'), 'the full slug never appears');
  assert.equal(w.maskUpstream('not a url'), '***');
});

test('tokenMatches accepts the exact token and nothing else', () => {
  assert.equal(w.tokenMatches('s3cret', 's3cret'), true);
  assert.equal(w.tokenMatches('s3crea', 's3cret'), false);
  assert.equal(w.tokenMatches('s3cret ', 's3cret'), false, 'no length slack');
  assert.equal(w.tokenMatches('', 's3cret'), false);
  assert.equal(w.tokenMatches(undefined, 's3cret'), false);
});
