#!/usr/bin/env node
/**
 * Start the SimpleCADAPI retrieval sidecar (http://127.0.0.1:8765).
 *
 *   npm run sidecar
 *   npm run sidecar -- --simplecadapi-root=D:/path/to/my-simplecadapi
 */

import {
  CADAM_ROOT,
  parseArgs,
  resolveSimpleCadRoot,
  startSidecar,
} from './lib/simplecadapi-vendor.mjs';
import { loadLocalEnv } from './lib/local-env.mjs';

const args = parseArgs();
loadLocalEnv(CADAM_ROOT);
startSidecar(resolveSimpleCadRoot(args.simpleCadRoot));
