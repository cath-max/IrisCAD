// SimpleCADAPI / Pyodide / OCP.wasm Worker (IrisCAD).
// Supports init + run_code + export + reset + inspect + seven-view render.

import { MessageType } from './types.mjs';
import { PyodideEngine } from './pyodideEngine.mjs';
import { compositeGrid } from './compositeGrid.mjs';
import { renderViews } from './threeRenderer.mjs';
import { executeAssemblySectionRequest } from './assemblySectionExecution.mjs';

const DEFAULT_RENDER_VIEWS = [
  'iso',
  'front',
  'back',
  'top',
  'bottom',
  'left',
  'right',
];

/** @type {PyodideEngine | null} */
let engine = null;
/** @type {Promise<void> | null} */
let ready = null;
const assemblyBaselines = new Map();
const successfulAssemblySessions = new Set();

self.onmessage = async (event) => {
  const { id, type, data } = event.data;

  try {
    let result;

    if (type === MessageType.INIT) {
      if (!engine) {
        engine = new PyodideEngine({
          ocpWheelUrls: data.ocpWheelUrls ?? [data.ocpWheelUrl],
          simplecadapiWheelUrls: data.simplecadapiWheelUrls ?? [
            data.simplecadapiWheelUrl,
          ],
        });
        ready = engine.init();
      }
      await ready;
      result = { ok: true };
      self.postMessage({ id, type, data: result });
      return;
    }

    if (!engine || !ready) {
      throw new Error(
        'SimpleCADAPI worker not initialized. Send init with wheel URLs first.',
      );
    }
    await ready;

    switch (type) {
      case MessageType.RUN_CODE: {
        const sessionId = data.sessionId ?? 'default';
        assemblyBaselines.delete(sessionId);
        successfulAssemblySessions.delete(sessionId);
        result = await engine.runCode(data.code, sessionId);
        if (
          data.artifactVersion &&
          result?.ok &&
          result.result_type === 'Assembly' &&
          result.assembly != null
        ) {
          assemblyBaselines.set(sessionId, data.artifactVersion);
        }
        if (
          result?.ok &&
          result.result_type === 'Assembly' &&
          result.assembly != null
        ) {
          successfulAssemblySessions.add(sessionId);
        }
        break;
      }
      case MessageType.REGISTER_ASSEMBLY_BASELINE: {
        const sessionId = data.sessionId ?? 'default';
        if (!successfulAssemblySessions.has(sessionId)) {
          result = { ok: false };
        } else {
          assemblyBaselines.set(sessionId, data.artifactVersion);
          result = { ok: true };
        }
        break;
      }
      case MessageType.RUN_ASSEMBLY_SECTIONS: {
        result = await executeAssemblySectionRequest({
          engine,
          baselines: assemblyBaselines,
          data,
        });
        break;
      }
      case MessageType.ANALYZE_ASSEMBLY_SECTIONS:
        result = await engine.analyzeAssemblySections(data.code);
        break;
      case MessageType.EXPORT_SHAPE:
        result = await engine.exportShape(
          data.sessionId ?? 'default',
          data.shapeName,
          data.format,
          data.path,
        );
        break;
      case MessageType.RENDER_VIEWS: {
        const meshResult = await engine.renderMeshBuffers(
          data.sessionId ?? 'default',
          data.shapeName,
          {
            highlightTags: data.highlightTags,
            highlightColors: data.highlightColors,
            tagLabels: data.tagLabels,
            pathPrefix: data.pathPrefix ?? '/tmp/preview_mesh',
          },
        );
        if (meshResult.ok) {
          const images = await renderViews(
            meshResult,
            data.views ?? DEFAULT_RENDER_VIEWS,
            {
              imageSize: data.imageSize ?? 512,
              showAxes: data.showAxes ?? true,
              showEdges: data.showEdges ?? true,
            },
          );
          const compositeBlob = await compositeGrid(images, {
            legend: meshResult.legend,
          });
          result = {
            ok: true,
            images: images.map(({ view, bytes }) => ({
              view,
              size: bytes.length,
            })),
            composite: new Uint8Array(await compositeBlob.arrayBuffer()),
            error: null,
          };
        } else {
          result = {
            ok: false,
            images: [],
            composite: null,
            error: meshResult.error,
          };
        }
        break;
      }
      case MessageType.RENDER_MESH: {
        const workerStartedAt = performance.now();
        const meshResult = await engine.renderMeshBuffers(
          data.sessionId ?? 'default',
          data.shapeName ?? 'result',
          {
            highlightTags: data.highlightTags,
            highlightColors: data.highlightColors,
            tagLabels: data.tagLabels,
            pathPrefix: data.pathPrefix ?? '/tmp/preview_mesh',
            meshTolerance: data.meshTolerance,
            meshAngularTolerance: data.meshAngularTolerance,
            shading: data.shading,
          },
        );
        meshResult.timing = {
          worker_ms: performance.now() - workerStartedAt,
        };
        if (meshResult?.ok && meshResult.bytes?.buffer) {
          self.postMessage({ id, type, data: meshResult }, [
            meshResult.bytes.buffer,
          ]);
          return;
        }
        result = meshResult;
        break;
      }
      case MessageType.RENDER_ASSEMBLY_COMPONENT_MESHES: {
        const meshResult = await engine.renderAssemblyComponentMeshes(
          data.sessionId ?? 'default',
          data.shapeName ?? 'result',
          {
            pathPrefix: data.pathPrefix ?? '/tmp/assembly_component_mesh',
            meshTolerance: data.meshTolerance,
            meshAngularTolerance: data.meshAngularTolerance,
            shading: data.shading,
          },
        );
        if (meshResult?.ok) {
          const transfers = meshResult.components
            .map((component) => component.bytes?.buffer)
            .filter(Boolean);
          self.postMessage({ id, type, data: meshResult }, transfers);
          return;
        }
        result = meshResult;
        break;
      }
      case MessageType.INSPECT_ASSEMBLY_RENDER_STATE:
        result = await engine.inspectAssemblyRenderState(
          data.sessionId ?? 'default',
          data.shapeName ?? 'result',
        );
        break;
      case MessageType.RENDER_ASSEMBLY_PART_MESHES: {
        const workerStartedAt = performance.now();
        const meshResult = await engine.renderAssemblyPartMeshes(
          data.sessionId ?? 'default',
          data.shapeName ?? 'result',
          data.partIds ?? [],
          {
            pathPrefix: data.pathPrefix,
            meshTolerance: data.meshTolerance,
            meshAngularTolerance: data.meshAngularTolerance,
            shading: data.shading,
          },
        );
        meshResult.timing = {
          worker_ms: performance.now() - workerStartedAt,
        };
        if (meshResult?.ok) {
          const transfers = meshResult.parts
            .map((part) => part.bytes?.buffer)
            .filter(Boolean);
          self.postMessage({ id, type, data: meshResult }, transfers);
          return;
        }
        result = meshResult;
        break;
      }

      case MessageType.RESET_SESSION:
        result = await engine.resetSession(data.sessionId ?? 'default');
        assemblyBaselines.delete(data.sessionId ?? 'default');
        successfulAssemblySessions.delete(data.sessionId ?? 'default');
        break;
      case MessageType.INSPECT_GEOMETRY:
        result = await engine.inspectGeometry(
          data.sessionId ?? 'default',
          data.shapeName,
        );
        break;
      default:
        throw new Error(`Unknown message type: ${type}`);
    }

    self.postMessage({ id, type, data: result });
  } catch (error) {
    self.postMessage({
      id,
      type,
      data: null,
      err: {
        message: error && error.message ? error.message : String(error),
      },
    });
  }
};

self.postMessage({ type: MessageType.READY });
