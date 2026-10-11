import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createOrbitStudio } from './orbitStudioScene.ts';

test('studio preserves world placement and visibility without sharing material ownership', () => {
  const parent = new THREE.Group();
  parent.rotation.x = -Math.PI / 2;
  parent.position.set(10, 20, 30);
  const source = new THREE.Group();
  source.position.z = 5;
  const material = new THREE.MeshStandardMaterial({
    metalness: 0.6,
    roughness: 0.3,
    envMapIntensity: 0.3,
  });
  const geometry = new THREE.BoxGeometry(2, 4, 6);
  const mesh = new THREE.Mesh(geometry, material);
  const hidden = mesh.clone();
  hidden.visible = false;
  source.add(mesh, hidden);
  parent.add(source);
  parent.updateMatrixWorld(true);
  const before = source.matrixWorld.clone();
  let sourceDisposals = 0;
  geometry.addEventListener('dispose', () => sourceDisposals++);
  material.addEventListener('dispose', () => sourceDisposals++);
  const studio = createOrbitStudio(
    source,
    new THREE.Box3().setFromObject(source),
  );
  const copy = studio.object.children[0] as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshStandardMaterial
  >;
  assert.deepEqual(studio.object.matrixWorld.elements, before.elements);
  assert.equal(copy.geometry, geometry);
  assert.notEqual(copy.material, material);
  assert.equal(copy.material.roughness, 0.3);
  assert.equal(copy.material.metalness, 0.6);
  assert.equal(copy.material.envMapIntensity, 0.3);
  assert.equal(studio.object.children[1].visible, false);
  assert.equal(
    studio.scene.children.filter((x) => x instanceof THREE.RectAreaLight)
      .length,
    2,
  );
  const data = (studio.scene.environment as THREE.DataTexture).image.data;
  assert.ok(Array.from(data).every((v) => Number.isFinite(v) && v <= 1));
  let cloneDisposals = 0;
  copy.material.addEventListener('dispose', () => cloneDisposals++);
  studio.dispose();
  studio.dispose();
  assert.equal(cloneDisposals, 1);
  assert.equal(sourceDisposals, 0);
  assert.equal(source.parent, parent);
  assert.deepEqual(source.matrixWorld.elements, before.elements);
  geometry.dispose();
  material.dispose();
});

test('component PNG reuses preview lighting and grounds only the visible component', () => {
  const preview = new THREE.Scene();
  const environment = new THREE.Texture();
  preview.environment = environment;
  const light = new THREE.DirectionalLight(0xffffff, 1.2);
  light.position.set(5, 8, 3);
  preview.add(light);
  const source = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(4, 2, 3),
    new THREE.MeshStandardMaterial(),
  );
  mesh.position.y = 50;
  source.add(mesh);
  preview.add(source);
  const bounds = new THREE.Box3().setFromObject(source);
  let disposed = false;
  environment.addEventListener('dispose', () => {
    disposed = true;
  });
  const studio = createOrbitStudio(source, bounds, preview);
  assert.equal(studio.scene.environment, environment);
  const copy = studio.scene.children.find(
    (node) => node instanceof THREE.DirectionalLight,
  ) as THREE.DirectionalLight;
  assert.equal(copy.intensity, 1.2);
  assert.deepEqual(copy.position.toArray(), light.position.toArray());
  const shadow = studio.scene.children.find(
    (node) => node instanceof THREE.Mesh,
  ) as THREE.Mesh;
  assert.ok(Math.abs(shadow.position.y - bounds.min.y) < 0.01);
  studio.dispose();
  assert.equal(disposed, false);
  assert.equal(mesh.position.y, 50);
});
