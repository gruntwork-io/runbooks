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
    // Should extract AccountName and Environment, but not Tags, $key, $value (those are loop variables)
    expect(variables.sort()).toEqual(['AccountName', 'Environment'].sort())
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


