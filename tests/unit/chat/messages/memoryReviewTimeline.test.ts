import { describe, expect, it } from "vitest";
import {
  MemoryReviewTimelineView,
  type ReviewableMemoryProposal,
} from "../../../../src/chat/messages/memoryReviewTimeline";

/**
 * Just enough of the DOM, plus Obsidian's create helpers, to run the memory review
 * against the canonical assistant turn's step shape. Selectors are single classes,
 * optionally `:scope > ` scoped or comma-separated, which is all the review uses.
 */
class FakeElement {
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly classList: { add: (...c: string[]) => void; remove: (...c: string[]) => void };
  private readonly classes = new Set<string>();
  textContent = "";

  constructor(cls = "", text = "") {
    for (const name of cls.split(" ").filter(Boolean)) this.classes.add(name);
    this.textContent = text;
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
    };
  }

  hasClass(name: string): boolean {
    return this.classes.has(name);
  }

  get nextSibling(): FakeElement | null {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  matches(selector: string): boolean {
    return selector
      .split(",")
      .some((part) => this.classes.has(part.trim().replace(/^\./, "")));
  }

  closest(selector: string): FakeElement | null {
    for (let el: FakeElement | null = this; el; el = el.parentElement) {
      if (el.matches(selector)) return el;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const direct = selector.startsWith(":scope > ");
    const target = selector.replace(":scope > ", "");
    const found: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (child.matches(target)) found.push(child);
        if (!direct) walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  createDiv(options: { cls?: string; text?: string } = {}): FakeElement {
    return this.append(new FakeElement(options.cls, options.text));
  }

  createSpan(options: { cls?: string; text?: string } = {}): FakeElement {
    return this.createDiv(options);
  }

  createEl(_tag: string, options: { cls?: string; text?: string } = {}): FakeElement {
    return this.createDiv(options);
  }

  insertBefore(el: FakeElement, ref: FakeElement | null): void {
    el.detach();
    el.parentElement = this;
    const index = ref === null ? -1 : this.children.indexOf(ref);
    this.children.splice(index < 0 ? this.children.length : index, 0, el);
  }

  after(el: FakeElement): void {
    this.parentElement?.insertBefore(el, this.nextSibling);
  }

  remove(): void {
    this.detach();
  }

  addEventListener(): void {}

  private append(el: FakeElement): FakeElement {
    this.insertBefore(el, null);
    return el;
  }

  private detach(): void {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
}

/** The step `AssistantTurnView` builds: item, body, summary(name, detail), action host. */
function canonicalStep() {
  const timeline = new FakeElement("lmsa-assistant-turn-list");
  const item = timeline.createDiv({ cls: "lmsa-assistant-turn-item" });
  const body = item.createDiv({
    cls: "lmsa-assistant-turn-item-body lmsa-agentic-timeline-step-body",
  });
  const summary = body.createSpan({ cls: "lmsa-assistant-turn-tool-summary" });
  summary.createSpan({ cls: "lmsa-agentic-timeline-step-name", text: "Added memory" });
  summary.createSpan({ cls: "lmsa-agentic-timeline-step-detail", text: "hold-rulings" });
  const actionHost = body.createDiv({ cls: "lmsa-assistant-turn-action-host" });
  return { timeline, item, body, summary, actionHost };
}

const PROPOSAL: ReviewableMemoryProposal = {
  id: "proposal-1",
  sourceToolCallId: "toolu_memory",
  call: { id: "toolu_memory", name: "add_memory", arguments: {} },
  mutation: {
    kind: "add",
    memory: {
      name: "hold-rulings",
      type: "rule",
      description: "Read the conversation for intent, hold rulings literally.",
      content: "In conversation the user's words point at something.",
      enabled: true,
    },
  },
  status: "applied",
};

function paint(step: ReturnType<typeof canonicalStep>): void {
  new MemoryReviewTimelineView({
    timelineEl: step.timeline as unknown as HTMLElement,
    findActionHostByToolCallId: () => step.actionHost as unknown as HTMLElement,
    proposals: [PROPOSAL],
  });
}

describe("memory review on the canonical assistant turn", () => {
  it("relabels the summary's own detail instead of adding a second one", () => {
    const step = canonicalStep();
    paint(step);

    const details = step.item.querySelectorAll(".lmsa-agentic-timeline-step-detail");
    expect(details).toHaveLength(1);
    expect(details[0]?.textContent).toBe("hold-rulings: rule");
  });

  it("keeps only the state label in the inline action host", () => {
    const step = canonicalStep();
    paint(step);

    expect(step.actionHost.children.map((child) => child.matches(".lmsa-memory-step-controls")))
      .toEqual([true]);
  });

  it("mounts the preview as a full-width row of the step body, after the action host", () => {
    const step = canonicalStep();
    paint(step);

    const preview = step.item.querySelector(".lmsa-memory-review-preview");
    expect(preview?.parentElement).toBe(step.body);
    expect(step.actionHost.nextSibling).toBe(preview);
  });

  it("puts the status class on the turn item, where the marker reads it", () => {
    const step = canonicalStep();
    paint(step);

    expect(step.item.hasClass("is-vault-applied")).toBe(true);
  });

  it("does not stack decorations when a later view repaints the same step", () => {
    const step = canonicalStep();
    paint(step);
    paint(step);

    expect(step.item.querySelectorAll(".lmsa-memory-step-controls")).toHaveLength(1);
    expect(step.item.querySelectorAll(".lmsa-memory-review-preview")).toHaveLength(1);
  });
});
