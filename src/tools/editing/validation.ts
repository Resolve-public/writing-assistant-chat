/**
 * Runtime argument validation for edit-mode tool calls.
 *
 * Models can return malformed arguments (wrong types, missing fields).
 * These validators check shape and types before execution, returning
 * an actionable error message that the model can use to self-correct.
 */

// ---------------------------------------------------------------------------
// Validation result type
// ---------------------------------------------------------------------------

type ValidationOk<T> = { ok: true; args: T };
type ValidationErr = { ok: false; error: string };
type ValidationResult<T> = ValidationOk<T> | ValidationErr;

function ok<T>(args: T): ValidationOk<T> {
  return { ok: true, args };
}

function err(error: string): ValidationErr {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Write tool argument types
// ---------------------------------------------------------------------------

export interface EditArgs {
  /** Vault-relative path of the note to edit. Required by the tool; enforced at execution. */
  path?: string;
  search: string;
  replace: string;
  explanation?: string;
}

export interface FrontmatterOperation {
  key: string;
  /** A scalar string, or an array of strings for a multi-value / list property. */
  value?: string | string[];
  action: "set" | "remove";
}

export interface UpdateFrontmatterArgs {
  /** Vault-relative path of the note to edit. Required by the tool; enforced at execution. */
  path?: string;
  operations: FrontmatterOperation[];
  explanation?: string;
}

/** Where insert_into_note places its content relative to the anchor / the document. */
export type InsertWhere = "before" | "after" | "append" | "prepend";

/** Valid `where` values, also the schema enum (single source of truth). */
export const INSERT_WHERES: InsertWhere[] = ["before", "after", "append", "prepend"];

export interface InsertIntoNoteArgs {
  /** Vault-relative path of the note to edit. Required by the tool; enforced at execution. */
  path?: string;
  /** Existing text to anchor on; required for "before"/"after", ignored for append/prepend. */
  anchor?: string;
  content: string;
  where: InsertWhere;
  explanation?: string;
}

/**
 * The failure an `edit` gets when its replace text equals its search text. Such a
 * call changes nothing, and accepting it would queue an empty review while telling the
 * model it succeeded, so weaker models never learn they dropped their change. Shared by
 * every site that guards the prose edit channel so the model sees one wording.
 */
export const NO_OP_EDIT_FAILURE = {
  what: "replace is identical to search, so this edit changes nothing",
  recovery:
    "put the rewritten passage in replace: the search text with your change applied",
} as const;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export function validateEdit(
  args: Record<string, unknown>,
): ValidationResult<EditArgs> {
  if (typeof args.search !== "string") {
    return err("search must be a string. Got: " + typeof args.search);
  }
  if (typeof args.replace !== "string" && args.replace !== undefined) {
    return err("replace must be a string. Got: " + typeof args.replace);
  }
  return ok({
    path: typeof args.path === "string" ? args.path : undefined,
    search: args.search,
    replace: typeof args.replace === "string" ? args.replace : "",
    explanation: typeof args.explanation === "string" ? args.explanation : undefined,
  });
}

/**
 * Coerce a frontmatter `value` argument to the supported shapes: a scalar string,
 * or an array of strings (a multi-value / list property such as tags). Anything
 * else, including an array with non-string items, becomes `undefined` so the
 * validator can reject a `set` that carried an unusable value.
 */
function normalizeFrontmatterValue(value: unknown): string | string[] | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return undefined;
}

export function validateUpdateFrontmatter(
  args: Record<string, unknown>,
): ValidationResult<UpdateFrontmatterArgs> {
  // Models sometimes flatten the structure, passing {key, action, value}
  // at the top level instead of wrapping in an operations array.
  if (!Array.isArray(args.operations) && typeof args.key === "string" && typeof args.action === "string") {
    args = { ...args, operations: [{ key: args.key, value: args.value, action: args.action }] };
  }

  if (!Array.isArray(args.operations)) {
    return err("operations must be an array. Got: " + typeof args.operations);
  }
  if (args.operations.length === 0) {
    return err("operations array must not be empty.");
  }

  const validated: FrontmatterOperation[] = [];
  for (let i = 0; i < args.operations.length; i++) {
    const op = args.operations[i] as Record<string, unknown>;
    if (!op || typeof op !== "object") {
      return err(`operations[${i}] must be an object.`);
    }
    if (typeof op.key !== "string" || op.key.trim() === "") {
      return err(`operations[${i}].key must be a non-empty string.`);
    }
    if (op.action !== "set" && op.action !== "remove") {
      return err(`operations[${i}].action must be "set" or "remove". Got: ${JSON.stringify(op.action)}`);
    }
    const value = normalizeFrontmatterValue(op.value);
    if (op.action === "set" && op.value !== undefined && value === undefined) {
      return err(
        `operations[${i}].value must be a string or an array of strings when action is "set". ` +
          `Got: ${Array.isArray(op.value) ? "array with non-string items" : typeof op.value}`,
      );
    }
    validated.push({
      key: op.key,
      value,
      action: op.action,
    });
  }

  return ok({
    path: typeof args.path === "string" ? args.path : undefined,
    operations: validated,
    explanation: typeof args.explanation === "string" ? args.explanation : undefined,
  });
}

export function validateInsertIntoNote(
  args: Record<string, unknown>,
): ValidationResult<InsertIntoNoteArgs> {
  if (typeof args.content !== "string" || args.content === "") {
    return err("content must be a non-empty string.");
  }
  if (typeof args.where !== "string" || !INSERT_WHERES.includes(args.where as InsertWhere)) {
    return err(`where must be one of ${INSERT_WHERES.join(", ")}. Got: ${JSON.stringify(args.where)}`);
  }
  const where = args.where as InsertWhere;
  // "before"/"after" need a passage to anchor on; append/prepend do not.
  const needsAnchor = where === "before" || where === "after";
  if (needsAnchor && (typeof args.anchor !== "string" || args.anchor === "")) {
    return err(`anchor must be a non-empty string when where is "${where}".`);
  }
  return ok({
    path: typeof args.path === "string" ? args.path : undefined,
    anchor: typeof args.anchor === "string" ? args.anchor : undefined,
    content: args.content,
    where,
    explanation: typeof args.explanation === "string" ? args.explanation : undefined,
  });
}
