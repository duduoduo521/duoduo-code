import { test, expect, describe } from "bun:test"
import { ConfigAgent } from "../../src/config/agent"

// ---------------------------------------------------------------------------
// ConfigAgent.Info — schema validation, normalization, edge cases
//
// The Agent.Info schema is a Zod type derived from an Effect Schema with
// transforms.  We test the user-facing Zod directly (Info.safeParse) for
// pure, fast unit tests.
// ---------------------------------------------------------------------------

describe("Info schema — valid configs", () => {
  test("minimal config with just a name and prompt", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "coder",
      prompt: "You are a coding assistant",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe("coder")
      expect(result.data.options).toEqual({})
      expect(result.data.permission).toEqual({})
    }
  })

  test("full config with all optional fields", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "architect",
      model: "gpt-4",
      temperature: 0.7,
      top_p: 1,
      prompt: "Design architecture",
      description: "Helps with architecture decisions",
      mode: "subagent",
      hidden: true,
      disable: false,
      steps: 10,
      color: "primary",
      options: { custom: "value" },
      permission: { bash: "allow" },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe("architect")
      expect(result.data.model).toBe("gpt-4")
      expect(result.data.temperature).toBe(0.7)
      expect(result.data.top_p).toBe(1)
      expect(result.data.prompt).toBe("Design architecture")
      expect(result.data.description).toBe("Helps with architecture decisions")
      expect(result.data.mode).toBe("subagent")
      expect(result.data.hidden).toBe(true)
      expect(result.data.disable).toBe(false)
      expect(result.data.steps).toBe(10)
      expect(result.data.color).toBe("primary")
    }
  })

  test("steps coalesces maxSteps (deprecated alias)", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "legacy",
      prompt: "test",
      maxSteps: 25,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.steps).toBe(25)
    }
  })

  test("steps beats maxSteps when both are present", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "both",
      prompt: "test",
      steps: 5,
      maxSteps: 25,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.steps).toBe(5)
    }
  })
})

describe("Info schema — tools → permission normalization", () => {
  test("tools write/edit/patch map to permission.edit", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "write_tool",
      prompt: "test",
      tools: { write: true, edit: false, patch: true },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      // normalize() iterates tools entries:
      //   write: true  → edit = "allow"
      //   edit: false  → edit = "deny"
      //   patch: true  → edit = "allow"
      expect(result.data.permission!.edit).toBe("allow")
    }
  })

  test("non-edit tools in tools map map to their own key", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "tool_mapping",
      prompt: "test",
      tools: { bash: false, glob: true, grep: true },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.permission!.bash).toBe("deny")
      expect(result.data.permission!.glob).toBe("allow")
      expect(result.data.permission!.grep).toBe("allow")
    }
  })

  test("tools and permission both set → permission.last wins (order matters)", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "both",
      prompt: "test",
      tools: { bash: true, grep: true },
      permission: { bash: "deny" },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      // tools sets bash=allow, grep=allow
      // then Object.assign(permission, agent.permission) overrides bash with deny
      expect(result.data.permission!.bash).toBe("deny")
      expect(result.data.permission!.grep).toBe("allow")
    }
  })
})

describe("Info schema — unknown keys → options promotion", () => {
  test("unknown top-level keys are moved to options", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "custom",
      prompt: "test",
      custom_field: "anything",
      another_one: 42,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.options?.custom_field).toBe("anything")
      expect(result.data.options?.another_one).toBe(42)
    }
  })

  test("known keys are NOT moved to options", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "check",
      prompt: "test",
      model: "gpt-4",
      temperature: 0.5,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      // options should be empty for known keys
      expect(result.data.options).toEqual({})
    }
  })

  test("options + unknown keys merge correctly", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "merge",
      prompt: "test",
      options: { existing: true },
      extra_key: "should_merge",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.options?.existing).toBe(true)
      expect(result.data.options?.extra_key).toBe("should_merge")
    }
  })
})

describe("Info schema — color validation", () => {
  test("valid hex colors pass", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "hex",
      prompt: "test",
      color: "#FF5733",
    })
    expect(result.success).toBe(true)
  })

  test("valid named theme colors pass", () => {
    for (const color of ["primary", "secondary", "accent", "success", "warning", "error", "info"]) {
      const result = ConfigAgent.Info.safeParse({
        name: color,
        prompt: "test",
        color,
      })
      expect(result.success).toBe(true)
    }
  })

  test("invalid hex color is rejected", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "bad_hex",
      prompt: "test",
      color: "#XYZ123",
    })
    expect(result.success).toBe(false)
  })

  test("invalid color name is rejected", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "bad_color",
      prompt: "test",
      color: "not_a_color",
    })
    expect(result.success).toBe(false)
  })
})

describe("Info schema — rejection of invalid configs", () => {
  test("non-numeric temperature is rejected", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "bad_temp",
      prompt: "test",
      temperature: "hot",
    })
    expect(result.success).toBe(false)
  })

  test("invalid mode value is rejected", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "bad_mode",
      prompt: "test",
      mode: "superagent",
    })
    expect(result.success).toBe(false)
  })

  test("non-integer steps is rejected", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "bad_steps",
      prompt: "test",
      steps: 3.5,
    })
    expect(result.success).toBe(false)
  })

  test("zero steps is rejected", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "zero_steps",
      prompt: "test",
      steps: 0,
    })
    expect(result.success).toBe(false)
  })

  test("negative steps is rejected", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "neg_steps",
      prompt: "test",
      steps: -1,
    })
    expect(result.success).toBe(false)
  })

  test("non-object tools is rejected", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "bad_tools",
      prompt: "test",
      tools: "not_an_object",
    })
    expect(result.success).toBe(false)
  })

  test("non-boolean tool values in deprecated tools map are accepted (schema is flexible)", () => {
    // tools is Schema.Record(Schema.String, Schema.Boolean) with optional
    const result = ConfigAgent.Info.safeParse({
      name: "tools_with_string",
      prompt: "test",
      tools: { bash: "allow" },
    })
    // Since tools is Schema.Record(String, Boolean), "allow" as a string should fail
    expect(result.success).toBe(false)
  })
})

describe("Info schema — optional fields default correctly", () => {
  test("prompt is not required at schema level (only name and frontmatter)", () => {
    // The schema itself (AgentSchema) has no required fields other than
    // what the Struct declares. 'prompt' is optional Schema.String.
    const result = ConfigAgent.Info.safeParse({
      name: "no_prompt",
    })
    expect(result.success).toBe(true)
  })

  test("model is optional", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "no_model",
      prompt: "test",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.model).toBeUndefined()
    }
  })
})

describe("Info schema — string values pass through", () => {
  test("description is preserved", () => {
    const result = ConfigAgent.Info.safeParse({
      name: "doc",
      prompt: "test",
      description: "Useful for frontend tasks",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.description).toBe("Useful for frontend tasks")
    }
  })
})
