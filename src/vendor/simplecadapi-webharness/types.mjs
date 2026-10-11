// Message envelope for main-thread <-> SimpleCADAPI Worker RPC.
// Worker request/response envelope: {id, type, data}/{id, type, data, err}.

export const MessageType = Object.freeze({
  INIT: 'init',
  RUN_CODE: 'run_code',
  REGISTER_ASSEMBLY_BASELINE: 'register_assembly_baseline',
  RUN_ASSEMBLY_SECTIONS: 'run_assembly_sections',
  ANALYZE_ASSEMBLY_SECTIONS: 'analyze_assembly_sections',
  EXPORT_SHAPE: 'export_shape',
  RENDER_VIEWS: 'render_views',
  RENDER_MESH:'render_mesh',
  RENDER_ASSEMBLY_COMPONENT_MESHES: 'render_assembly_component_meshes',
  INSPECT_ASSEMBLY_RENDER_STATE: 'inspect_assembly_render_state',
  RENDER_ASSEMBLY_PART_MESHES: 'render_assembly_part_meshes',
  RESET_SESSION: 'reset_session',
  INSPECT_GEOMETRY: 'inspect_geometry',
  READY: 'ready',
});
