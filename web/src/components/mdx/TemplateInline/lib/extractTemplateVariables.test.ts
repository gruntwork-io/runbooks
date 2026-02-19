import { describe, it, expect } from 'vitest'
import type { ReactNode } from 'react'
import { extractTemplateVariables } from './extractTemplateVariables'

describe('extractTemplateVariables', () => {
  it('extracts variables with no spaces', () => {
    const template = 'bucket = "{{.Environment}}-{{.AccountName}}-bucket"'
    const variables = extractTemplateVariables(template)
    expect(variables).toEqual(['Environment', 'AccountName'])
  })

  it('extracts variables with spaces around dots and braces', () => {
    const template = 'bucket = "{{ .Environment }}-{{ .AccountName }}-bucket"'
    const variables = extractTemplateVariables(template)
    expect(variables).toEqual(['Environment', 'AccountName'])
  })

  it('extracts variables with pipe functions', () => {
    const template = 'name = "{{ .ProjectName | UpperCase }}"'
    const variables = extractTemplateVariables(template)
    expect(variables).toEqual(['ProjectName'])
  })

  it('extracts variables with multiple pipe functions', () => {
    const template = 'name = "{{ .ProjectName | UpperCase | TrimSpace }}"'
    const variables = extractTemplateVariables(template)
    expect(variables).toEqual(['ProjectName'])
  })

  it('handles mixed spacing variations', () => {
    const template = `
      resource "aws_s3_bucket" "example" {
        bucket = "{{.AccountName}}-{{ .Environment }}-{{ .Region | lower }}-bucket"
        
        tags = {
          Account     = "{{ .AccountName }}"
          Environment = "{{.Environment}}"
          Region      = "{{ .Region | UpperCase }}"
        }
      }
    `
    const variables = extractTemplateVariables(template)
    expect(variables.sort()).toEqual(['AccountName', 'Environment', 'Region'].sort())
  })

  it('returns unique variables only', () => {
    const template = `
      {{ .Environment }}
      {{ .Environment }}
      {{ .Environment | lower }}
    `
    const variables = extractTemplateVariables(template)
    expect(variables).toEqual(['Environment'])
  })

  it('returns empty array for template with no variables', () => {
    const template = 'resource "aws_s3_bucket" "example" { bucket = "static-bucket" }'
    const variables = extractTemplateVariables(template)
    expect(variables).toEqual([])
  })

  it('handles complex Terraform/HCL templates', () => {
    const template = `
      terraform {
        backend "s3" {
          bucket = "{{ .TerraformStateBucket }}"
          key    = "{{ .Environment }}/{{ .Component }}/terraform.tfstate"
          region = "{{ .AWSRegion }}"
        }
      }

      provider "aws" {
        region = "{{ .AWSRegion }}"
        
        default_tags {
          tags = {
            Environment = "{{ .Environment | UpperCase }}"
            ManagedBy   = "Terraform"
            Component   = "{{.Component}}"
          }
        }
      }
    `
    const variables = extractTemplateVariables(template)
    expect(variables.sort()).toEqual(['AWSRegion', 'Component', 'Environment', 'TerraformStateBucket'].sort())
  })

  it('handles range loops and other Go template constructs', () => {
    const template = `
      locals {
        common_tags = {
          Account     = "{{ .AccountName }}"
          Environment = "{{ .Environment }}"
          {{ range $key, $value := .Tags }}
          {{ $key }} = "{{ $value }}"
          {{ end }}
        }
      }
    `
    const variables = extractTemplateVariables(template)
    // Should extract AccountName, Environment, and Tags (the root variable used in the range).
    // $key and $value are loop variables (prefixed with $) and should NOT be extracted.
    expect(variables.sort()).toEqual(['AccountName', 'Environment', 'Tags'].sort())
  })

  it('handles React element structure from MDX', () => {
    // Simulating what MDX might provide as children
    const mdxElement = {
      props: {
        children: {
          props: {
            value: 'bucket = "{{ .AccountName }}-{{ .Environment }}-bucket"',
            className: 'language-hcl'
          }
        }
      }
    } as ReactNode
    const variables = extractTemplateVariables(mdxElement)
    expect(variables).toEqual(['AccountName', 'Environment'])
  })

  it('handles array of children from MDX', () => {
    const mdxChildren = [
      'First line with {{ .Variable1 }}',
      {
        props: {
          value: 'Second line with {{ .Variable2 }}'
        }
      },
      'Third line with {{ .Variable3 | lower }}'
    ] as ReactNode
    const variables = extractTemplateVariables(mdxChildren)
    expect(variables.sort()).toEqual(['Variable1', 'Variable2', 'Variable3'].sort())
  })

  it('ignores variables without the dot prefix', () => {
    const template = 'value = "{{ Variable }}" and "{{ .RealVariable }}"'
    const variables = extractTemplateVariables(template)
    expect(variables).toEqual(['RealVariable'])
  })

  it('extracts root variable name from dotted paths', () => {
    const template = `
      terraform {
        source = "{{ ._module.source }}"
      }
      inputs = {
      {{- range $name, $hcl := ._module.hcl_inputs }}
        {{ $name }} = {{ $hcl }}
      {{- end }}
      }
    `
    const variables = extractTemplateVariables(template)
    // Should extract _module as the root variable (not _module.source or _module.hcl_inputs)
    expect(variables).toEqual(['_module'])
  })

  it('extracts both flat and dotted variables', () => {
    const template = `
      Bucket Name: {{ .bucket_name }}
      Versioning: {{ .versioning_enabled }}
      Source: {{ ._module.source }}
    `
    const variables = extractTemplateVariables(template)
    expect(variables.sort()).toEqual(['_module', 'bucket_name', 'versioning_enabled'].sort())
  })

  it('handles trimming whitespace markers in Go templates', () => {
    const template = `
      {{- range $name, $val := ._module.inputs }}
        {{ $name }}: {{ $val }}
      {{- end }}
    `
    const variables = extractTemplateVariables(template)
    expect(variables).toEqual(['_module'])
  })

  it('handles deeply nested dotted paths', () => {
    const template = '{{ ._module.nested.deep.path }}'
    const variables = extractTemplateVariables(template)
    expect(variables).toEqual(['_module'])
  })

  it('handles nested MDX structure', () => {
    const nestedMdx = {
      props: {
        children: {
          props: {
            children: [
              'Line 1: {{ .Var1 }}',
              {
                props: {
                  children: 'Line 2: {{ .Var2 }}'
                }
              }
            ]
          }
        }
      }
    } as ReactNode
    const variables = extractTemplateVariables(nestedMdx)
    expect(variables.sort()).toEqual(['Var1', 'Var2'].sort())
  })
})


