// Owns one Pyodide interpreter for the lifetime of the Worker.
// Vendored from SimpleCADAPI-repo/webharness for IrisCAD (run_code).

import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/pyodide.mjs';

const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/';

export class PyodideEngine {
  /**
   * @param {Object} [opts]
   * @param {string[]} [opts.ocpWheelUrls]
   * @param {string[]} [opts.simplecadapiWheelUrls]
   */
  constructor(opts = {}) {
    if (!opts.ocpWheelUrls?.length || !opts.simplecadapiWheelUrls?.length) {
      throw new Error(
        'PyodideEngine requires OCP and SimpleCADAPI wheel URL candidates',
      );
    }
    this.ocpWheelUrls = opts.ocpWheelUrls;
    this.simplecadapiWheelUrls = opts.simplecadapiWheelUrls;
    this.pyodide = null;
    this._harness = null;
  }

  async init() {
    this.pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
    await this.pyodide.loadPackage(['micropip', 'numpy']);

    await this.pyodide.runPythonAsync(`
import importlib.metadata
import micropip

async def _install_with_fallback(urls, label):
    failures = []
    for url in urls:
        try:
            await micropip.install(url)
            return url
        except Exception as exc:
            failures.append(f"{url}: {type(exc).__name__}: {exc}")
    raise RuntimeError(f"All {label} wheel sources failed: {' | '.join(failures)}")

await _install_with_fallback(${JSON.stringify(this.ocpWheelUrls)}, "OCP")
_ocp_wasm_version = importlib.metadata.version("cadquery-ocp-novtk-OCP.wasm")
micropip.add_mock_package("cadquery-ocp", _ocp_wasm_version)

await _install_with_fallback(${JSON.stringify(this.simplecadapiWheelUrls)}, "SimpleCADAPI")
`);

    this._harness = this.pyodide.pyimport('simplecadapi.webharness');
  }

  /**
   * @param {string} code
   * @param {string} sessionId
   */
  async runCode(code, sessionId) {
    const jsonStr = await this._harness.run_code(code, sessionId);
    return JSON.parse(jsonStr);
  }

  /** Execute only validated IrisCAD Assembly sections reconstructed in Python. */
  async runAssemblySections(code, sessionId, sections) {
    const jsonStr = await this._harness.run_assembly_sections(
      code,
      sessionId,
      JSON.stringify(sections),
    );
    return JSON.parse(jsonStr);
  }

  /** Analyze IrisCAD Assembly dependencies without executing model code. */
  async analyzeAssemblySections(code) {
    const jsonStr = await this._harness.analyze_assembly_sections(code);
    return JSON.parse(jsonStr);
  }

  /**
   * @param {string} sessionId
   * @param {string} shapeName
   * @param {"step"|"stl"} format
   * @param {string} path
   */
  async exportShape(sessionId, shapeName, format, path) {
    const jsonStr = await this._harness.export_shape(
      sessionId,
      shapeName,
      format,
      path,
    );
    const result = JSON.parse(jsonStr);
    if (result.ok) {
      result.bytes = this.pyodide.FS.readFile(path);
    }
    return result;
  }

  /**
   * Tessellate `shapeName` once and return packed mesh buffers for Three.js.
   * View cameras are applied later by `threeRenderer.mjs` (not here).
   *
   * @param {string} sessionId
   * @param {string} shapeName
   * @param {Object} [opts]
   * @param {string[]} [opts.highlightTags]
   * @param {Object<string,string>} [opts.highlightColors]
   * @param {Object<string,string>} [opts.tagLabels]
   * @param {string} [opts.pathPrefix]
   * @param {number} [opts.meshTolerance]
   * @param {number} [opts.meshAngularTolerance]
   * @param {'flat'|'smooth'} [opts.shading]
   */
  async renderMeshBuffers(sessionId, shapeName, opts = {}) {
    // Plain JS objects stay as JsProxy unless converted — dict-shaped opts
    // need toPy() so Python sees real dicts with .get().
    const toPyDict = (value) =>
      value == null ? null : this.pyodide.toPy(value);
    // Always pass concrete floats/strings (never JS null) so Pyodide never
    // sees JsNull inside Python float(). Defaults match mesh_export coarse path.
    const meshTolerance =
      typeof opts.meshTolerance === 'number' ? opts.meshTolerance : 0.35;
    const meshAngularTolerance =
      typeof opts.meshAngularTolerance === 'number'
        ? opts.meshAngularTolerance
        : 0.22;
    const shading =
      opts.shading === 'smooth' || opts.shading === 'flat'
        ? opts.shading
        : 'flat';
    const jsonStr = await this._harness.render_mesh(
      sessionId,
      shapeName,
      opts.highlightTags ?? null,
      toPyDict(opts.highlightColors),
      toPyDict(opts.tagLabels),
      opts.pathPrefix ?? '/tmp/preview_mesh',
      meshTolerance,
      meshAngularTolerance,
      shading,
    );
    const result = JSON.parse(jsonStr);
    if (result.ok) {
      result.bytes = this.pyodide.FS.readFile(result.path);
      for (const [name, view] of Object.entries(result.bufferViews)) {
        result[name] = new Float32Array(
          result.bytes.buffer,
          result.bytes.byteOffset + view.byteOffset,
          view.byteLength / 4,
        );
      }
    }
    return result;
  }

  /** Tessellate direct Assembly Part instances without flattening to Compound. */
  async renderAssemblyComponentMeshes(sessionId, shapeName, opts = {}) {
    const meshTolerance =
      typeof opts.meshTolerance === 'number' ? opts.meshTolerance : 0.12;
    const meshAngularTolerance =
      typeof opts.meshAngularTolerance === 'number'
        ? opts.meshAngularTolerance
        : 0.1;
    const shading =
      opts.shading === 'smooth' || opts.shading === 'flat'
        ? opts.shading
        : 'smooth';
    const jsonStr = await this._harness.render_assembly_component_meshes(
      sessionId,
      shapeName,
      opts.pathPrefix ?? '/tmp/assembly_component_mesh',
      meshTolerance,
      meshAngularTolerance,
      shading,
    );
    const result = JSON.parse(jsonStr);
    if (result.ok) {
      for (const component of result.components) {
        component.bytes = this.pyodide.FS.readFile(component.path);
        for (const [name, view] of Object.entries(component.bufferViews)) {
          component[name] = new Float32Array(
            component.bytes.buffer,
            component.bytes.byteOffset + view.byteOffset,
            view.byteLength / 4,
          );
        }
      }
    }
    return result;
  }

  /** Inspect unique Part IDs and independent Component Placements. */
  async inspectAssemblyRenderState(sessionId, shapeName) {
    const jsonStr = await this._harness.inspect_assembly_render_state(
      sessionId,
      shapeName,
    );
    return JSON.parse(jsonStr);
  }

  /** Tessellate requested unique Parts in Part-local coordinates. */
  async renderAssemblyPartMeshes(sessionId, shapeName, partIds, opts = {}) {
    const meshTolerance =
      typeof opts.meshTolerance === 'number' ? opts.meshTolerance : 0.12;
    const meshAngularTolerance =
      typeof opts.meshAngularTolerance === 'number'
        ? opts.meshAngularTolerance
        : 0.1;
    const shading =
      opts.shading === 'smooth' || opts.shading === 'flat'
        ? opts.shading
        : 'smooth';
    const requestedPartIds = this.pyodide.toPy(partIds);
    let jsonStr;
    try {
      jsonStr = await this._harness.render_assembly_part_meshes(
        sessionId,
        shapeName,
        requestedPartIds,
        opts.pathPrefix ?? '/tmp/assembly_part_mesh',
        meshTolerance,
        meshAngularTolerance,
        shading,
      );
    } finally {
      requestedPartIds.destroy?.();
    }
    const result = JSON.parse(jsonStr);
    if (result.ok) {
      for (const part of result.parts) {
        part.bytes = this.pyodide.FS.readFile(part.path);
        for (const [name, view] of Object.entries(part.bufferViews)) {
          part[name] = new Float32Array(
            part.bytes.buffer,
            part.bytes.byteOffset + view.byteOffset,
            view.byteLength / 4,
          );
        }
      }
    }
    return result;
  }

  /**
   * @param {string} sessionId
   */
  async resetSession(sessionId) {
    await this._harness.reset_session(sessionId);
    return { ok: true };
  }

  /**
   * @param {string} sessionId
   * @param {string} shapeName
   */
  async inspectGeometry(sessionId, shapeName) {
    const jsonStr = await this._harness.inspect_geometry(sessionId, shapeName);
    return JSON.parse(jsonStr);
  }
}
