import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { modelCenterOffset } from './modelCenterOffset.ts';

test('incremental recentering ignores mounted preview transforms', () => {
  const model = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(220, 70, 116));
  mesh.position.z = 58;
  model.add(mesh);
  const initial = modelCenterOffset(model);
  assert.equal(initial.distanceTo(new THREE.Vector3(0, 0, -58)), 0);
  const parent = new THREE.Group();
  parent.rotation.x = -Math.PI / 2;
  parent.position.set(10, -30, 15);
  parent.add(model);
  for (let i = 0; i < 4; i++) {
    model.position.copy(modelCenterOffset(model));
    parent.updateMatrixWorld(true);
    assert.equal(modelCenterOffset(model).distanceTo(initial), 0);
  }
  mesh.geometry.dispose();
  mesh.geometry = new THREE.BoxGeometry(240, 70, 120);
  mesh.position.z = 60;
  assert.equal(
    modelCenterOffset(model).distanceTo(new THREE.Vector3(0, 0, -60)),
    0,
  );
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
});

test('respects nested component placements and includes hidden components', () => {
  const root = new THREE.Group();
  const placement = new THREE.Group();
  placement.matrixAutoUpdate = false;
  placement.matrix.makeTranslation(20, 0, 10);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
  mesh.position.x = 5;
  mesh.visible = false;
  placement.add(mesh);
  root.add(placement);
  assert.equal(
    modelCenterOffset(root).distanceTo(new THREE.Vector3(-25, 0, -10)),
    0,
  );
  assert.equal(modelCenterOffset(new THREE.Group()).length(), 0);
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
});
