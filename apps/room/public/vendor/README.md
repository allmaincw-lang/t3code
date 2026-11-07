`livekit-client-2.22.4.umd.js` is the unmodified `dist/livekit-client.umd.js` from the
`livekit-client@2.22.4` npm package (Apache-2.0, see `livekit-client.LICENSE`).

`three/` holds `three@0.170.0` (MIT, see `three/LICENSE`): `build/three.module.min.js` unmodified, plus
`GLTFLoader.js` and `BufferGeometryUtils.js` from `examples/jsm`, with their bare `'three'` and relative
imports rewritten to sibling files (the CSP forbids an inline import map). `view3d.js` loads them on demand.
