import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatTranscript } from "../../../../src/chat/messages/ChatTranscript";

type ResizeCallback = () => void;

/**
 * Stands in for the browser observers Node lacks. Captures the transcript's resize
 * callback so a test can play a reflow: change scrollHeight, then fire it.
 */
function stubObservers(): { fireResize: ResizeCallback } {
  let resizeCallback: ResizeCallback | null = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeCallback) {
        resizeCallback = callback;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  return {
    fireResize: () => {
      if (!resizeCallback) throw new Error("transcript never observed resizes");
      resizeCallback();
    },
  };
}

function makeTranscript(): {
  messagesEl: { scrollTop: number; scrollHeight: number; clientHeight: number };
  onScroll: () => void;
} {
  let onScroll: (() => void) | null = null;
  const owner = {
    registerDomEvent: vi.fn((_el: unknown, type: string, handler: () => void) => {
      if (type === "scroll") onScroll = handler;
    }),
    register: vi.fn(),
    addChild: vi.fn(),
    removeChild: vi.fn(),
  };
  const messagesEl = { scrollTop: 0, scrollHeight: 400, clientHeight: 400, children: [] };
  new ChatTranscript(owner as never, {} as never, {
    messagesEl,
    emptyStateEl: {},
  } as never);
  return {
    messagesEl,
    onScroll: () => {
      if (!onScroll) throw new Error("no scroll listener");
      onScroll();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatTranscript bottom following", () => {
  test("a reader at the bottom stays there when content grows later", () => {
    const { fireResize } = stubObservers();
    const { messagesEl } = makeTranscript();

    // Markdown finishes rendering, or a cancelled edit shows taller prose.
    messagesEl.scrollHeight = 900;
    fireResize();

    expect(messagesEl.scrollTop).toBe(900);
  });

  test("a reader who scrolled up is left where they are", () => {
    const { fireResize } = stubObservers();
    const { messagesEl, onScroll } = makeTranscript();

    messagesEl.scrollHeight = 2000;
    messagesEl.scrollTop = 300;
    onScroll();

    messagesEl.scrollHeight = 2600;
    fireResize();

    expect(messagesEl.scrollTop).toBe(300);
  });
});
