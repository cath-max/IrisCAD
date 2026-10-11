import * as THREE from 'three';

/** Center in model coordinates, excluding the root's preview/ancestor transforms. */
export function modelCenterOffset(root: THREE.Object3D): THREE.Vector3 {
  const bounds = new THREE.Box3();
  const visit = (object: THREE.Object3D, relative: THREE.Matrix4) => {
    if (
      object instanceof THREE.Mesh &&
      object.geometry instanceof THREE.BufferGeometry
    ) {
      object.geometry.computeBoundingBox();
      if (object.geometry.boundingBox) {
        bounds.union(
          object.geometry.boundingBox.clone().applyMatrix4(relative),
        );
      }
    }
    for (const child of object.children) {
      if (child.matrixAutoUpdate) child.updateMatrix();
      visit(
        child,
        new THREE.Matrix4().multiplyMatrices(relative, child.matrix),
      );
    }
  };
  visit(root, new THREE.Matrix4());
  return bounds.isEmpty()
    ? new THREE.Vector3()
    : bounds.getCenter(new THREE.Vector3()).negate();
}
