import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isIrisCreationRoute, isIrisWorkspaceRoute } from './irisRouteMode.ts';

describe('Iris creation route', () => {
  it('uses only the application root', () => {
    assert.equal(isIrisCreationRoute('/'), true);
    assert.equal(isIrisCreationRoute('///'), true);
    assert.equal(isIrisCreationRoute('/cadam'), false);
    assert.equal(isIrisCreationRoute('/editor/example'), false);
  });
});

describe('Iris workspace routes', () => {
  it('keeps editor and share routes out of the route-level shell', () => {
    assert.equal(isIrisWorkspaceRoute('/editor/conversation-id'), true);
    assert.equal(isIrisWorkspaceRoute('/share/conversation-id'), true);
    assert.equal(isIrisWorkspaceRoute('/history'), false);
  });
});
