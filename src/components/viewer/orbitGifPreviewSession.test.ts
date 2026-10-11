import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withPausedOrbitPreview } from './orbitGifPreviewSession.ts';

describe('DEV orbit preview session', () => {
  for (const mode of ['always', 'demand', 'never'] as const) {
    for (const fail of [false, true]) {
      it(`restores ${mode} and disabled controls after ${fail ? 'failure' : 'success'}`, async () => {
        let current: string = mode;
        let invalidations = 0;
        const controls = { enabled: false };
        const error = new Error('capture failed');
        const task = withPausedOrbitPreview(
          {
            frameloop: mode,
            controls,
            setFrameloop: (next) => {
              current = next;
            },
            invalidate: () => {
              invalidations += 1;
            },
          },
          async () => {
            assert.equal(current, 'never');
            assert.equal(controls.enabled, false);
            await Promise.resolve();
            if (fail) throw error;
            return 'GIF';
          },
        );
        if (fail) await assert.rejects(task, (caught) => caught === error);
        else assert.equal(await task, 'GIF');
        assert.equal(current, mode);
        assert.equal(controls.enabled, false);
        assert.equal(invalidations, 1);
      });
    }
  }
  it('reenables controls and invalidates even if restoring the loop throws', async () => {
    const controls = { enabled: true };
    let invalidated = false;
    await assert.rejects(
      withPausedOrbitPreview(
        {
          frameloop: 'always',
          controls,
          setFrameloop: (next) => {
            if (next === 'always') throw new Error('restore failed');
          },
          invalidate: () => {
            invalidated = true;
          },
        },
        async () => {
          assert.equal(controls.enabled, false);
        },
      ),
      /restore failed/,
    );
    assert.equal(controls.enabled, true);
    assert.equal(invalidated, true);
  });
});
