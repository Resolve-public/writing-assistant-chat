/**
 * The channel-agnostic live-approval contract (RFC-0012).
 *
 * While a generation is live, every approval decision is made in the composer
 * interaction drawer; the timeline is a record (status, evidence, undo) and carries
 * no live decision control. This file is the whole vocabulary that crossing needs:
 * a request the parked channel raises, and a decision the drawer reports back.
 *
 * Deliberately absent:
 *   - an outcome type. The interaction settles on submit, so the decision callback
 *     returns nothing and a failed apply is reported as a failure on the tool result
 *     rather than re-opening the drawer.
 *   - a withdrawal reason. The lane is single-slot and a second request is refused
 *     *before it parks*, so nothing is ever shown and then taken away.
 */

/** Which review channel parked this decision. Shapes wording only, never policy. */
export type ApprovalChannel = "vault-op" | "edit" | "memory";

export interface ApprovalRequest {
  /** The parked resolution's key: an op id, a hunk id, or a memory proposal id. */
  approvalId: string;
  channel: ApprovalChannel;
  /** The originating tool call, the correlation back to its timeline step. */
  toolCallId: string;
  /** One line naming what is being approved, e.g. `Overwrite Notes/Draft.md`. */
  summary: string;
  /** Optional second line, e.g. an op's target path or an edit's start line. */
  detail?: string;
  /**
   * The existing note this change lands in, when there is exactly one. The drawer floats
   * over the transcript and the note, so it renders this path inside `summary` as a link
   * that opens the note, the same way a diff card's file name does.
   */
  target?: ApprovalTarget;
}

/** A note the drawer can open. `line` is 1-based, as the edit pipeline reports it. */
export interface ApprovalTarget {
  path: string;
  line?: number;
}

export type ApprovalDecision =
  | { kind: "approve" }
  | { kind: "approve-session" }
  /** The decline path. `guidance` is the user's free text, empty when they just said no. */
  | { kind: "decline"; guidance: string };

/**
 * Raise one approval for decision. Returns `false` when the lane is occupied, or the
 * requester is destroyed or aborted; the caller decides what that means for its channel.
 * A `true` means the request is mounted and `decide` will be called exactly once.
 */
export interface ApprovalRequester {
  request(
    request: ApprovalRequest,
    decide: (decision: ApprovalDecision) => void,
    isLive: () => boolean,
  ): boolean;
  /**
   * The decision for `approvalId` was made somewhere other than the drawer (the in-note
   * overlay, a timeline control, decline propagation). Takes the request down and frees
   * the lane if it still holds that approval; otherwise does nothing. Without it the
   * drawer keeps offering a settled change and refuses every later one in the turn.
   */
  release(approvalId: string): void;
}
