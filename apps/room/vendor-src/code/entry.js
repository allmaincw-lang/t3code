import { basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";

const languages = { javascript, json, css, html, markdown, python };
window.RoomCode = { basicSetup, EditorState, Compartment, EditorView, keymap, indentWithTab, oneDark, Y, yCollab, Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates, languages };
