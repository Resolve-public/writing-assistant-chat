// The in-note review overlay's margin notes, measured in the real editor.
//
// The overlay is CodeMirror widgets built by the plugin's own JS, so dev/visual cannot see it.
// This walk raises edits on neighbouring lines of the open chapter, then records where each
// review note actually landed: in the right margin or inline, inside the scroller or clipped,
// and whether any two overlap. The scripted message carries both edits at once, so whether two
// notes are ever pending together is observed here rather than assumed.
//
// Each measurement goes to geometry/<label>.json in the run directory beside its shot. Nothing
// here judges the numbers; the sheet and those files are the evidence.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CHAT_ROOT } from "../lib/scenarioApi.mjs";

const VIEW_TYPE = "writing-assistant-chat";
const CHAPTER = "Chapters/One.md";
const WINDOW = { width: 1600, height: 1000 };
/** The chat sidebar a session usually runs with, file explorer open on the left. */
const CHAT_SIDEBAR = 420;
/** Editor widths: room for margin notes beside readable line width, and less than it. */
const EDITOR_WIDE = 1400;
const EDITOR_NARROW = 560;
/** How long the overlay gets to appear after its editor becomes active. */
const OVERLAY_WAIT_MS = 10_000;

const EDITOR = ".workspace-split.mod-root .markdown-source-view";
const EDITOR_CONTENT = `${EDITOR} .cm-content`;
const NOTE_ACCEPT = `${EDITOR} .lmsa-inline-diff-note .lmsa-inline-diff-btn--accept`;

/** CDP first, Electron's remote module as the fallback, as readme-showcase does. */
async function resizeWindow(app) {
  const cdp = await app.page.context().newCDPSession(app.page);
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal", left: 40, top: 40, ...WINDOW },
    });
  } catch {
    await app.page.evaluate((size) => {
      window.require("@electron/remote").getCurrentWindow().setSize(size.width, size.height);
    }, WINDOW);
  } finally {
    await cdp.detach();
  }
}

/** The chapter open in the main pane, then the chat view reopened beside it. */
async function stage(app) {
  await resizeWindow(app);
  await app.page.evaluate(
    async ({ path, viewType }) => {
      const workspace = window.app.workspace;
      const file = window.app.vault.getFileByPath(path);
      if (!file) throw new Error(`inline-margin-notes: the fixture has no note at ${path}.`);
      const leaf = workspace.getMostRecentLeaf(workspace.rootSplit) ?? workspace.getLeaf(true);
      await leaf.openFile(file, { active: true });
      for (const chat of workspace.getLeavesOfType(viewType)) chat.detach();
      await window.__lmsaDriver.openChat();
    },
    { path: CHAPTER, viewType: VIEW_TYPE },
  );
  await app.awaitCheckpoint("view-open");
  await app.page.evaluate((w) => window.app.workspace.rightSplit.setSize(w), CHAT_SIDEBAR);
  await nextFrames(app);
}

/**
 * Waits until the main editor's box has held still for ten frames. Sidebar collapse animates,
 * and a measurement taken mid-animation describes a layout the picture never shows.
 */
async function nextFrames(app) {
  await app.page.evaluate(
    () =>
      new Promise((done) => {
        const started = performance.now();
        let last = "";
        let still = 0;
        const tick = () => {
          const r = window.app.workspace.rootSplit.containerEl.getBoundingClientRect();
          const now = `${r.left},${r.width}`;
          still = now === last ? still + 1 : 0;
          last = now;
          if (still >= 10 || performance.now() - started > 3000) done();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** Left sidebar collapsed, chat sidebar sized so the main editor pane is `width` wide. */
async function setEditorWidth(app, width) {
  await app.page.evaluate((target) => {
    const workspace = window.app.workspace;
    workspace.leftSplit.collapse();
    const current = workspace.rootSplit.containerEl.getBoundingClientRect().width;
    const sidebar = workspace.rightSplit.containerEl.getBoundingClientRect().width;
    workspace.rightSplit.setSize(Math.max(300, sidebar + current - target));
  }, width);
  await nextFrames(app);
}

/**
 * How long the overlay took to appear in the chapter's editor, or null if it never did. A
 * measurement, not a pass/fail: "not within 10s" is itself the finding.
 */
async function awaitOverlay(app) {
  const started = Date.now();
  try {
    await app.page.waitForFunction(
      (selector) => document.querySelector(`${selector} .lmsa-inline-diff-note`) !== null,
      EDITOR,
      { timeout: OVERLAY_WAIT_MS },
    );
    return Date.now() - started;
  } catch {
    return null;
  }
}

/**
 * Where every review note in the chapter's editor sits, read from the DOM's own boxes.
 * Runs in the page, so it can only use what is serialisable.
 */
function readGeometry(editorSelector) {
  // The chapter's own editor, found through its leaf. A selector over the DOM can match a
  // source view that is not the one on screen.
  const leaf = window.app.workspace
    .getLeavesOfType("markdown")
    .find((l) => l.view.file?.path === "Chapters/One.md");
  const editor = leaf?.view.editor.cm?.dom ?? null;
  const view = editor?.closest(".markdown-source-view") ?? null;
  const sourceViews = [...document.querySelectorAll(editorSelector)].map((v) => {
    const r = v.getBoundingClientRect();
    return { left: Math.round(r.left), width: Math.round(r.width), isChapter: v === view };
  });
  if (!editor) return { editorFound: false };

  const box = (r) => ({
    left: Math.round(r.left),
    top: Math.round(r.top),
    right: Math.round(r.right),
    bottom: Math.round(r.bottom),
  });
  const scroller = editor.querySelector(".cm-scroller").getBoundingClientRect();
  const content = editor.querySelector(".cm-content").getBoundingClientRect();

  const notes = [...editor.querySelectorAll(".lmsa-inline-diff-note")].map((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    // What a pointer at the note's centre would actually hit, which is what a click needs.
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      label: el.querySelector(".lmsa-inline-diff-note-label")?.textContent ?? null,
      position: style.position,
      painted: { display: style.display, visibility: style.visibility, opacity: style.opacity },
      hitAtCentre: hit === null ? null : hit.closest(".lmsa-inline-diff-note") ? "the note" : hit.className,
      // Every ancestor up to the scroller that could clip or cover it.
      clippers: (() => {
        const found = [];
        for (let a = el.parentElement; a && !a.classList.contains("cm-scroller"); a = a.parentElement) {
          const s = getComputedStyle(a);
          const clips =
            s.overflowX !== "visible" || s.overflowY !== "visible" || s.contain !== "none" ||
            s.clipPath !== "none";
          if (clips) {
            found.push({
              cls: a.className,
              overflow: `${s.overflowX}/${s.overflowY}`,
              contain: s.contain,
              clipPath: s.clipPath,
            });
          }
        }
        return found;
      })(),
      box: box(r),
      insideScroller: r.left >= scroller.left && r.right <= scroller.right,
      coversText: r.left < content.right && r.right > content.left,
    };
  });

  const overlaps = [];
  notes.forEach((a, i) =>
    notes.slice(i + 1).forEach((b, j) => {
      const hit =
        a.box.left < b.box.right &&
        b.box.left < a.box.right &&
        a.box.top < b.box.bottom &&
        b.box.top < a.box.bottom;
      if (hit) overlaps.push([i, i + 1 + j]);
    }),
  );

  const bodies = [...editor.querySelectorAll(".lmsa-inline-diff-body")];
  return {
    editorFound: true,
    sourceViews,
    windowWidth: window.innerWidth,
    editorScrollTop: Math.round(editor.querySelector(".cm-scroller").scrollTop),
    activeIsChapter: document.querySelector(".workspace-leaf.mod-active .markdown-source-view") === view,
    marginMode: editor.classList.contains("lmsa-inline-diff-margin-mode"),
    marginSpace: Math.round(scroller.right - content.right),
    struck: editor.querySelectorAll(".lmsa-inline-diff-removed").length,
    insertedInline: editor.querySelectorAll(".lmsa-inline-diff-added").length,
    blocks: bodies.length,
    blocksRenderedAsMarkdown: bodies.filter((b) => b.querySelector("p, h1, h2, h3, ul, ol")).length,
    blockDom: bodies.map((b) => {
      const block = b.parentElement;
      const r = block.getBoundingClientRect();
      return {
        box: box(r),
        parentClass: block.parentElement?.className ?? null,
        html: block.outerHTML.slice(0, 1200),
      };
    }),
    notes,
    overlaps,
  };
}

/** A shot of the chapter's editor plus its geometry, filed under the same label. */
async function measure(app, label, extra = {}) {
  const geometry = { ...extra, ...(await app.page.evaluate(readGeometry, EDITOR)) };
  const dir = join(app.dir, "geometry");
  mkdirSync(dir, { recursive: true });
  const file = `${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`;
  writeFileSync(join(dir, file), `${JSON.stringify(geometry, null, 2)}\n`);
  // The whole window, so the picture and the geometry share one coordinate space.
  await app.shot(label);
  return geometry;
}

/** Waits on the chapter's own text, the one thing an accept is supposed to change. */
async function awaitChapterText(app, text) {
  await app.page.waitForFunction(
    ({ path, needle }) => {
      const leaf = window.app.workspace
        .getLeavesOfType("markdown")
        .find((l) => l.view.file?.path === path);
      return leaf?.view.editor.getValue().includes(needle) ?? false;
    },
    { path: CHAPTER, needle: text },
    { timeout: 30_000 },
  );
}

/** "offered" once the second edit's note is in the chapter, "settled" if the turn ends first. */
async function awaitSecondEditOrSettle(app) {
  const handle = await app.page.waitForFunction(
    (selector) => {
      if (document.querySelector(`${selector} .lmsa-inline-diff-note`)) return "offered";
      return window.__lmsaDriver.state().generating ? false : "settled";
    },
    EDITOR,
    { timeout: 20_000, polling: 100 },
  );
  return handle.jsonValue();
}

export default {
  id: "inline-margin-notes",
  description: "Edits on neighbouring lines, reviewed in the note: where each margin note lands.",
  vault: "writing-basic",
  theme: "dark",
  provider: { kind: "scripted", frames: "inline-review" },

  async run(app) {
    await stage(app);

    await app.send("Tighten the opening of chapter one.");
    await app.awaitCheckpoint("approval-raised");
    await measure(app, "first edit raised, chat still focused");
    await app.shot("the review in the chat", { selector: CHAT_ROOT });

    // A real click into the chapter, which is what makes it the active editor.
    await app.click(EDITOR_CONTENT);
    const overlayMs = await awaitOverlay(app);
    await measure(app, "chapter focused, usual layout with explorer and chat", { overlayMs });

    await setEditorWidth(app, EDITOR_WIDE);
    await measure(app, "chapter focused, wide editor");
    await setEditorWidth(app, EDITOR_NARROW);
    await measure(app, "chapter focused, narrow editor");
    await setEditorWidth(app, EDITOR_WIDE);

    // Accepted from the note's own button, not the composer drawer.
    await app.click(NOTE_ACCEPT);
    await awaitChapterText(app, "never locked");
    await measure(app, "right after accepting from the note");

    // The second edit in the message is either offered (a one-word change, reviewed in the
    // note like the first) or refused while the first still counts as pending. Both are
    // findings, so the walk takes whichever arrives instead of waiting on one of them.
    const next = await awaitSecondEditOrSettle(app);
    if (next === "offered") {
      await measure(app, "second edit offered, a one-word change");
      await app.click(NOTE_ACCEPT);
      await awaitChapterText(app, "twelve years");
    }
    await app.awaitCheckpoint("turn-settled");
    await measure(app, "turn settled");
    await app.shot("the settled turn", { selector: CHAT_ROOT });
  },
};
