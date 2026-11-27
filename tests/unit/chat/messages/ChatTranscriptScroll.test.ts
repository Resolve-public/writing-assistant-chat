import { describe, expect, it, vi } from "vitest";
import { ChatTranscript } from "../../../../src/chat/messages/ChatTranscript";
import type { ConversationMessage } from "../../../../src/shared/types";

/**
 * Scroll position across an in-place re-render. Editing or deleting a message
 * re-renders the whole transcript, and emptying the scroll container drops its
 * scrollTop to 0, so a reader who had scrolled up landed at the session start.
 *
 * The fake container behaves like a browser scroller: its height follows its
 * rows, and scrollTop is clamped to the scrollable range.
 */

const ROW_HEIGHT = 100;
const VIEWPORT_HEIGHT = 300;

class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  parentElement = null;
  classes = new Set<string>();
  dataset: Record<string, string> = {};
  clientHeight = VIEWPORT_HEIGHT;
  private top = 0;

  constructor(cls = "") {
    for (const name of cls.split(" ").filter(Boolean)) this.classes.add(name);
  }

  get scrollHeight(): number {
    return Math.max(this.children.length * ROW_HEIGHT, this.clientHeight);
  }

  get scrollTop(): number {
    return this.top;
  }

  set scrollTop(value: number) {
    this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
  }

  createDiv(options?: { cls?: string }): FakeEl {
    return this.appendChild(new FakeEl(options?.cls));
  }

  appendChild(el: FakeEl): FakeEl {
    el.remove();
    el.parent = this;
    this.children.push(el);
    return el;
  }

  remove(): void {
    if (!this.parent) return;
    const parent = this.parent;
    parent.children = parent.children.filter((child) => child !== this);
    this.parent = null;
    parent.scrollTop = parent.top;
  }

  empty(): void {
    for (const child of [...this.children]) child.remove();
  }

  toggleClass(name: string, on: boolean): void {
    if (on) this.classes.add(name);
    else this.classes.delete(name);
  }
}

function harness() {
  const messagesEl = new FakeEl();
  const scrollHandlers: Array<() => void> = [];
  const owner = {
    registerDomEvent: vi.fn((el: unknown, event: string, handler: () => void) => {
      if (el === messagesEl && event === "scroll") scrollHandlers.push(handler);
    }),
    addChild: vi.fn(),
    removeChild: vi.fn(),
  };
  const transcript = new ChatTranscript(owner as never, {} as never, {
    messagesEl,
    emptyStateEl: new FakeEl(),
  } as never);

  const internals = transcript as unknown as Record<string, unknown>;
  const refsFor = (role: "user" | "assistant") => (rowEl: FakeEl, columnEl: FakeEl) => ({
    role,
    rowEl,
    columnEl,
    chromeEl: columnEl,
    contentEl: columnEl,
    turnHostEl: columnEl,
    turnView: { destroy: vi.fn(), refresh: vi.fn() },
  });
  internals.createAssistantBubbleRefs = refsFor("assistant");
  internals.createUserBubbleRefs = refsFor("user");
  internals.renderMessageBody = () => Promise.resolve();

  const scrollTo = (top: number) => {
    messagesEl.scrollTop = top;
    for (const handler of scrollHandlers) handler();
  };
  return { transcript, messagesEl, scrollTo };
}

function messages(count: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `content ${i}`,
  }));
}

describe("ChatTranscript scroll across an in-place re-render", () => {
  it("keeps a reader who scrolled up where they were after an edit", async () => {
    const { transcript, messagesEl, scrollTo } = harness();
    const history = messages(10);
    await transcript.renderMessages(history, undefined, true);
    scrollTo(400);

    await transcript.renderMessages(history, undefined, false);

    expect(messagesEl.scrollTop).toBe(400);
  });

  it("keeps a reader who scrolled up near where they were after a delete", async () => {
    const { transcript, messagesEl, scrollTo } = harness();
    const history = messages(10);
    await transcript.renderMessages(history, undefined, true);
    scrollTo(200);

    await transcript.renderMessages(history.slice(0, 9), undefined, false);

    expect(messagesEl.scrollTop).toBe(200);
  });

  it("keeps a reader at the bottom at the bottom after an edit", async () => {
    const { transcript, messagesEl } = harness();
    const history = messages(10);
    await transcript.renderMessages(history, undefined, true);

    await transcript.renderMessages(history, undefined, false);

    expect(messagesEl.scrollTop).toBe(messagesEl.scrollHeight - messagesEl.clientHeight);
  });

  it("still jumps to the bottom on a conversation switch", async () => {
    const { transcript, messagesEl, scrollTo } = harness();
    await transcript.renderMessages(messages(10), undefined, true);
    scrollTo(100);

    await transcript.renderMessages(messages(12), undefined, true);

    expect(messagesEl.scrollTop).toBe(messagesEl.scrollHeight - messagesEl.clientHeight);
  });
});
