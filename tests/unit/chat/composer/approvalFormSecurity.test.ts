import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

// The drawer renders a model-derived summary and a model-derived detail line. Both are
// strings the model influenced, so the form has to stay on text-only DOM paths, exactly
// as the ask form does. Mirrors askQuestionFormSecurity.test.ts.
describe("approval form rendering security", () => {
  it("keeps every model-derived string on a text-only DOM path", () => {
    const form = source("src/chat/composer/ApprovalForm.ts");

    expect(form).not.toMatch(/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/u);
    expect(form).not.toContain("MarkdownRenderer");
    // One anchor only: the target-note link, whose href is a constant. The path it opens
    // goes to the opener callback, never into an attribute.
    expect(form.match(/createEl\(\s*["']a["']/gu)).toHaveLength(1);
    expect(form).not.toMatch(/\bhref\s*:(?!\s*"#")/u);
    expect(form).not.toMatch(/\bsrc\s*:/u);
    expect(form).not.toMatch(/\bstyle\s*:/u);
    expect(form).toContain("summaryEl.setText(request.summary)");
    expect(form).toContain("summaryEl.appendText(parts.before)");
    expect(form).toContain("text: parts.link");
    expect(form).toContain("summaryEl.appendText(parts.after)");
    expect(form).toContain("text: request.detail");
    expect(form).toContain("text: copy.label");
    expect(form).toContain("text: copy.description");
  });

  it("uses native controls, an accessible group, and the named write-time clamp", () => {
    const form = source("src/chat/composer/ApprovalForm.ts");

    expect(form).toContain('createEl("fieldset"');
    expect(form).toContain('createEl("legend"');
    expect(form).toContain('type: "radio"');
    expect(form).toContain('"aria-describedby": descriptionId');
    expect(form).toContain("attr: { for: inputId }");
    // Uncapped by design; safety on this field is the text-only DOM path, not length.
    expect(form).not.toContain("maxlength");
    expect(form).toContain('"aria-label": "Guidance for the model"');
    expect(form).toContain("this.choiceRefs[0]?.input.focus()");
    expect(form).toContain("if (refs.input.checked) textarea.focus()");
  });

  it("offers exactly the three choices and consumes the shared interaction rows", () => {
    const form = source("src/chat/composer/ApprovalForm.ts");
    const styles = source("src/chat/composer/ApprovalForm.css");
    const shared = source("src/chat/composer/AskQuestionForm.css");

    expect(form).toContain('choice: "approve"');
    expect(form).toContain('choice: "approve-session"');
    expect(form).toContain('choice: "decline"');
    expect(form.match(/choice: "(?:approve|approve-session|decline)"/gu)).toHaveLength(3);

    // The shared block lives once, in the ask stylesheet, and the approval form consumes
    // it. A copy in ApprovalForm.css is the drift this extraction exists to prevent.
    expect(form).toContain("lmsa-interaction-options");
    expect(form).toContain("lmsa-interaction-option-input");
    expect(form).toContain("lmsa-interaction-other-textarea");
    expect(shared).toContain(".lmsa-interaction-option {");
    expect(shared).toContain(".lmsa-interaction-other-textarea {");
    expect(styles).not.toContain(".lmsa-interaction-option {");
    expect(styles).not.toContain(".lmsa-interaction-other-textarea {");
  });

  it("carries no navigation, no error slot, and no review surface", () => {
    const form = source("src/chat/composer/ApprovalForm.ts");

    // D3: the drawer carries no navigation back to the timeline. Opening the target note
    // is the one navigation it carries (D3 amendment), and it goes through the callback.
    expect(form).not.toContain("Show on timeline");
    expect(form).not.toContain("scrollIntoView");
    expect(form).not.toContain("openLinkText");
    expect(form).toContain("this.callbacks.onOpenTarget(target, event as MouseEvent)");
    // D2: submitting settles the interaction, so there is nothing left to report.
    expect(form).not.toContain("lmsa-approval-form-error");
    expect(form).not.toContain("role: \"alert\"");
    // Non-goal: the drawer is not a review surface.
    expect(form).not.toContain("DiffHunkView");
    expect(form).not.toContain("buildWritePreviewHunk");
  });

  it("states what session approval actually overrides, rather than implying a safe subset", () => {
    const form = source("src/chat/composer/ApprovalForm.ts");
    const settings = source("src/settings/VaultOpsTab.ts");
    const pill = source("src/chat/composer/PosturePill.ts");

    expect(form).toContain("Approve everything this session");
    // The deny override is the sharp edge, and it is named with the word the vault-ops
    // settings actually put on that option, so the user can go and find it.
    expect(form).toContain("even kinds set to Deny");
    expect(settings).toContain('label: "Deny"');
    // Likewise the posture: this is the label the composer's pill shows.
    expect(form).toContain("Switches to Edit automatically");
    expect(pill).toContain('label: "Edit automatically"');
  });

  it("can be minimized out of the way and restored", () => {
    const form = source("src/chat/composer/ApprovalForm.ts");

    expect(form).toContain('"aria-label": "Minimize approval"');
    expect(form).toContain('collapsed ? "Expand approval" : "Minimize approval"');
    expect(form).toContain('"aria-controls": bodyId');
    expect(form).toContain("this.bodyEl.inert = collapsed");
    expect(form).toContain('this.bodyEl.setAttribute("aria-hidden"');
    expect(form).toContain(
      'setIcon(this.collapseButton, collapsed ? "chevron-up" : "chevron-down")',
    );
    // The eyebrow lives in the toolbar, so a minimized drawer still says what is waiting.
    expect(form).toContain("lmsa-interaction-toolbar");
    expect(form.indexOf("lmsa-approval-form-eyebrow")).toBeLessThan(
      form.indexOf("lmsa-interaction-collapse"),
    );
  });

  it("submits on every choice, because a decision is always submittable", () => {
    const form = source("src/chat/composer/ApprovalForm.ts");

    expect(form).toContain("this.submitButton.disabled = this.disabled;");
    expect(form).not.toContain("completeness");
  });
});
