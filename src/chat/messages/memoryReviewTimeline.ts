import type { MemoryMutation } from "../../tools/memory/handlers";
import type { ToolCall } from "../../tools/types";
import type { Memory } from "../../shared/types";
import { TOOL_LABELS, pendingToolLabel } from "../../tools/metadata";
import { resolveVaultReviewMounts } from "./vaultReviewTimeline";

export type MemoryReviewStatus = "pending" | "applied" | "declined" | "failed";

export interface ReviewableMemoryProposal {
  id: string;
  sourceToolCallId: string;
  call: ToolCall;
  mutation: MemoryMutation;
  status: MemoryReviewStatus;
  error?: string;
  effect?: {
    before: Memory | null;
    after: Memory | null;
    appliedAt: number;
  };
}

export interface MemoryReviewTimelineOptions {
  timelineEl: HTMLElement;
  /** Canonical placement by exact declaration identity (ADR-0031). */
  findActionHostByToolCallId?: (toolCallId: string) => HTMLElement | null;
  proposals: ReviewableMemoryProposal[];
}

const STATE_CLASSES = [
  "is-vault-awaiting",
  "is-vault-applied",
  "is-vault-failed",
  "is-vault-rejected",
];

/**
 * Folds transient memory proposals onto their existing agentic timeline steps.
 * Cancelled proposals are removed by the coordinator and never appear here again.
 */
export class MemoryReviewTimelineView {
  constructor(private readonly opts: MemoryReviewTimelineOptions) {
    this.cleanPriorDecorations();
    this.paint();
  }

  private cleanPriorDecorations(): void {
    const timeline = this.opts.timelineEl;
    timeline.querySelectorAll(".lmsa-memory-step-controls").forEach((element) => {
      element
        .closest(".lmsa-agentic-timeline-step, .lmsa-assistant-turn-item")
        ?.classList.remove(...STATE_CLASSES);
      element.remove();
    });
    // A forget's reason stands alone on the step rather than inside a preview.
    timeline
      .querySelectorAll(".lmsa-memory-review-preview, .lmsa-memory-review-why")
      .forEach((element) => element.remove());
  }

  private paint(): void {
    for (const proposal of this.opts.proposals) {
      const step = this.locateStep(proposal);
      if (step) this.decorateStep(step, proposal);
    }
  }

  private locateStep(
    proposal: ReviewableMemoryProposal,
  ): HTMLElement | null {
    if (this.opts.findActionHostByToolCallId) {
      const host = this.opts.findActionHostByToolCallId(
        proposal.sourceToolCallId,
      );
      if (!host) {
        throw new Error(
          "No assistant turn action host exists for memory call " +
            `"${proposal.sourceToolCallId}".`,
        );
      }
      return host;
    }
    return this.opts.timelineEl.querySelector<HTMLElement>(
      `[data-tool-call-id="${CSS.escape(proposal.sourceToolCallId)}"]`,
    );
  }

  private decorateStep(
    step: HTMLElement,
    proposal: ReviewableMemoryProposal,
  ): void {
    // The same mounts the vault review uses: on the canonical turn the located
    // host is the inline action slot, which holds the state label only, while the
    // preview needs the whole step body to wrap onto its own row.
    const { stateEl, labelHostEl, controlsHostEl, presentationHostEl } =
      resolveVaultReviewMounts(step);
    stateEl.classList.remove(...STATE_CLASSES);
    stateEl.classList.add(statusClass(proposal.status));
    presentationHostEl
      .querySelector(":scope > .lmsa-agentic-timeline-step-failed")
      ?.remove();
    this.relabel(labelHostEl, proposal);

    const controls = controlsHostEl.createDiv({
      cls: "lmsa-memory-step-controls",
    });
    controls.addEventListener("click", (event) => event.stopPropagation());
    this.renderControls(controls, proposal);
    const previewEl = this.renderPreview(presentationHostEl, proposal);
    if (previewEl && presentationHostEl !== controlsHostEl) {
      controlsHostEl.after(previewEl);
    }
  }

  private relabel(
    body: HTMLElement,
    proposal: ReviewableMemoryProposal,
  ): void {
    const toolName =
      proposal.mutation.kind === "add" ? "add_memory" : "forget_memory";
    const name = memoryName(proposal.mutation);
    const nameElement = body.querySelector<HTMLElement>(
      ":scope > .lmsa-agentic-timeline-step-name",
    );
    if (nameElement) {
      nameElement.textContent =
        proposal.status === "applied"
          ? TOOL_LABELS[toolName] ?? toolName
          : pendingToolLabel(toolName);
    }
    let detail = body.querySelector<HTMLElement>(
      ":scope > .lmsa-agentic-timeline-step-detail",
    );
    if (!detail) {
      detail = body.createSpan({
        cls: "lmsa-agentic-timeline-step-detail",
      });
      if (nameElement) body.insertBefore(detail, nameElement.nextSibling);
    }
    detail.textContent =
      proposal.mutation.kind === "add"
        ? `${name}: ${proposal.mutation.memory.type}`
        : name;
  }

  private renderControls(
    controls: HTMLElement,
    proposal: ReviewableMemoryProposal,
  ): void {
    if (proposal.status === "pending") {
      // The decision is made in the composer drawer while the generation is live
      // (RFC-0012); the timeline is the record, so this is a status label. The memory
      // preview beneath it stays, because that is the evidence.
      controls.createSpan({
        cls: "lmsa-vault-step-pending",
        text: "pending approval",
      });
      return;
    }

    const text =
      proposal.status === "applied"
        ? "Applied"
        : proposal.status === "declined"
          ? "Declined"
          : "Failed";
    controls.createSpan({
      cls:
        proposal.status === "failed"
          ? "lmsa-vault-step-state is-error"
          : "lmsa-vault-step-state",
      text,
    });
  }

  private renderPreview(
    body: HTMLElement,
    proposal: ReviewableMemoryProposal,
  ): HTMLElement | null {
    const explanation = proposal.mutation.explanation;
    if (proposal.mutation.kind !== "add") {
      // A forget carries no record to preview, so its reason is the whole preview.
      return explanation ? this.renderExplanation(body, explanation) : null;
    }
    const memory = proposal.mutation.memory;
    const preview = body.createDiv({
      cls: "lmsa-vault-timeline-preview lmsa-memory-review-preview",
    });
    preview.addEventListener("click", (event) => event.stopPropagation());
    preview.createEl("pre", {
      cls: "lmsa-agentic-timeline-arg-value",
      text: memory.description,
    });
    if (explanation) this.renderExplanation(preview, explanation);
    if (memory.content) {
      const details = preview.createEl("details", {
        cls: "lmsa-vault-replace-files",
      });
      details.createEl("summary", {
        cls: "lmsa-vault-replace-files-summary",
        text: "Content preview",
      });
      details.createEl("pre", {
        cls: "lmsa-agentic-timeline-arg-value",
        text: memory.content,
      });
    }
    return preview;
  }

  /**
   * The model's stated reason for the proposal, under the record rather than over it:
   * the description and body are the evidence, this is the claim about it. Mirrors how
   * an edit tool's `explanation` reaches the reviewer on its own step.
   */
  private renderExplanation(parent: HTMLElement, explanation: string): HTMLElement {
    const el = parent.createDiv({
      cls: "lmsa-memory-review-why",
      text: explanation,
    });
    el.addEventListener("click", (event) => event.stopPropagation());
    return el;
  }
}

function memoryName(mutation: MemoryMutation): string {
  return mutation.kind === "add" ? mutation.memory.name : mutation.name;
}

function statusClass(status: MemoryReviewStatus): string {
  switch (status) {
    case "pending":
      return "is-vault-awaiting";
    case "applied":
      return "is-vault-applied";
    case "declined":
      return "is-vault-rejected";
    case "failed":
      return "is-vault-failed";
  }
}
