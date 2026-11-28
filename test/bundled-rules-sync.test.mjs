import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRIVATE_TLD_ENTRIES,
  REDIRECT_RULE_ENTRIES,
  GEO_BYPASS_DOMAINS,
} from '../src/bundled-rules.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function ruleLines(file) {
  return fs.readFileSync(path.join(ROOT, 'rules', file), 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('!'));
}

test('bundled private TLDs stay byte-for-byte equivalent to rules/private_tlds.txt', () => {
  assert.deepEqual([...PRIVATE_TLD_ENTRIES], ruleLines('private_tlds.txt'));
});

test('bundled geo-bypass domains stay equivalent to rules/mullvad_upstream.txt', () => {
  assert.deepEqual([...GEO_BYPASS_DOMAINS], ruleLines('mullvad_upstream.txt'));
});

test('bundled redirect rules stay equivalent to rules/redirect_rules.txt', () => {
  const expected = ruleLines('redirect_rules.txt').map(line => {
    const fields = line.split(/\s+/);
    assert.equal(fields.length, 2, `invalid redirect rule: ${line}`);
    return [fields[0], fields[1]];
  });

  assert.deepEqual(
    REDIRECT_RULE_ENTRIES.map(([source, target]) => [source, target]),
    expected
  );
});
