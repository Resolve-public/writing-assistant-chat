import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AskAnswers, ValidatedAskRequest } from "../../../../src/tools/ask/types";

const formCapture = vi.hoisted(() => ({
  instances: [] as Array<{
    kind: string;
    disabled: number;
    destroyed: number;
  }>,
}));

vi.mock("../../../../src/chat/composer/AskQuestionForm", () => ({
  AskQuestionForm: class {
    kind = "ask";
    disabled = 0;
    destroyed = 0;

    constructor() {
      formCapture.instances.push(this);
    }

    disable(): void {
      this.disabled++;
    }

    destroy(): void {
      this.destroyed++;
    }
  },
}));

vi.mock("../../../../src/chat/composer/ApprovalForm", () => ({
  ApprovalForm: class {
    kind = "approval";
    disabled = 0;
    destroyed = 0;

    constructor() {
      formCapture.instances.push(this);
    }

    disable(): void {
      this.disabled++;
    }

    destroy(): void {
      this.destroyed++;
    }
  },
}));

import {
  ComposerInteractionHost,
  type ComposerInteraction,
} from "../../../../src/chat/interactions/ComposerInteractionHost";
import type { ApprovalRequest } from "../../../../src/chat/interactions/approvalTypes";

class FakeElement {
  hidden = false;
  isConnected = true;
  value = "Draft text stays mounted.";
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  emptyCalls = 0;
  focusCalls = 0;

  toggleClass(name: string, active: boolean): void {
    if (active) this.classes.add(name);
    else this.classes.delete(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  empty(): void {
    this.emptyCalls++;
  }

  focus(): void {
    this.focusCalls++;
  }
}

const REQUEST: ValidatedAskRequest = {
  questions: [{
    question: "Which direction?",
    header: "Direction",
    options: [
      { label: "North", description: "Take the northern route." },
      { label: "South", description: "Take the southern route." },
    ],
    multiSelect: false,
  }],
};

const APPROVAL: ApprovalRequest = {
  approvalId: "op-1",
  channel: "vault-op",
  toolCallId: "call-1",
  summary: "Overwrite Notes/Draft.md",
  detail: "Notes/Draft.md",
};

function interaction(
  id: string,
  onCancel: () => void = () => undefined,
): ComposerInteraction {
  return {
    kind: "ask",
    interactionId: id,
    request: REQUEST,
    onSubmit: (_answers: AskAnswers) => undefined,
    onCancel,
  };
}

function approvalInteraction(
  id: string,
  onCancel: () => void = () => undefined,
): ComposerInteraction {
  return {
    kind: "approval",
    interactionId: id,
    request: APPROVAL,
    onSubmit: () => undefined,
    onCancel,
  };
}

function createHost() {
  const refs = {
    composerPanelEl: new FakeElement(),
    composerNormalBodyEl: new FakeElement(),
    composerInteractionEl: new FakeElement(),
    composerFooterEl: new FakeElement(),
    textareaEl: new FakeElement(),
    actionBtn: new FakeElement(),
  };
  return {
    host: new ComposerInteractionHost(refs as never, { onOpenNote: () => undefined }),
    refs,
  };
}

beforeEach(() => {
  formCapture.instances = [];
});

describe("ComposerInteractionHost", () => {
  it("owns one interaction, toggles semantic state, and rejects replacement", () => {
    const { host, refs } = createHost();

    expect(host.mount(interaction("ask-1"))).toBe(true);
    expect(host.mount(interaction("ask-2"))).toBe(false);
    expect(host.isActive()).toBe(true);
    expect(host.isActive("ask-1")).toBe(true);
    expect(refs.composerPanelEl.classes.has("is-interacting")).toBe(true);
    expect(refs.composerPanelEl.classes.has("is-ask-interaction")).toBe(true);
    expect(refs.composerNormalBodyEl.hidden).toBe(false);
    expect(refs.composerNormalBodyEl.attributes.get("aria-hidden")).toBe("true");
    expect(refs.composerNormalBodyEl.attributes.has("inert")).toBe(true);
    expect(refs.composerInteractionEl.hidden).toBe(false);
    expect(refs.composerInteractionEl.attributes.get("aria-hidden")).toBe("false");
    expect(formCapture.instances).toHaveLength(1);
  });

  it("clears only for the owner, disables the form, and restores action focus", () => {
    const { host, refs } = createHost();
    host.mount(interaction("ask-1"));

    host.clearIfOwner("ask-2");
    expect(host.isActive("ask-1")).toBe(true);

    host.clearIfOwner("ask-1");
    expect(host.isActive()).toBe(false);
    expect(formCapture.instances[0]).toMatchObject({ disabled: 1, destroyed: 1 });
    expect(refs.composerNormalBodyEl.hidden).toBe(false);
    expect(refs.composerNormalBodyEl.attributes.get("aria-hidden")).toBe("false");
    expect(refs.composerNormalBodyEl.attributes.has("inert")).toBe(false);
    expect(refs.composerInteractionEl.hidden).toBe(true);
    expect(refs.composerInteractionEl.emptyCalls).toBe(1);
    expect(refs.actionBtn.focusCalls).toBe(1);
    expect(refs.textareaEl.value).toBe("Draft text stays mounted.");
  });

  it("destroys idempotently and refuses later mounts", () => {
    const { host } = createHost();
    const onCancel = vi.fn();
    host.mount(interaction("ask-1", onCancel));

    host.destroy();
    host.destroy();

    expect(formCapture.instances[0]).toMatchObject({ disabled: 1, destroyed: 1 });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(host.isActive()).toBe(false);
    expect(host.mount(interaction("ask-2"))).toBe(false);
  });

  // RFC-0012 widens the union to a second kind. The slot stays single.
  it("constructs the approval form for kind: approval and marks the panel", () => {
    const { host, refs } = createHost();

    expect(host.mount(approvalInteraction("approval-1"))).toBe(true);
    expect(formCapture.instances).toHaveLength(1);
    expect(formCapture.instances[0].kind).toBe("approval");
    expect(refs.composerPanelEl.classes.has("is-interacting")).toBe(true);
    expect(refs.composerPanelEl.classes.has("is-approval-interaction")).toBe(true);
    // The ask rules keep their current meaning: an approval is not an ask.
    expect(refs.composerPanelEl.classes.has("is-ask-interaction")).toBe(false);
  });

  it("stays single-slot across kinds, in both directions", () => {
    const { host } = createHost();
    host.mount(approvalInteraction("approval-1"));

    expect(host.mount(interaction("ask-1"))).toBe(false);
    expect(host.mount(approvalInteraction("approval-2"))).toBe(false);
    expect(formCapture.instances).toHaveLength(1);

    host.clearIfOwner("approval-1");
    expect(host.mount(interaction("ask-1"))).toBe(true);
    expect(formCapture.instances[1].kind).toBe("ask");
  });

  it("clears the approval state classes when the interaction ends", () => {
    const { host, refs } = createHost();
    host.mount(approvalInteraction("approval-1"));

    host.clearIfOwner("approval-1");

    expect(refs.composerPanelEl.classes.has("is-approval-interaction")).toBe(false);
    expect(refs.composerPanelEl.classes.has("is-interacting")).toBe(false);
    expect(refs.composerInteractionEl.hidden).toBe(true);
  });

  it("cancels an active approval on destroy", () => {
    const { host } = createHost();
    const onCancel = vi.fn();
    host.mount(approvalInteraction("approval-1", onCancel));

    host.destroy();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(formCapture.instances[0]).toMatchObject({ disabled: 1, destroyed: 1 });
  });
});
