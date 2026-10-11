import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const publicAsset = (name: string) =>
  new URL(`../../../public/${name}`, import.meta.url);

test('ships only the optimized Iris brand assets', () => {
  const expectedAssets = [
    'iris-logo-256.webp',
    'iris-logo-32.png',
    'iris-logo-180.png',
    'iris-favicon.ico',
    'iris-agent-active.webp',
    'iris-wordmark-compact@4x.webp',
    'iris-wordmark-normal@4x.webp',
  ];

  for (const asset of expectedAssets) {
    assert.equal(existsSync(publicAsset(asset)), true, `${asset} is missing`);
  }

  assert.ok(statSync(publicAsset('iris-logo-256.webp')).size < 20_000);
  assert.ok(statSync(publicAsset('iris-agent-active.webp')).size < 1_000_000);
  assert.ok(
    statSync(publicAsset('iris-wordmark-compact@4x.webp')).size < 5_000,
  );
  assert.ok(statSync(publicAsset('iris-wordmark-normal@4x.webp')).size < 5_000);

  for (const removedAsset of [
    'iris-logo.png',
    'YesevaOne-Regular.ttf',
    'SpaceGrotesk-Medium.ttf',
  ]) {
    assert.equal(
      existsSync(publicAsset(removedAsset)),
      false,
      `${removedAsset} should not ship`,
    );
  }
});

test('does not reference the removed wordmark fonts or oversized logo', () => {
  const brandCss = readFileSync(
    new URL('./iris-brand.css', import.meta.url),
    'utf8',
  );
  const wordmark = readFileSync(
    new URL('./IrisWordmark.tsx', import.meta.url),
    'utf8',
  );
  const rootRoute = readFileSync(
    new URL('../../routes/__root.tsx', import.meta.url),
    'utf8',
  );
  const browserSources = `${brandCss}\n${wordmark}\n${rootRoute}`;

  assert.doesNotMatch(browserSources, /YesevaOne|SpaceGrotesk|iris-logo\.png/);
  assert.match(
    rootRoute,
    /rel="preload"[\s\S]*as="image"[\s\S]*iris-agent-active\.webp[\s\S]*fetchPriority="low"/,
  );
});
