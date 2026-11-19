import { describe, expect, it, vi } from "vitest";
import { ChatTranscript } from "../../../../src/chat/messages/ChatTranscript";
import type { ConversationMessage } from "../../../../src/shared/types";

/**
 * The in-flight draft bubble across transcript renders. A full sync can run
 * mid-generation (a model switch, a conversation renamed in the drawer), and it
 * used to orphan the draft and resurrect a regeneration's original bubble.
 *
 * The transcript is the real one. Only the DOM is faked, as a tree just deep
 * enough to tell which rows are mounted, in what order, and which are hidden.
 */

class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  parentElement = null;
  classes = new Set<string>();
  dataset: Record<string, string> = {};
  scrollTop = 0;
  scrollHeight = 100;
  clientHeight = 100;

  constructor(cls = "") {
    for (const name of cls.split(" ").filter(Boolean)) this.classes.add(name);
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
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
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
  const owner = { registerDomEvent: vi.fn(), addChild: vi.fn(), removeChild: vi.fn() };
  const transcript = new ChatTranscript(owner as never, {} as never, {
    messagesEl,
    emptyStateEl: new FakeEl(),
  } as never);

  // Bubble bodies are out of scope: each bubble is its row plus a turn view stub.
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

  const rowOf = (messageId: string) =>
    transcript.getBubbleForMessage(messageId)?.rowEl as unknown as FakeEl | undefined;
  const mountedIds = () => messagesEl.children.map((row) => row.dataset.messageId ?? "draft");

  return { transcript, messagesEl, rowOf, mountedIds };
}

const user = (id: string): ConversationMessage => ({ id, role: "user", content: id });
const assistant = (id: string): ConversationMessage => ({ id, role: "assistant", content: id });

describe("ChatTranscript draft bubble", () => {
  it("keeps a regeneration's original hidden across a mid-stream full render", async () => {
    const h = harness();
    const history = [user("u-1"), assistant("a-1")];
    await h.transcript.renderMessages(history);

    const draft = h.transcript.createDraftBubble("a-1");
    expect(h.rowOf("a-1")?.classes.has("is-superseded")).toBe(true);

    // Same ids, so this is a full render that rebuilds every row.
    await h.transcript.renderMessages(history, undefined, false);

    expect(h.rowOf("a-1")?.classes.has("is-superseded")).toBe(true);
    expect(h.messagesEl.children.at(-1)).toBe(draft.rowEl);
    expect(h.mountedIds()).toEqual(["u-1", "a-1", "draft"]);
  });

  it("reveals the rebuilt original when the draft is released", async () => {
    const h = harness();
    const history = [user("u-1"), assistant("a-1")];
    await h.transcript.renderMessages(history);
    const draft = h.transcript.createDraftBubble("a-1");
    await h.transcript.renderMessages(history, undefined, false);

    h.transcript.releaseDraft(draft);

    expect(h.rowOf("a-1")?.classes.has("is-superseded")).toBe(false);
  });

  it("removes the original on commit and ignores the release that follows", async () => {
    const h = harness();
    await h.transcript.renderMessages([user("u-1"), assistant("a-1")]);
    const draft = h.transcript.createDraftBubble("a-1");

    h.transcript.registerBubble("a-1", draft);
    expect(h.transcript.getBubbleForMessage("a-1")).toBe(draft);
    expect(h.mountedIds()).toEqual(["u-1", "a-1"]);

    // The committed answer now owns the id, so no later render may hide it.
    await h.transcript.renderMessages([user("u-1"), assistant("a-1")], undefined, false);
    expect(h.mountedIds()).toEqual(["u-1", "a-1"]);
    expect(h.rowOf("a-1")?.classes.has("is-superseded")).toBe(false);

    // The generation's `finally` still releases it, which must change nothing.
    h.transcript.releaseDraft(draft);
    expect(h.rowOf("a-1")?.classes.has("is-superseded")).toBe(false);
  });

  it("does not duplicate a send's user bubble on a mid-stream render", async () => {
    const h = harness();
    await h.transcript.renderMessages([user("u-1"), assistant("a-1")]);
    // The send flow builds the user bubble itself before the store renders it.
    h.transcript.createBubble("user", "u-2");
    const draft = h.transcript.createDraftBubble(null);

    await h.transcript.renderMessages(
      [user("u-1"), assistant("a-1"), user("u-2")],
      undefined,
      false,
    );

    expect(h.mountedIds()).toEqual(["u-1", "a-1", "u-2", "draft"]);
    expect(h.messagesEl.children.at(-1)).toBe(draft.rowEl);
  });

  it("drops the draft on a conversation switch", async () => {
    const h = harness();
    await h.transcript.renderMessages([user("u-1"), assistant("a-1")]);
    const draft = h.transcript.createDraftBubble("a-1");

    await h.transcript.renderMessages([user("other")], undefined, true);
    expect(h.mountedIds()).toEqual(["other"]);

    // Still generating in the background, the left conversation's draft must not
    // come back on the next ordinary render of this one.
    await h.transcript.renderMessages([user("other"), assistant("reply")], undefined, false);
    h.transcript.releaseDraft(draft);
    expect(h.mountedIds()).toEqual(["other", "reply"]);
  });
});
