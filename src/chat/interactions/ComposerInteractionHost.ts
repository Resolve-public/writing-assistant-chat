import type {
  AskAnswers,
  ValidatedAskRequest,
} from "../../tools/ask/types";
import { ApprovalForm } from "../composer/ApprovalForm";
import { AskQuestionForm } from "../composer/AskQuestionForm";
import type { ChatLayoutRefs } from "../types";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalTarget,
} from "./approvalTypes";

/**
 * The drawer serves two producers, discriminated on `kind`. They share a mount point
 * and nothing else: the ask and approval state machines stay separate, because approval
 * has disposition, policy, scope, and mutation semantics that ask does not.
 */
export type ComposerInteraction =
  | {
      kind: "ask";
      interactionId: string;
      request: ValidatedAskRequest;
      onSubmit: (answers: AskAnswers) => void;
      onCancel: () => void;
    }
  | {
      kind: "approval";
      interactionId: string;
      request: ApprovalRequest;
      onSubmit: (decision: ApprovalDecision) => void;
      onCancel: () => void;
    };

export interface ComposerInteractionHostPort {
  mount(interaction: ComposerInteraction): boolean;
  clearIfOwner(interactionId: string): void;
  isActive(interactionId?: string): boolean;
  destroy(): void;
}

type ComposerInteractionHostRefs = Pick<
  ChatLayoutRefs,
  | "composerPanelEl"
  | "composerNormalBodyEl"
  | "composerInteractionEl"
  | "composerFooterEl"
  | "textareaEl"
  | "actionBtn"
>;

export interface ComposerInteractionHostCallbacks {
  /** Open the note an approval is about. The host has no app; the view does. */
  onOpenNote: (target: ApprovalTarget, event: MouseEvent) => void;
}

/** The lifecycle both forms implement; the host needs nothing else from them. */
interface MountedForm {
  disable(): void;
  destroy(): void;
}

interface ActiveInteraction {
  interaction: ComposerInteraction;
  form: MountedForm;
}

export class ComposerInteractionHost implements ComposerInteractionHostPort {
  private active: ActiveInteraction | null = null;
  private destroyed = false;

  constructor(
    private readonly refs: ComposerInteractionHostRefs,
    private readonly callbacks: ComposerInteractionHostCallbacks,
  ) {
    this.setInteractionVisible(null);
  }

  mount(interaction: ComposerInteraction): boolean {
    if (this.destroyed || this.active) return false;

    this.setInteractionVisible(interaction.kind);
    try {
      const form = this.createForm(interaction);
      this.active = { interaction, form };
      return true;
    } catch (error) {
      this.setInteractionVisible(null);
      this.refs.composerInteractionEl.empty();
      throw error;
    }
  }

  clearIfOwner(interactionId: string): void {
    if (this.active?.interaction.interactionId !== interactionId) return;
    this.clearActive();
  }

  isActive(interactionId?: string): boolean {
    if (!this.active) return false;
    return (
      interactionId === undefined ||
      this.active.interaction.interactionId === interactionId
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const active = this.active;
    this.clearActive();
    active?.interaction.onCancel();
  }

  private createForm(interaction: ComposerInteraction): MountedForm {
    const refs = { containerEl: this.refs.composerInteractionEl };
    if (interaction.kind === "approval") {
      return new ApprovalForm(
        {
          interactionId: interaction.interactionId,
          request: interaction.request,
        },
        refs,
        {
          onSubmit: interaction.onSubmit,
          onOpenTarget: this.callbacks.onOpenNote,
        },
      );
    }
    return new AskQuestionForm(
      {
        interactionId: interaction.interactionId,
        request: interaction.request,
      },
      refs,
      { onSubmit: interaction.onSubmit },
    );
  }

  private clearActive(): void {
    const active = this.active;
    if (!active) {
      this.setInteractionVisible(null);
      return;
    }
    this.active = null;
    active.form.disable();
    active.form.destroy();
    this.refs.composerInteractionEl.empty();
    this.setInteractionVisible(null);
    if (this.refs.actionBtn.isConnected) {
      this.refs.actionBtn.focus();
    } else if (this.refs.textareaEl.isConnected) {
      this.refs.textareaEl.focus();
    }
  }

  /** `kind` is null when nothing is mounted. */
  private setInteractionVisible(kind: ComposerInteraction["kind"] | null): void {
    const visible = kind !== null;
    this.refs.composerPanelEl.toggleClass("is-interacting", visible);
    this.refs.composerPanelEl.toggleClass("is-ask-interaction", kind === "ask");
    this.refs.composerPanelEl.toggleClass(
      "is-approval-interaction",
      kind === "approval",
    );
    this.refs.composerFooterEl.toggleClass("is-interacting", visible);

    this.refs.composerNormalBodyEl.hidden = false;
    this.refs.composerNormalBodyEl.setAttribute(
      "aria-hidden",
      visible ? "true" : "false",
    );
    if (visible) {
      this.refs.composerNormalBodyEl.setAttribute("inert", "");
    } else {
      this.refs.composerNormalBodyEl.removeAttribute("inert");
    }
    this.refs.composerInteractionEl.hidden = !visible;
    this.refs.composerInteractionEl.setAttribute(
      "aria-hidden",
      visible ? "false" : "true",
    );
  }
}
