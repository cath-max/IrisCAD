/**
 * Convert SimpleCADAPI Worker `render_mesh` buffers into a Three.js
 * BufferGeometry for the interactive IrisCAD preview.
 *
 * Contract (matches webharness.render_mesh / renderMeshBuffers):
 * - Flat, non-indexed triangle soup (3 floats per vertex attribute)
 * - CAD / OCCT Z-up; ThreeScene applies the usual -π/2 X rotation
 * - Optional per-vertex RGB in [0, 1] for tag coloring
 */

import * as THREE from 'three';
import { CAD_PREVIEW_MATERIAL, CAD_PREVIEW_TINT } from './previewMaterial.ts';
import type {
  RenderAssemblyComponentMeshesResult,
  RenderMeshResult,
} from '@/worker/simpleCadToolWorker';

/**
 * True when the RPC payload has the minimum arrays needed to build a mesh.
 * Call this before `buildSimpleCadBufferGeometry` so UI can show a toast
 * instead of throwing on a failed / empty render.
 */
export function isRenderableSimpleCadMesh(
  mesh: RenderMeshResult | null | undefined,
): mesh is RenderMeshResult & {
  ok: true;
  positions: Float32Array;
  normals: Float32Array;
} {
  return (
    !!mesh &&
    mesh.ok === true &&
    mesh.positions instanceof Float32Array &&
    mesh.positions.length >= 9 &&
    mesh.normals instanceof Float32Array &&
    mesh.normals.length === mesh.positions.length
  );
}

/**
 * Build a centered BufferGeometry from a successful `renderSimpleCadMesh` result.
 *
 * Ownership: the returned geometry holds references to the same ArrayBuffer
 * backing `positions` / `normals` / `colors` (zero-copy). Do not mutate those
 * TypedArrays after calling this. When replacing a preview, dispose the old
 * geometry with `geometry.dispose()`.
 */
export function buildSimpleCadBufferGeometry(
  mesh: RenderMeshResult,
  { center = true }: { center?: boolean } = {},
): THREE.BufferGeometry {
  if (!isRenderableSimpleCadMesh(mesh)) {
    throw new Error(
      mesh?.error?.what_happened ??
        mesh?.error?.technical_details ??
        'render_mesh did not return usable positions/normals',
    );
  }

  const geometry = new THREE.BufferGeometry();

  // itemSize 3 = xyz per vertex. Non-indexed: every 9 floats = one triangle.
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(mesh.positions, 3),
  );
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));

  // Tag / face colors from SimpleCADAPI (same buffer layout as positions).
  // ThreeScene must set material.vertexColors = true for these to show.
  if (
    mesh.colors instanceof Float32Array &&
    mesh.colors.length === mesh.positions.length
  ) {
    geometry.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3));
  }

  // Whole-model previews are centered; Assembly component meshes must keep
  // their already-applied Placement coordinates inside one shared Group.
  if (center) geometry.center();
  geometry.computeBoundingSphere();

  return geometry;
}

/** Build one Three.js group whose child mesh names are Assembly component IDs. */
export function buildSimpleCadAssemblyGroup(
  meshes: RenderAssemblyComponentMeshesResult,
  visibility: Record<string, boolean>,
): THREE.Group {
  const group = new THREE.Group();
  for (const component of meshes.components) {
    const geometry = buildSimpleCadBufferGeometry(component, { center: false });
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        // Apply the same subtle tint as the single-mesh and incremental paths.
        color: CAD_PREVIEW_TINT,
        vertexColors: geometry.hasAttribute('color'),
        ...CAD_PREVIEW_MATERIAL,
      }),
    );
    mesh.name = component.component_id;
    mesh.visible = visibility[component.component_id] !== false;
    group.add(mesh);
  }
  return group;
}

export function disposeSimpleCadAssemblyGroup(group: THREE.Group | null): void {
  if (!group) return;
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    materials.forEach((material) => material.dispose());
  });
  group.clear();
}
