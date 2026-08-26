import crypto from "node:crypto"

// Faithful Node port of the desktop agent's user.ask contract
// (src-tauri/src/agent/runtime.rs + types.rs). The model may pause a turn to
// show the user a structured form (single/multi choice, text, textarea,
// confirm). The runtime sanitizes the model-provided schema into an
// AgentUserInputRequest (camelCase wire shape, AgentUserInputRequest serde
// struct) or rejects it with the desktop's exact error strings so the loop
// can feed the rejection back to the model.
//
// The frontend (chat-panel.tsx / chat-message.tsx) renders the form from the
// `userInputRequired` agent-event (streaming) or the `userInputRequest`
// response field (non-stream), and resumes with a plain follow-up message
// carrying the answers (the desktop's stateless resume contract — no parked
// run, no extra request args).

export const MAX_USER_INPUT_FIELDS = 12
export const MAX_USER_INPUT_OPTIONS = 8
export const MAX_USER_INPUT_TEXT_CHARS = 400

// The tool names the desktop normalizes to user.ask (is_user_ask_tool).
export function isUserAskTool(tool) {
  if (typeof tool !== "string") return false
  const t = tool.trim()
  return (
    t === "user.ask"
    || t === "user_input.ask"
    || t === "askUserQuestion"
    || t === "AskUserQuestion"
    || t === "ask_user_question"
  )
}

// clean_user_input_text: drop '<'/'>' and control chars, cap the KEPT char
// count at MAX_USER_INPUT_TEXT_CHARS, trim; empty -> None (null here).
export function cleanUserInputText(value) {
  if (typeof value !== "string") return null
  const kept = []
  for (const ch of value) {
    if (ch === "<" || ch === ">") continue
    if (/^\p{Cc}$/u.test(ch)) continue // Rust char::is_control (Cc category)
    kept.push(ch)
    if (kept.length >= MAX_USER_INPUT_TEXT_CHARS) break
  }
  const out = kept.join("").trim()
  return out.length ? out : null
}

// clean_user_input_id: keep ASCII alphanumerics plus '_'/'-', cap 64 chars;
// empty -> None (null here).
export function cleanUserInputId(value) {
  if (typeof value !== "string") return null
  let out = ""
  for (const ch of value) {
    if (!/[a-zA-Z0-9_-]/.test(ch)) continue
    out += ch
    if (out.length >= 64) break
  }
  return out.length ? out : null
}

// normalize_user_input_field_type -> canonical type or null (unsupported).
export function normalizeUserInputFieldType(value) {
  switch (String(value).trim()) {
    case "single":
    case "singleChoice":
    case "radio":
    case "select":
      return "single"
    case "multi":
    case "multiChoice":
    case "checkbox":
    case "checkboxes":
      return "multi"
    case "text":
    case "input":
      return "text"
    case "textarea":
    case "longText":
      return "textarea"
    case "confirm":
    case "boolean":
    case "switch":
      return "confirm"
    default:
      return null
  }
}

// unique_user_input_key: first-seen wins, then base_2..=base_22, then
// field_{idx+1}, then field_{idx+1}_{used.len()+1} (NOT inserted, matching
// the Rust fallback).
export function uniqueUserInputKey(used, base, idx) {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  for (let suffix = 2; suffix <= MAX_USER_INPUT_FIELDS + MAX_USER_INPUT_OPTIONS + 2; suffix++) {
    const candidate = `${base}_${suffix}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
  const fallback = `field_${idx + 1}`
  if (!used.has(fallback)) {
    used.add(fallback)
    return fallback
  }
  return `field_${idx + 1}_${used.size + 1}`
}

// validate_user_input_default.
export function validateUserInputDefault(fieldType, value, options) {
  switch (fieldType) {
    case "single":
      return typeof value === "string" && options.some((o) => o.value === value)
    case "multi":
      return Array.isArray(value)
        && value.every((item) => typeof item === "string" && options.some((o) => o.value === item))
    case "text":
    case "textarea":
      return typeof value === "string"
    case "confirm":
      return typeof value === "boolean"
    default:
      return false
  }
}

// sanitize_user_input_option -> { label, value, description?, recommended? }
// or null (dropped). Mirrors the Rust or_else chain: a present-but-non-string
// "label" does NOT fall through to "title" (the option is dropped).
export function sanitizeUserInputOption(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const rawLabel = "label" in value ? value.label : value.title
  const label = typeof rawLabel === "string" ? cleanUserInputText(rawLabel) : null
  if (!label) return null
  const rawValue = "value" in value ? value.value : undefined
  const valueText = (typeof rawValue === "string" ? cleanUserInputText(rawValue) : null) ?? label
  const description = typeof value.description === "string" ? cleanUserInputText(value.description) : null
  const recommended = typeof value.recommended === "boolean" ? value.recommended : null
  return {
    label,
    value: valueText,
    ...(description ? { description } : {}),
    ...(recommended === null ? {} : { recommended }),
  }
}

// sanitize_user_input_field -> wire-shape field
// { id, type, label, description?, placeholder?, options?, defaultValue? }
// or null (dropped). Field types the desktop does not support are dropped
// WITHOUT failing the whole request.
export function sanitizeUserInputField(value, idx) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  // obj.get("type").or_else(kind).and_then(as_str).unwrap_or("single") —
  // a missing OR present-but-non-string type falls back to "single".
  const rawType = "type" in value ? value.type : value.kind
  const fieldType = normalizeUserInputFieldType(typeof rawType === "string" ? rawType : "single")
  if (!fieldType) return null
  const rawId = "id" in value ? value.id : value.name
  const id = (typeof rawId === "string" ? cleanUserInputId(rawId) : null) ?? `field_${idx + 1}`
  const rawLabel = "label" in value ? value.label : ("question" in value ? value.question : value.header)
  const label = (typeof rawLabel === "string" ? cleanUserInputText(rawLabel) : null) ?? `Question ${idx + 1}`
  const description = typeof value.description === "string" ? cleanUserInputText(value.description) : null
  const placeholder = typeof value.placeholder === "string" ? cleanUserInputText(value.placeholder) : null
  const usedOptionValues = new Set()
  const options = Array.isArray(value.options)
    ? value.options
      .slice(0, MAX_USER_INPUT_OPTIONS)
      .map((item, optionIdx) => {
        const option = sanitizeUserInputOption(item)
        if (!option) return null
        option.value = uniqueUserInputKey(usedOptionValues, option.value, optionIdx)
        return option
      })
      .filter((option) => option !== null)
    : []
  // Choice fields require at least one valid option (desktop drops them).
  if ((fieldType === "single" || fieldType === "multi") && options.length === 0) return null
  // obj.get("defaultValue").or_else(default).cloned().filter(validate) —
  // an invalid default is dropped, never an error.
  const rawDefault = "defaultValue" in value ? value.defaultValue : value.default
  const defaultValue = rawDefault !== undefined && validateUserInputDefault(fieldType, rawDefault, options)
    ? rawDefault
    : undefined
  return {
    id,
    type: fieldType,
    label,
    ...(description ? { description } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(options.length ? { options } : {}),
    ...(defaultValue === undefined ? {} : { defaultValue }),
  }
}

// sanitize_user_input_request -> AgentUserInputRequest wire shape
// { requestId, title, description?, fields[] }. Throws Error with the
// desktop's exact messages on an unusable schema (the loop feeds the error
// back to the model as a rejection observation).
/** The desktop's turn-ending answer text for a user.ask request
 * (runtime.rs AgentChatResponse.message): the sanitized description, or the
 * runtime's "Please provide the requested information to continue." fallback. */
export function userAskAnswer(request) {
  const d = request?.description
  return typeof d === "string" && d.length > 0 ? d : "Please provide the requested information to continue."
}

export function sanitizeUserInputRequest(action) {
  const args = action ?? {}
  // action.fields.or(action.questions): present-but-null counts as present
  // (serde Option<Value> Some(Null)), which then fails the array check.
  const hasFields = "fields" in args && args.fields !== undefined
  const rawFields = hasFields ? args.fields : args.questions
  if (rawFields === undefined) throw new Error("user.ask requires fields or questions")
  if (rawFields === null) throw new Error("user.ask fields must be an array")
  if (!Array.isArray(rawFields)) throw new Error("user.ask fields must be an array")
  const fields = []
  const usedFieldIds = new Set()
  for (const [idx, value] of rawFields.slice(0, MAX_USER_INPUT_FIELDS).entries()) {
    const field = sanitizeUserInputField(value, idx)
    if (!field) continue
    field.id = uniqueUserInputKey(usedFieldIds, field.id, idx)
    fields.push(field)
  }
  if (fields.length === 0) throw new Error("user.ask requires at least one valid field")
  const title = cleanUserInputText(typeof args.title === "string" ? args.title : "Input required") ?? "Input required"
  const description = cleanUserInputText(
    typeof args.description === "string"
      ? args.description
      : "Please provide the requested information so the Agent can continue.",
  )
  return {
    requestId: crypto.randomUUID(),
    title,
    ...(description ? { description } : {}),
    fields,
  }
}
