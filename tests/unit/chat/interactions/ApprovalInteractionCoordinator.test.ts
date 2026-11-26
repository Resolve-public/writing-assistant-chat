import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalInteractionCoordinator } from "../../../../src/chat/interactions/ApprovalInteractionCoordinator";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "../../../../src/chat/interactions/approvalTypes";
import type {
  ComposerInteraction,
  ComposerInteractionHostPort,
} from "../../../../src/chat/interactions/ComposerInteractionHost";

/** A single-slot host, the same contention rule the real one enforces. */
class FakeHost implements ComposerInteractionHostPort {
  active: ComposerInteraction | null = null;
  readonly mounted: ComposerInteraction[] = [];
  destroyed = false;
  mountThrows: Error | null = null;

  mount(interaction: ComposerInteraction): boolean {
    if (this.destroyed || this.active) return false;
    if (this.mountThrows) throw this.mountThrows;
    this.active = interaction;
    this.mounted.push(interaction);
    return true;
  }

  clearIfOwner(interactionId: string): void {
    if (this.active?.interactionId !== interactionId) return;
    this.active = null;
  }

  isActive(interactionId?: string): boolean {
    if (!this.active) return false;
    return interactionId === undefined || this.active.interactionId === interactionId;
  }

  destroy(): void {
    this.destroyed = true;
    const active = this.active;
    this.active = null;
    active?.onCancel();
  }

  submit(decision: ApprovalDecision): void {
    const active = this.active;
    if (!active || active.kind !== "approval") throw new Error("no approval mounted");
    active.onSubmit(decision);
  }
}

function request(approvalId: string): ApprovalRequest {
  return {
    approvalId,
    channel: "vault-op",
    toolCallId: `call-${approvalId}`,
    summary: `Overwrite Notes/${approvalId}.md`,
    detail: `Notes/${approvalId}.md`,
  };
}

let host: FakeHost;
let controller: AbortController;

function createCoordinator() {
  return new ApprovalInteractionCoordinator(host, controller.signal);
}

beforeEach(() => {
  host = new FakeHost();
  controller = new AbortController();
});

describe("ApprovalInteractionCoordinator", () => {
  it("mounts a request and reports that it was accepted", () => {
    const coordinator = createCoordinator();
    const decide = vi.fn();

    expect(coordinator.request(request("op-1"), decide, () => true)).toBe(true);
    expect(host.mounted).toHaveLength(1);
    expect(host.mounted[0]).toMatchObject({
      kind: "approval",
      interactionId: expect.any(String),
      request: request("op-1"),
    });
    expect(decide).not.toHaveBeenCalled();
  });

  // Decision 11: a busy lane refuses, it does not queue. Nothing parks, nothing is shown,
  // and the caller turns the false into a retryable precondition failure.
  it("refuses a second request while one is active, mounting nothing", () => {
    const coordinator = createCoordinator();
    const first = vi.fn();
    const second = vi.fn();

    expect(coordinator.request(request("op-1"), first, () => true)).toBe(true);
    expect(coordinator.request(request("op-2"), second, () => true)).toBe(false);

    expect(host.mounted).toHaveLength(1);
    expect(host.mounted[0].request).toEqual(request("op-1"));
    expect(second).not.toHaveBeenCalled();
  });

  // The drawer is not repainted from proposal state the way the timeline is, so a request
  // whose promise another path already settled must never be shown.
  it("refuses a request whose promise is no longer parked", () => {
    const coordinator = createCoordinator();
    const decide = vi.fn();

    expect(coordinator.request(request("op-1"), decide, () => false)).toBe(false);
    expect(host.mounted).toHaveLength(0);
    expect(decide).not.toHaveBeenCalled();

    // And the lane is left free for the next one.
    expect(coordinator.request(request("op-2"), vi.fn(), () => true)).toBe(true);
  });

  it("delivers each of the three decisions verbatim, guidance included", () => {
    const decisions: ApprovalDecision[] = [
      { kind: "approve" },
      { kind: "approve-session" },
      { kind: "decline", guidance: "put it under Drafts/ instead" },
      { kind: "decline", guidance: "" },
    ];

    for (const decision of decisions) {
      host = new FakeHost();
      const coordinator = createCoordinator();
      const decide = vi.fn();
      coordinator.request(request("op-1"), decide, () => true);

      host.submit(decision);

      expect(decide).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledWith(decision);
    }
  });

  it("clears the lane on submit, so the next request is accepted", () => {
    const coordinator = createCoordinator();
    coordinator.request(request("op-1"), vi.fn(), () => true);

    host.submit({ kind: "approve" });

    expect(host.isActive()).toBe(false);
    expect(coordinator.request(request("op-2"), vi.fn(), () => true)).toBe(true);
  });

  it("releases the lane when its approval is decided elsewhere, deciding nothing", () => {
    const coordinator = createCoordinator();
    const decide = vi.fn();
    coordinator.request(request("op-1"), decide, () => true);

    coordinator.release("op-1");

    expect(host.isActive()).toBe(false);
    expect(decide).not.toHaveBeenCalled();
    expect(coordinator.request(request("op-2"), vi.fn(), () => true)).toBe(true);
  });

  it("ignores a release for an approval the lane is not holding", () => {
    const coordinator = createCoordinator();
    coordinator.request(request("op-1"), vi.fn(), () => true);

    coordinator.release("op-2");

    expect(host.isActive()).toBe(true);
    expect(coordinator.hasPending()).toBe(true);
  });

  // A bug in one channel's decide must not wedge the lane for the other two.
  it("clears the lane even when decide throws", () => {
    const coordinator = createCoordinator();
    const decide = vi.fn(() => {
      throw new Error("channel bug");
    });
    coordinator.request(request("op-1"), decide, () => true);

    expect(() => host.submit({ kind: "approve" })).toThrow("channel bug");

    expect(host.isActive()).toBe(false);
    expect(coordinator.request(request("op-2"), vi.fn(), () => true)).toBe(true);
  });

  it("ignores a double submit", () => {
    const coordinator = createCoordinator();
    const decide = vi.fn();
    const mounted = (() => {
      coordinator.request(request("op-1"), decide, () => true);
      return host.mounted[0];
    })();

    if (mounted.kind !== "approval") throw new Error("expected an approval mount");
    mounted.onSubmit({ kind: "approve" });
    mounted.onSubmit({ kind: "decline", guidance: "changed my mind" });

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith({ kind: "approve" });
  });

  it("ignores a submit that arrives after abort", () => {
    const coordinator = createCoordinator();
    const decide = vi.fn();
    coordinator.request(request("op-1"), decide, () => true);
    const mounted = host.mounted[0];
    if (mounted.kind !== "approval") throw new Error("expected an approval mount");

    controller.abort();
    mounted.onSubmit({ kind: "approve" });

    expect(decide).not.toHaveBeenCalled();
  });

  // LiveVaultReview.cancelPending() already owns resolving every parked promise as
  // cancelled, and it is bound to the same signal. Two owners for one settlement is how
  // double-resolve bugs start, so the coordinator only clears the drawer.
  it("clears the drawer on abort and resolves nothing", () => {
    const coordinator = createCoordinator();
    const decide = vi.fn();
    coordinator.request(request("op-1"), decide, () => true);

    controller.abort();

    expect(host.isActive()).toBe(false);
    expect(decide).not.toHaveBeenCalled();
  });

  it("refuses every request raised after abort", () => {
    const coordinator = createCoordinator();
    controller.abort();

    expect(coordinator.request(request("op-1"), vi.fn(), () => true)).toBe(false);
    expect(host.mounted).toHaveLength(0);
  });

  it("refuses every request raised after destroy", () => {
    const coordinator = createCoordinator();
    coordinator.destroy();

    expect(coordinator.request(request("op-1"), vi.fn(), () => true)).toBe(false);
    expect(host.mounted).toHaveLength(0);
  });

  it("destroys idempotently, clearing the drawer and releasing the abort listener", () => {
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const coordinator = createCoordinator();
    const decide = vi.fn();
    coordinator.request(request("op-1"), decide, () => true);

    coordinator.destroy();
    coordinator.destroy();

    expect(host.isActive()).toBe(false);
    expect(decide).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    // Aborting after destroy must not reach back into a released coordinator.
    expect(() => controller.abort()).not.toThrow();
  });

  it("refuses when the host itself rejects the mount, and stays usable", () => {
    const coordinator = createCoordinator();
    // Someone else (an ask_user) already holds the single slot.
    host.active = {
      kind: "ask",
      interactionId: "ask-1",
      request: { questions: [] } as never,
      onSubmit: () => undefined,
      onCancel: () => undefined,
    };

    expect(coordinator.request(request("op-1"), vi.fn(), () => true)).toBe(false);

    host.active = null;
    expect(coordinator.request(request("op-2"), vi.fn(), () => true)).toBe(true);
  });

  it("refuses and stays usable when the host throws on mount", () => {
    const coordinator = createCoordinator();
    host.mountThrows = new Error("render failed");

    expect(coordinator.request(request("op-1"), vi.fn(), () => true)).toBe(false);

    host.mountThrows = null;
    expect(coordinator.request(request("op-2"), vi.fn(), () => true)).toBe(true);
  });

  it("clears the drawer when the host cancels the active interaction", () => {
    const coordinator = createCoordinator();
    const decide = vi.fn();
    coordinator.request(request("op-1"), decide, () => true);

    host.destroy();

    expect(decide).not.toHaveBeenCalled();
    expect(coordinator.hasPending()).toBe(false);
  });
});
