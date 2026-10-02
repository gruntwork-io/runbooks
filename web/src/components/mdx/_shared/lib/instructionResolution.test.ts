import { describe, it, expect } from "vitest"
import {
  detectManualFields,
  buildManualOutputs,
  buildInputPlaceholders,
  buildMergedContext,
  resolveCommandClientSide,
  normalizeCommandList,
  fieldsNeedingPrompt,
} from "./instructionResolution"
import type { TemplateContext } from "@/lib/templateUtils"
import { sensitiveOutput } from "@/lib/outputValues"

describe("detectManualFields", () => {
  it("returns no fields for a command without output references", () => {
    expect(detectManualFields("aws s3 ls {{ .inputs.bucket }}")).toEqual([])
  })

  it("synthesizes one field per distinct output reference", () => {
    const fields = detectManualFields(
      "echo {{ .outputs.create_account.account_id }} {{ .outputs.create_account.arn }}",
    )
    expect(fields).toHaveLength(2)
    expect(fields.map((f) => f.outputName).sort()).toEqual(["account_id", "arn"])
  })

  it("dedupes repeated references", () => {
    const fields = detectManualFields(["a {{ .outputs.step.x }}", "b {{ .outputs.step.x }}"])
    expect(fields).toHaveLength(1)
  })

  it('labels a field with the default "<key> — output of step <id>" form', () => {
    const [field] = detectManualFields("{{ .outputs.create-account.account_id }}")
    expect(field!.label).toBe("account_id — output of step create-account")
  })

  it("marks a field the command reads only behind a hasKey guard as optional", () => {
    const [field] = detectManualFields(
      '{{ if hasKey .outputs.clone_repo "org_id" }}--org {{ .outputs.clone_repo.org_id }}{{ end }}',
    )
    expect(field!.optional).toBe(true)
    expect(field!.label).toBe("org_id — output of step clone_repo (optional)")
  })

  it("keeps a field required when any command reads it unguarded", () => {
    const fields = detectManualFields([
      '{{ if hasKey .outputs.clone_repo "org_id" }}{{ .outputs.clone_repo.org_id }}{{ end }}',
      "echo {{ .outputs.clone_repo.org_id }}",
    ])
    expect(fields).toHaveLength(1)
    expect(fields[0]!.optional).toBeUndefined()
  })
})

describe("buildManualOutputs", () => {
  it("uses a <key> placeholder when a field is empty", () => {
    const fields = detectManualFields("{{ .outputs.step.arn }}")
    const outputs = buildManualOutputs(fields, {})
    expect(outputs.step!.arn).toBe("<arn>")
  })

  it("uses the entered value when present", () => {
    const fields = detectManualFields("{{ .outputs.step.arn }}")
    const outputs = buildManualOutputs(fields, { "outputs.step.arn": "arn:aws:x" })
    expect(outputs.step!.arn).toBe("arn:aws:x")
  })

  it("leaves an empty optional field out, so its hasKey guard skips it", () => {
    const fields = detectManualFields(
      '{{ if hasKey .outputs.clone_repo "org_id" }}--org {{ .outputs.clone_repo.org_id }}{{ end }}',
    )
    // The block keeps an entry: the guard looks the key up in it.
    expect(buildManualOutputs(fields, {})).toEqual({ clone_repo: {} })
    expect(buildManualOutputs(fields, { "outputs.clone_repo.org_id": "42" })).toEqual({
      clone_repo: { org_id: "42" },
    })
  })

  it("stores under both normalized and original block ids", () => {
    const fields = detectManualFields("{{ .outputs.create-account.id }}")
    const outputs = buildManualOutputs(fields, {
      "outputs.create_account.id": "123",
    })
    expect(outputs["create_account"]!.id).toBe("123")
    expect(outputs["create-account"]!.id).toBe("123")
  })
})

describe("buildInputPlaceholders", () => {
  it("fills a <name> placeholder for an input no form has set", () => {
    const inputs = buildInputPlaceholders(
      ["aws s3 cp {{ .inputs.src }} s3://{{ .inputs.bucket }}"],
      { src: "./dist" },
    )
    expect(inputs).toEqual({ src: "./dist", bucket: "<bucket>" })
  })

  it("fills only inputs with no value: absent or undefined, not null, empty or false", () => {
    // An untouched field with no default registers as undefined. The engine
    // renders '' and null as they are, so a placeholder would change the command.
    const inputs = buildInputPlaceholders(
      ["{{ .inputs.a }} {{ .inputs.b }} {{ .inputs.c }} {{ .inputs.d }} {{ .inputs.e }}"],
      { a: undefined, b: null, c: "", d: false },
    )
    expect(inputs).toEqual({ a: "<a>", b: null, c: "", d: false, e: "<e>" })
  })

  it("fills a piped value reference", () => {
    expect(buildInputPlaceholders(["{{ .inputs.region | upper }}"], {})).toEqual({
      region: "<region>",
    })
  })

  it("leaves an input used only in template logic unset", () => {
    // A placeholder is a truthy string: `if` would take a branch the user never
    // chose. Unset, the engine fails and the fallback shows the logic as written.
    const base = { name: "web" }
    const inputs = buildInputPlaceholders(
      [
        "terraform destroy {{ if .inputs.auto_approve }}-auto-approve{{ end }}",
        '{{ if eq .inputs.env "prod" }}--prod{{ end }} {{ printf "%s" .inputs.region }}',
        "{{ range .inputs.tags }}{{ . }}{{ end }} {{ .inputs.name }}",
      ],
      base,
    )
    expect(inputs).toBe(base)
  })

  it("fills an input with no value used both as a value and in template logic", () => {
    // With no value the engine can't render the command at all, so the
    // placeholder decides nothing the engine would have decided.
    const inputs = buildInputPlaceholders(
      ["{{ if .inputs.var_file }}-var-file={{ .inputs.var_file }}{{ end }}"],
      { var_file: undefined },
    )
    expect(inputs).toEqual({ var_file: "<var_file>" })
  })

  it("never fills an empty value, so logic and pipes decide as they would for that value", () => {
    // `if` on '' is false and `default` replaces ''; a truthy `<name>` would
    // flip both.
    const base = { var_file: "", suffix: "" }
    const inputs = buildInputPlaceholders(
      [
        "terraform apply {{ if .inputs.var_file }}-var-file={{ .inputs.var_file }}{{ end }}",
        'echo {{ .inputs.suffix | default "none" }}',
      ],
      base,
    )
    expect(inputs).toBe(base)
  })

  it("nests the placeholder for a dotted reference without mutating the input", () => {
    const base = { tags: { team: "infra" } }
    const inputs = buildInputPlaceholders(
      ["{{ .inputs.tags.env }} {{ .inputs._module.source }}"],
      base,
    )
    expect(inputs).toEqual({
      tags: { team: "infra", env: "<env>" },
      _module: { source: "<source>" },
    })
    expect(base).toEqual({ tags: { team: "infra" } })
  })

  it("leaves a set nested value alone", () => {
    const base = { _module: { source: "git::x" } }
    expect(buildInputPlaceholders(["{{ .inputs._module.source }}"], base)).toBe(base)
  })

  it("does not replace a scalar or null that a dotted reference treats as an object", () => {
    expect(buildInputPlaceholders(["{{ .inputs.tags.env }}"], { tags: "infra" })).toEqual({
      tags: "infra",
    })
    expect(buildInputPlaceholders(["{{ .inputs.tags.env }}"], { tags: null })).toEqual({
      tags: null,
    })
  })
})

describe("resolveCommandClientSide + buildMergedContext", () => {
  const base: TemplateContext = {
    inputs: { bucket: "my-bucket" },
    outputs: {},
  }

  it("resolves input references from the form context", () => {
    const resolved = resolveCommandClientSide("aws s3 ls s3://{{ .inputs.bucket }}", base)
    expect(resolved).toBe("aws s3 ls s3://my-bucket")
  })

  it("resolves output references from merged manual values", () => {
    const fields = detectManualFields("echo {{ .outputs.step.arn }}")
    const merged = buildMergedContext(
      base,
      fields,
      {
        "outputs.step.arn": "arn:aws:s3",
      },
      ["echo {{ .outputs.step.arn }}"],
    )
    const resolved = resolveCommandClientSide("echo {{ .outputs.step.arn }}", merged)
    expect(resolved).toBe("echo arn:aws:s3")
    expect(resolved).not.toContain("{{")
  })

  it("never leaves a raw {{ }} when an output value is still empty", () => {
    const fields = detectManualFields("echo {{ .outputs.step.arn }}")
    const merged = buildMergedContext(base, fields, {}, ["echo {{ .outputs.step.arn }}"])
    const resolved = resolveCommandClientSide("echo {{ .outputs.step.arn }}", merged)
    expect(resolved).not.toContain("{{")
    expect(resolved).toBe("echo <arn>")
  })

  it("never leaves a raw {{ }} for an input no form has set", () => {
    const command = "aws s3 ls s3://{{ .inputs.bucket }}/{{ .inputs.prefix }}"
    const merged = buildMergedContext({ inputs: { prefix: "logs" }, outputs: {} }, [], {}, [
      command,
    ])
    expect(resolveCommandClientSide(command, merged)).toBe("aws s3 ls s3://<bucket>/logs")
  })

  it("resolves a nested input reference", () => {
    const ctx: TemplateContext = { inputs: { _module: { source: "git::x" } }, outputs: {} }
    expect(resolveCommandClientSide("echo {{ .inputs._module.source }}", ctx)).toBe("echo git::x")
  })

  it("preserves a block's other output keys when layering a manual value", () => {
    // `step` already published `path` in context; only `step.arn` needs a prompt
    // (as fieldsNeedingPrompt would filter). Merging it must not drop `step.path`.
    const ctx: TemplateContext = {
      inputs: {},
      outputs: { step: { path: "/tmp/work" } },
    }
    const fields = detectManualFields("echo {{ .outputs.step.arn }}")
    const merged = buildMergedContext(ctx, fields, { "outputs.step.arn": "arn:aws:s3" }, [
      "echo {{ .outputs.step.arn }}",
    ])
    expect(merged.outputs.step).toEqual({ path: "/tmp/work", arn: "arn:aws:s3" })
  })
})

describe("fieldsNeedingPrompt", () => {
  const command =
    'curl -H "Authorization: Bearer {{ .outputs.fetch_token.api_token }}" {{ .outputs.fetch_token.url }}'

  it("skips an output the context already resolves", () => {
    const ctx: TemplateContext = {
      inputs: {},
      outputs: { fetch_token: { url: "https://api", api_token: "tok" } },
    }
    expect(fieldsNeedingPrompt(detectManualFields(command), ctx)).toEqual([])
  })

  // Instruction mode never shows a sensitive value, so the user pastes it
  it("prompts for a sensitive output even when the context holds it", () => {
    const ctx: TemplateContext = {
      inputs: {},
      outputs: { fetch_token: { url: "https://api", api_token: sensitiveOutput("real-secret") } },
    }
    expect(fieldsNeedingPrompt(detectManualFields(command), ctx).map((f) => f.id)).toEqual([
      "outputs.fetch_token.api_token",
    ])
  })
})

describe("normalizeCommandList", () => {
  it("handles undefined, string, and array", () => {
    expect(normalizeCommandList(undefined)).toEqual([])
    expect(normalizeCommandList("a")).toEqual(["a"])
    expect(normalizeCommandList(["a", "b"])).toEqual(["a", "b"])
  })
})
