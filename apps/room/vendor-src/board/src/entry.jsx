import React from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  exportToBlob,
  reconcileElements,
  restoreElements,
  getSceneVersion,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

// Minimal surface for public/board.js: render the editor, reconcile, export.
window.RoomBoardLib = {
  mount(container, props) {
    const root = createRoot(container);
    root.render(<Excalidraw {...props} />);
    return () => root.unmount();
  },
  exportToBlob,
  reconcileElements,
  restoreElements,
  getSceneVersion,
};
