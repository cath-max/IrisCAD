import assert from 'node:assert/strict';
import { it } from 'node:test';
import { modelFilename, modelTitle } from './modelNaming.ts';

it('uses an object noun phrase and prioritizes the selected artifact', () => {
  assert.equal(
    modelTitle('Create a Centrifugal Pump Impeller'),
    'Centrifugal Pump Impeller',
  );
  assert.equal(modelTitle('请生成一个自行车装配体'), '自行车装配体');
  assert.equal(
    modelFilename('Build a Pump Impeller', 'Other Model'),
    'pump-impeller',
  );
  assert.equal(
    modelFilename(undefined, 'Bicycle Assembly'),
    'bicycle-assembly',
  );
  assert.equal(
    modelFilename(undefined, 'New Conversation'),
    'parametric-model',
  );
});

it('keeps Unicode names and makes Windows-safe filenames', () => {
  assert.equal(modelFilename('自行车 装配体'), '自行车-装配体');
  assert.equal(modelFilename(' A/B: C_*? '), 'a-b-c');
  assert.equal(modelFilename('CON'), 'model-con');
  assert.equal(modelFilename('...'), 'parametric-model');
  assert.equal(modelFilename('Pump\u0000Housing'), 'pump-housing');
});
