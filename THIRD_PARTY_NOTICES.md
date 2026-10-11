# Third-Party Notices

This document records the direct upstream CAD projects and prebuilt CAD runtime
components used or distributed by IrisCAD. Package-manager dependencies remain
subject to the license information shipped with their respective packages.

## CADAM

- Project: CADAM
- Upstream source: <https://github.com/Adam-CAD/CADAM>
- Relationship: IrisCAD is based on and extends CADAM.
- License: GNU General Public License version 3.0 (GPL-3.0)
- Copyright: CADAM contributors

The IrisCAD application code derived from CADAM remains under GPL-3.0. The full
license text is provided in [`LICENSE`](LICENSE), and the inherited Git history
preserves the original authorship of the source.

## SimpleCADAPI

- Project: SimpleCADAPI
- Original author: NiJingzhe
- Upstream source: <https://github.com/NiJingzhe/SimpleCADAPI>
- Modified source used by IrisCAD:
  <https://github.com/cath-max/iriscad-simplecadapi>
- Distributed package: `simplecadapi==2.0.1b8`
- License: GNU Affero General Public License version 3.0 (AGPL-3.0)
- Fork provenance:
  <https://github.com/cath-max/iriscad-simplecadapi/blob/main/UPSTREAM.md>

IrisCAD distributes a modified SimpleCADAPI wheel. The corresponding source,
modification history, build configuration, and complete AGPL-3.0 license are
available in the modified source repository above. The wheel also contains a
copy of the AGPL-3.0 license in its package metadata.

The modified distribution is independent and is not represented as an official
SimpleCADAPI release or as endorsed by the upstream maintainers.

## OCP.wasm

- Project: OCP.wasm
- Author: Yeicor
- Upstream source: <https://github.com/Yeicor/OCP.wasm>
- Distributed package: `cadquery-ocp-novtk-OCP.wasm`
- Distributed version: `7.9.3.1.post202607021200`
- Package release:
  <https://pypi.org/project/cadquery-ocp-novtk-OCP.wasm/7.9.3.1.post202607021200/>
- Relationship: IrisCAD redistributes the upstream prebuilt wheel without
  source modifications.
- License declared by the package: MIT

The OCP.wasm wheel contains compiled CAD bindings and runtime components whose
own upstream licenses continue to apply. These include the Apache-2.0-licensed
[CadQuery OCP bindings](https://github.com/CadQuery/OCP) and Open CASCADE
Technology, distributed under
[LGPL-2.1](https://github.com/Open-Cascade-SAS/OCCT/blob/master/LICENSE_LGPL_21.txt)
with the
[Open CASCADE exception](https://github.com/Open-Cascade-SAS/OCCT/blob/master/OCCT_LGPL_EXCEPTION.txt).
Consult the
[OCP.wasm source and build definitions](https://github.com/Yeicor/OCP.wasm) for
the complete composition of the published wheel.

### OCP.wasm MIT license notice

Copyright 2025 Yeicor

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
