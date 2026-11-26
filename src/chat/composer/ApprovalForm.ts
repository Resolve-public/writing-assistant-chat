import { setIcon } from "obsidian";

import { splitSummaryAtTarget } from "../interactions/approvalRequests";
import type {
  ApprovalChannel,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalTarget,
} from "../interactions/approvalTypes";
import {
  buildApprovalDecision,
  createApprovalDecisionState,
  reduceApprovalDecisionState,
} from "./approvalDecisionState";
import type {
  ApprovalChoice,
  ApprovalDecisionState,
} from "./approvalDecisionState";

export interface ApprovalFormDependencies {
  interactionId: string;
  request: ApprovalRequest;
}

export interface ApprovalFormRefs {
  containerEl: HTMLElement;
}

export interface ApprovalFormCallbacks {
  onSubmit: (decision: ApprovalDecision) => void;
  /** Open the request's target note. Mod-click semantics are the opener's to read. */
  onOpenTarget: (target: ApprovalTarget, event: MouseEvent) => void;
}

/** What kind of change is waiting. Shapes the eyebrow wording only, never policy. */
const CHANNEL_LABELS: Record<ApprovalChannel, string> = {
  "vault-op": "Vault change",
  edit: "Document edit",
  memory: "Memory",
};

interface ChoiceCopy {
  choice: ApprovalChoice;
  label: string;
  description: string;
}

/**
 * The three choices, in the order they are offered.
 *
 * The session line says what it actually does. Under the `auto` posture `resolveGate`
 * returns `auto` unconditionally, which overrides the per-class gate (including a class
 * set to Deny), the folder scopes, and the auto-op circuit breaker, and it takes effect
 * from this click to the end of the turn. A blanket approval that quietly excluded some
 * classes would be the worse lie; the mitigation is honest copy plus the reversible
 * posture pill, not a silent exclusion. "Deny" and "Edit automatically" are the words the
 * vault-ops settings and the composer's posture pill actually show, so the copy names
 * states the user can go and look at.
 */
const CHOICES: ChoiceCopy[] = [
  {
    choice: "approve",
    label: "Approve",
    description: "Apply this change now.",
  },
  {
    choice: "approve-session",
    label: "Approve everything this session",
    description:
      "Apply this and everything after it, even kinds set to Deny. Switches to Edit automatically.",
  },
  {
    choice: "decline",
    label: "Other",
    description: "Tell the model what to do instead.",
  },
];

interface ListenerRegistration {
  target: EventTarget;
  type: string;
  listener: EventListener;
}

interface ChoiceRefs {
  choice: ApprovalChoice;
  rowEl: HTMLElement;
  input: HTMLInputElement;
}

let nextFormId = 0;

/**
 * The live approval drawer form (RFC-0012). One pending decision, three choices, and an
 * optional free-text guidance field on the decline path.
 *
 * Deliberately not a review surface: no diffs, no hunk navigation, no op detail beyond
 * the derived summary and detail lines, and no navigation back to the timeline. The
 * evidence stays on the timeline, which renders it correctly at a width the composer
 * does not have. The target note's path is a link that opens the note, like a diff
 * card's file name, because the drawer floats over whatever would otherwise show it.
 *
 * There is no error slot. Submitting settles the interaction unconditionally, so the
 * form has nothing left to report; a failed apply is reported to the model as a failure
 * and the retry lives on the durable ledger after the turn.
 */
export class ApprovalForm {
  private readonly formId: string;
  private readonly formEl: HTMLFormElement;
  private readonly bodyEl: HTMLElement;
  private readonly collapseButton: HTMLButtonElement;
  private readonly submitButton: HTMLButtonElement;
  private readonly choiceRefs: ChoiceRefs[] = [];
  private readonly guidanceWrapEl: HTMLElement;
  private readonly guidanceEl: HTMLTextAreaElement;
  private readonly controls: Array<
    HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement
  > = [];
  private readonly listeners: ListenerRegistration[] = [];
  private state: ApprovalDecisionState;
  private disabled = false;
  private destroyed = false;
  private collapsed = false;

  constructor(
    private readonly dependencies: ApprovalFormDependencies,
    private readonly refs: ApprovalFormRefs,
    private readonly callbacks: ApprovalFormCallbacks,
  ) {
    this.formId = `lmsa-approval-form-${++nextFormId}`;
    this.state = createApprovalDecisionState();

    const formEl = this.refs.containerEl.createEl("form", {
      cls: "lmsa-approval-form lmsa-interaction-form",
      attr: { novalidate: "true" },
    });
    this.formEl = formEl;
    const bodyId = `${this.formId}-body`;
    this.collapseButton = this.renderToolbar(formEl, bodyId);
    this.bodyEl = formEl.createDiv({
      cls: "lmsa-interaction-body",
      attr: { id: bodyId },
    });
    const fieldsetEl = this.bodyEl.createEl("fieldset", {
      cls: "lmsa-approval-form-decision",
    });
    this.renderLegend(fieldsetEl);
    const optionsEl = fieldsetEl.createDiv({ cls: "lmsa-interaction-options" });
    for (const copy of CHOICES) {
      if (copy.choice === "decline") continue;
      this.choiceRefs.push(this.renderChoice(optionsEl, copy));
    }
    const other = this.renderOther(optionsEl);
    this.choiceRefs.push(other.refs);
    this.guidanceWrapEl = other.wrapEl;
    this.guidanceEl = other.textarea;
    this.submitButton = this.renderSubmit(this.bodyEl);

    this.listen(this.formEl, "submit", (event) => this.onSubmit(event));
    this.refresh();
    this.choiceRefs[0]?.input.focus();
  }

  disable(): void {
    if (this.disabled) return;
    this.disabled = true;
    for (const control of this.controls) control.disabled = true;
    this.formEl.setAttribute("aria-busy", "true");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disable();
    for (const { target, type, listener } of this.listeners) {
      target.removeEventListener(type, listener);
    }
    this.listeners.length = 0;
    this.refs.containerEl.removeClass("is-collapsed");
    this.formEl.remove();
  }

  /**
   * The toolbar is what survives a collapse, so it carries the eyebrow: minimized, the
   * drawer still says which channel is waiting and why it is there. The chevron itself
   * is the same control the ask form uses, because the drawer floats over the transcript
   * and either kind has to be able to get out of the way.
   */
  private renderToolbar(
    formEl: HTMLFormElement,
    bodyId: string,
  ): HTMLButtonElement {
    const toolbarEl = formEl.createDiv({ cls: "lmsa-interaction-toolbar" });
    toolbarEl.createSpan({
      cls: "lmsa-approval-form-eyebrow",
      text: `${CHANNEL_LABELS[this.dependencies.request.channel]}, waiting for you`,
    });
    const collapseButton = toolbarEl.createEl("button", {
      cls: "lmsa-interaction-collapse",
      attr: {
        type: "button",
        "aria-label": "Minimize approval",
        "aria-controls": bodyId,
        "aria-expanded": "true",
      },
    });
    setIcon(collapseButton, "chevron-down");
    this.controls.push(collapseButton);
    this.listen(collapseButton, "click", () => {
      this.setCollapsed(!this.collapsed);
    });
    return collapseButton;
  }

  /**
   * The legend names the group for assistive technology and carries the derived
   * summary, so the fieldset's accessible name is the change itself rather than a
   * generic "Approval". `detail` is a second muted line when the channel supplied one.
   */
  private renderLegend(fieldsetEl: HTMLFieldSetElement): void {
    const request = this.dependencies.request;
    const legendEl = fieldsetEl.createEl("legend", {
      cls: "lmsa-approval-form-legend",
    });
    const summaryEl = legendEl.createSpan({ cls: "lmsa-approval-form-summary" });
    if (request.target) {
      this.renderTargetSummary(summaryEl, request.summary, request.target);
    } else {
      summaryEl.setText(request.summary);
    }
    if (request.detail) {
      legendEl.createSpan({
        cls: "lmsa-approval-form-detail",
        text: request.detail,
      });
    }
  }

  /**
   * The summary with its target path as an internal link. Opening a note decides
   * nothing, so the link stays live after the form is disabled.
   */
  private renderTargetSummary(
    summaryEl: HTMLElement,
    summary: string,
    target: ApprovalTarget,
  ): void {
    const parts = splitSummaryAtTarget(summary, target.path);
    if (parts.before) summaryEl.appendText(parts.before);
    const linkEl = summaryEl.createEl("a", {
      cls: "lmsa-approval-form-target internal-link",
      text: parts.link,
      attr: {
        href: "#",
        "aria-label":
          target.line === undefined
            ? `Open ${target.path}`
            : `Open ${target.path} at line ${target.line}`,
      },
    });
    this.listen(linkEl, "click", (event) => {
      event.preventDefault();
      this.callbacks.onOpenTarget(target, event as MouseEvent);
    });
    if (parts.after) summaryEl.appendText(parts.after);
  }

  /** Minimize the decision out of the way, and bring it back. Mirrors the ask form. */
  private setCollapsed(collapsed: boolean): void {
    if (this.disabled || this.collapsed === collapsed) return;
    this.collapsed = collapsed;
    this.bodyEl.inert = collapsed;
    this.bodyEl.setAttribute("aria-hidden", collapsed ? "true" : "false");
    this.formEl.toggleClass("is-collapsed", collapsed);
    this.refs.containerEl.toggleClass("is-collapsed", collapsed);
    this.collapseButton.setAttribute(
      "aria-label",
      collapsed ? "Expand approval" : "Minimize approval",
    );
    this.collapseButton.setAttribute(
      "aria-expanded",
      collapsed ? "false" : "true",
    );
    this.collapseButton.empty();
    setIcon(this.collapseButton, collapsed ? "chevron-up" : "chevron-down");
  }

  private renderChoice(
    containerEl: HTMLElement,
    copy: ChoiceCopy,
  ): ChoiceRefs {
    const inputId = `${this.formId}-${copy.choice}`;
    const descriptionId = `${inputId}-description`;
    const rowEl = containerEl.createDiv({ cls: "lmsa-interaction-option" });
    const input = rowEl.createEl("input", {
      cls: "lmsa-interaction-option-input",
      attr: {
        type: "radio",
        id: inputId,
        name: `${this.formId}-choice`,
        "aria-describedby": descriptionId,
      },
    });
    const labelEl = rowEl.createEl("label", {
      cls: "lmsa-interaction-option-label",
      attr: { for: inputId },
    });
    labelEl.createSpan({
      cls: "lmsa-interaction-option-name",
      text: copy.label,
    });
    labelEl.createSpan({
      cls: "lmsa-interaction-option-description",
      text: copy.description,
      attr: { id: descriptionId },
    });
    this.controls.push(input);
    this.listen(input, "change", () => {
      if (!input.checked) return;
      this.state = reduceApprovalDecisionState(this.state, {
        type: "set-choice",
        choice: copy.choice,
      });
      this.refresh();
    });
    return { choice: copy.choice, rowEl, input };
  }

  /** The decline row, whose selection expands the optional guidance field. */
  private renderOther(containerEl: HTMLElement): {
    refs: ChoiceRefs;
    wrapEl: HTMLElement;
    textarea: HTMLTextAreaElement;
  } {
    const copy = CHOICES[CHOICES.length - 1];
    const refs = this.renderChoice(containerEl, copy);
    refs.rowEl.addClass("lmsa-interaction-other-option");

    const wrapEl = refs.rowEl.createDiv({ cls: "lmsa-interaction-other-text" });
    wrapEl.hidden = true;
    const textarea = wrapEl.createEl("textarea", {
      cls: "lmsa-interaction-other-textarea",
      attr: {
        id: `${this.formId}-guidance`,
        "aria-label": "Guidance for the model",
        rows: "3",
        placeholder: "Optional: what should it do instead?",
      },
    });
    this.controls.push(textarea);
    this.listen(textarea, "input", () => {
      this.state = reduceApprovalDecisionState(this.state, {
        type: "set-guidance",
        text: textarea.value,
      });
      this.refresh();
    });
    this.listen(refs.input, "change", () => {
      if (refs.input.checked) textarea.focus();
    });
    return { refs, wrapEl, textarea };
  }

  private renderSubmit(containerEl: HTMLElement): HTMLButtonElement {
    const actionsEl = containerEl.createDiv({
      cls: "lmsa-approval-form-actions",
    });
    const submitButton = actionsEl.createEl("button", {
      cls: "lmsa-ui-btn lmsa-ui-btn-primary lmsa-approval-form-submit",
      text: "Submit decision",
      attr: { type: "submit" },
    });
    this.controls.push(submitButton);
    return submitButton;
  }

  private refresh(): void {
    const declining = this.state.choice === "decline";
    for (const refs of this.choiceRefs) {
      refs.input.checked = refs.choice === this.state.choice;
    }
    this.guidanceWrapEl.hidden = !declining;
    this.guidanceEl.disabled = this.disabled || !declining;
    // The draft survives leaving and re-entering Other, so re-sync the field from state
    // rather than trusting whatever the DOM kept.
    if (this.guidanceEl.value !== this.state.guidance) {
      this.guidanceEl.value = this.state.guidance;
    }
    this.choiceRefs[this.choiceRefs.length - 1]?.rowEl.toggleClass(
      "is-other-expanded",
      declining,
    );
    // Always submittable: a decision is a decision, and the guidance is optional.
    this.submitButton.disabled = this.disabled;
  }

  private onSubmit(event: Event): void {
    event.preventDefault();
    if (this.disabled) return;
    const decision = buildApprovalDecision(this.state);
    this.disable();
    this.callbacks.onSubmit(decision);
  }

  private listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
  ): void {
    target.addEventListener(type, listener);
    this.listeners.push({ target, type, listener });
  }
}
