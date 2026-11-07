`livekit-client-2.22.4.umd.js` is the unmodified `dist/livekit-client.umd.js` from the
`livekit-client@2.22.4` npm package (Apache-2.0, see `livekit-client.LICENSE`).

`room-code.js` is built from `vendor-src/code` (esbuild, exact pinned CodeMirror 6, Yjs, y-codemirror.next; all MIT, see `room-code.LICENSE`). Rebuild: `cd apps/room/vendor-src/code && npm ci && npm run build`.

`board/` is an esbuild bundle of `@excalidraw/excalidraw@0.18.1` (MIT) with `react@18.3.1`,
built from `apps/room/vendor-src/board` (`npm install --ignore-scripts && npm run build`).
Licenses: `board/LICENSES.md`, `board/react.LICENSE`.

`three/` holds `three@0.170.0` (MIT, see `three/LICENSE`): `build/three.module.min.js` unmodified, plus
`GLTFLoader.js` and `BufferGeometryUtils.js` from `examples/jsm`, with their bare `'three'` and relative
imports rewritten to sibling files (the CSP forbids an inline import map). `view3d.js` loads them on demand.
