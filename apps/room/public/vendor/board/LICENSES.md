# board.js third-party licenses

`board.js` is an esbuild bundle (see `apps/room/vendor-src/board`) of:

- `@excalidraw/excalidraw@0.18.1` — MIT, Copyright (c) 2020 Excalidraw (package.json `license: MIT`).
  Fonts in `fonts/` ship with that package (Excalifont, Virgil, Nunito, Cascadia, Assistant,
  ComicShanns, Lilita, Liberation; SIL OFL / permissive). The Chinese fallback font is omitted.
- `react@18.3.1`, `react-dom@18.3.1` — MIT, Copyright (c) Meta Platforms, Inc. (`react.LICENSE`).
- Transitive dependencies (roughjs, perfect-freehand, jotai, nanoid, etc.) are MIT/ISC/BSD per their packages.

MIT License: permission is granted, free of charge, to use, copy, modify, merge, publish, distribute,
sublicense and/or sell copies of the software, subject to the copyright notice and this permission
notice being included in all copies. The software is provided "as is", without warranty of any kind.
