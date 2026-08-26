// user.ask sanitizer tests — faithful port of the desktop's Rust unit tests
// (src-tauri/src/agent/runtime.rs: agent_loop_action_normalizes_user_ask_alias,
// user_ask_sanitizes_generic_field_schema, user_ask_drops_unknown_field_types…,
// user_ask_deduplicates_field_ids_and_option_values,
// user_ask_rejects_invalid_choice_defaults, user_ask_preserves_valid_choice_defaults,
// user_ask_empty_or_all_invalid_fields_return_schema_error) plus wire-shape
// checks for the AgentUserInputRequest/Field/Option serde contracts.

import { describe, it, expect } from "vitest"
import {
  isUserAskTool, cleanUserInputText, cleanUserInputId, normalizeUserInputFieldType,
  uniqueUserInputKey, validateUserInputDefault, sanitizeUserInputOption,
  sanitizeUserInputField, sanitizeUserInputRequest,
  MAX_USER_INPUT_FIELDS, MAX_USER_INPUT_OPTIONS, MAX_USER_INPUT_TEXT_CHARS,
} from "../src/user-input.js"

describe("isUserAskTool (runtime.rs is_user_ask_tool + alias normalization)", () => {
  it("accepts the desktop's five spellings", () => {
    for (const name of ["user.ask", "user_input.ask", "askUserQuestion", "AskUserQuestion", "ask_user_question"]) {
      expect(isUserAskTool(name)).toBe(true)
      expect(isUserAskTool(`  ${name} `)).toBe(true) // the Rust matcher trims
    }
  })
  it("rejects other tools", () => {
    for (const name of ["wiki.search", "user.asker", "askUser", "", null, 42]) {
      expect(isUserAskTool(name)).toBe(false)
    }
  })
})

describe("sanitizeUserInputRequest (desktop fixtures)", () => {
  it("normalizes the AskUserQuestion alias with a questions array", () => {
    // Rust agent_loop_action_normalizes_user_ask_alias
    const request = sanitizeUserInputRequest({
      questions: [{ id: "palette", question: "Palette?", options: [{ label: "Auto", value: "auto" }] }],
    })
    expect(request.fields[0].id).toBe("palette")
    expect(request.fields[0].type).toBe("single") // no type given -> "single"
    expect(request.fields[0].label).toBe("Palette?") // label falls back to question
  })

  it("sanitizes a generic field schema", () => {
    // Rust user_ask_sanitizes_generic_field_schema
    const request = sanitizeUserInputRequest({
      title: "Cover setup",
      fields: [
        { type: "text", id: "watermark", label: "Watermark", placeholder: "Optional" },
        { type: "multiChoice", id: "channels", label: "Channels", options: [{ label: "Web", value: "web" }, { label: "Print", value: "print" }] },
      ],
    })
    expect(request.title).toBe("Cover setup")
    expect(request.fields.length).toBe(2)
    expect(request.fields[0].type).toBe("text")
    expect(request.fields[0].placeholder).toBe("Optional")
    expect(request.fields[1].type).toBe("multi")
    expect(request.fields[1].options.length).toBe(2)
  })

  it("drops unknown field types without failing valid fields", () => {
    // Rust user_ask_drops_unknown_field_types_without_failing_valid_fields
    const request = sanitizeUserInputRequest({
      fields: [
        { type: "date", id: "deadline", label: "Deadline" },
        { type: "text", id: "topic", label: "Topic" },
      ],
    })
    expect(request.fields.length).toBe(1)
    expect(request.fields[0].id).toBe("topic")
    expect(request.fields[0].type).toBe("text")
  })

  it("deduplicates field ids and option values", () => {
    // Rust user_ask_deduplicates_field_ids_and_option_values
    const request = sanitizeUserInputRequest({
      fields: [
        {
          type: "single", id: "choice", label: "Primary",
          options: [{ label: "Auto", value: "auto" }, { label: "Auto again", value: "auto" }],
        },
        { type: "text", id: "choice", label: "Notes" },
      ],
    })
    expect(request.fields[0].id).toBe("choice")
    expect(request.fields[1].id).toBe("choice_2")
    expect(request.fields[0].options[0].value).toBe("auto")
    expect(request.fields[0].options[1].value).toBe("auto_2")
  })

  it("rejects invalid choice defaults", () => {
    // Rust user_ask_rejects_invalid_choice_defaults
    const request = sanitizeUserInputRequest({
      fields: [{
        type: "single", id: "palette", label: "Palette", defaultValue: "missing",
        options: [{ label: "Auto", value: "auto" }],
      }],
    })
    expect(request.fields[0].defaultValue).toBeUndefined()
    expect("defaultValue" in request.fields[0]).toBe(false) // serde skip_serializing_if
  })

  it("preserves valid choice defaults", () => {
    // Rust user_ask_preserves_valid_choice_defaults
    const request = sanitizeUserInputRequest({
      fields: [
        { type: "single", id: "palette", label: "Palette", defaultValue: "auto", options: [{ label: "Auto", value: "auto" }] },
        { type: "multi", id: "channels", label: "Channels", defaultValue: ["web"], options: [{ label: "Web", value: "web" }] },
      ],
    })
    expect(request.fields[0].defaultValue).toBe("auto")
    expect(request.fields[1].defaultValue).toEqual(["web"])
  })

  it("empty or all-invalid fields return the schema error", () => {
    // Rust user_ask_empty_or_all_invalid_fields_return_schema_error
    expect(() => sanitizeUserInputRequest({ fields: [] }))
      .toThrowError("user.ask requires at least one valid field")
    expect(() => sanitizeUserInputRequest({ fields: [{ type: "date", label: "When?" }] }))
      .toThrowError("user.ask requires at least one valid field")
  })

  it("missing fields/questions error matches the desktop", () => {
    expect(() => sanitizeUserInputRequest({})).toThrowError("user.ask requires fields or questions")
    expect(() => sanitizeUserInputRequest({ fields: "nope" })).toThrowError("user.ask fields must be an array")
    expect(() => sanitizeUserInputRequest({ fields: null })).toThrowError("user.ask fields must be an array")
  })

  it("wire shape: requestId is a uuid, defaults for title/description, key omission", () => {
    const request = sanitizeUserInputRequest({
      fields: [{ type: "text", label: "Topic" }],
    })
    expect(request.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(request.title).toBe("Input required") // desktop default
    expect(request.description).toBe("Please provide the requested information so the Agent can continue.")
    expect(request.fields[0].id).toBe("field_1")
    expect(request.fields[0].label).toBe("Topic")
    const noLabel = sanitizeUserInputRequest({ fields: [{ type: "text" }] })
    expect(noLabel.fields[0].label).toBe("Question 1")
    expect("options" in request.fields[0]).toBe(false) // empty options skipped (serde)
    // description cleaned to empty -> key omitted entirely
    const dirty = sanitizeUserInputRequest({ description: "<>", fields: [{ type: "text", label: "T" }] })
    expect("description" in dirty).toBe(false)
    expect(dirty.title).toBe("Input required")
  })

  it("caps fields at 12 and options at 8 (MAX_USER_INPUT_FIELDS/OPTIONS)", () => {
    expect(MAX_USER_INPUT_FIELDS).toBe(12)
    expect(MAX_USER_INPUT_OPTIONS).toBe(8)
    const fields = Array.from({ length: 20 }, (_, i) => ({ type: "text", id: `f${i}`, label: `L${i}` }))
    const request = sanitizeUserInputRequest({ fields })
    expect(request.fields.length).toBe(12)
    const options = Array.from({ length: 12 }, (_, i) => ({ label: `O${i}`, value: `v${i}` }))
    const capped = sanitizeUserInputRequest({ fields: [{ type: "single", label: "Q", options }] })
    expect(capped.fields[0].options.length).toBe(8)
  })
})

describe("cleanUserInputText / cleanUserInputId (runtime.rs cleaners)", () => {
  it("strips <, > and control chars; trims; empty -> null", () => {
    expect(cleanUserInputText("  hello <b>world</b>\u0007 ")).toBe("hello bworld/b")
    expect(cleanUserInputText("   ")).toBeNull()
    expect(cleanUserInputText("<>")).toBeNull()
    expect(cleanUserInputText(123)).toBeNull()
  })
  it("caps kept chars at MAX_USER_INPUT_TEXT_CHARS", () => {
    expect(MAX_USER_INPUT_TEXT_CHARS).toBe(400)
    const out = cleanUserInputText("a".repeat(500))
    expect(out.length).toBe(400)
    // cap counts KEPT chars: 395 a's + 5 dropped '<' still yields 395 (< 400)
    expect(cleanUserInputText("a".repeat(395) + "<<<<<").length).toBe(395)
  })
  it("id cleaner keeps [A-Za-z0-9_-] up to 64 chars", () => {
    expect(cleanUserInputId("my field/id")).toBe("myfieldid")
    expect(cleanUserInputId("a-b_C9")).toBe("a-b_C9")
    expect(cleanUserInputId("x".repeat(80)).length).toBe(64)
    expect(cleanUserInputId("///")).toBeNull()
  })
})

describe("normalizeUserInputFieldType (runtime.rs mapping)", () => {
  it("maps every alias to the canonical type", () => {
    expect(normalizeUserInputFieldType("singleChoice")).toBe("single")
    expect(normalizeUserInputFieldType("radio")).toBe("single")
    expect(normalizeUserInputFieldType("select")).toBe("single")
    expect(normalizeUserInputFieldType("multiChoice")).toBe("multi")
    expect(normalizeUserInputFieldType("checkbox")).toBe("multi")
    expect(normalizeUserInputFieldType("checkboxes")).toBe("multi")
    expect(normalizeUserInputFieldType("input")).toBe("text")
    expect(normalizeUserInputFieldType("longText")).toBe("textarea")
    expect(normalizeUserInputFieldType("boolean")).toBe("confirm")
    expect(normalizeUserInputFieldType("switch")).toBe("confirm")
    expect(normalizeUserInputFieldType("  text  ")).toBe("text")
    expect(normalizeUserInputFieldType("date")).toBeNull()
  })
})

describe("uniqueUserInputKey (runtime.rs dedup chain)", () => {
  it("first-seen wins, then suffixes, then field fallbacks", () => {
    const used = new Set()
    expect(uniqueUserInputKey(used, "a", 0)).toBe("a")
    expect(uniqueUserInputKey(used, "a", 1)).toBe("a_2")
    for (let i = 3; i <= 22; i++) expect(uniqueUserInputKey(used, "a", i)).toBe(`a_${i}`)
    // suffix space exhausted (2..=22) -> field_{idx+1}
    expect(uniqueUserInputKey(used, "a", 22)).toBe("field_23")
    expect(used.has("field_23")).toBe(true)
    // field_24 taken first, then the collision -> field_{idx+1}_{used.size+1}
    const used2 = new Set(["b"])
    for (let i = 2; i <= 22; i++) used2.add(`b_${i}`)
    used2.add("field_2")
    expect(uniqueUserInputKey(used2, "b", 1)).toBe(`field_2_${used2.size + 1}`)
  })
})

describe("sanitizeUserInputOption / field edge cases", () => {
  it("option value falls back to label; recommended only when boolean", () => {
    expect(sanitizeUserInputOption({ label: "Keep" })).toEqual({ label: "Keep", value: "Keep" })
    expect(sanitizeUserInputOption({ label: "Keep", recommended: true }))
      .toEqual({ label: "Keep", value: "Keep", recommended: true })
    expect(sanitizeUserInputOption({ label: "Keep", recommended: "yes" }))
      .toEqual({ label: "Keep", value: "Keep" }) // non-bool recommended dropped
    expect(sanitizeUserInputOption({ title: "Via title", value: "vt" }))
      .toEqual({ label: "Via title", value: "vt" })
    // present-but-non-string label does NOT fall through to title (Rust or_else)
    expect(sanitizeUserInputOption({ label: 42, title: "Nope" })).toBeNull()
    expect(sanitizeUserInputOption(null)).toBeNull()
  })
  it("choice fields without valid options are dropped; confirm needs none", () => {
    expect(sanitizeUserInputField({ type: "single", label: "Q" }, 0)).toBeNull()
    expect(sanitizeUserInputField({ type: "multi", label: "Q", options: [] }, 0)).toBeNull()
    const confirm = sanitizeUserInputField({ type: "confirm", label: "Proceed?", defaultValue: true }, 0)
    expect(confirm.type).toBe("confirm")
    expect(confirm.defaultValue).toBe(true)
  })
  it("validateUserInputDefault matches the desktop semantics", () => {
    const options = [{ label: "A", value: "a" }]
    expect(validateUserInputDefault("single", "a", options)).toBe(true)
    expect(validateUserInputDefault("single", "b", options)).toBe(false)
    expect(validateUserInputDefault("multi", [], options)).toBe(true) // empty all() == true
    expect(validateUserInputDefault("multi", ["a", "b"], options)).toBe(false)
    expect(validateUserInputDefault("text", "", options)).toBe(true)
    expect(validateUserInputDefault("confirm", false, options)).toBe(true)
    expect(validateUserInputDefault("confirm", "yes", options)).toBe(false)
  })
})
