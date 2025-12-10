import React from 'react';
import { describe, it, expect } from 'vitest';
import { evaluate } from '@mdx-js/mdx';
import * as runtime from 'react/jsx-runtime';
import { extractTemplateFiles } from './extractTemplateFiles';

describe('extractTemplateFiles', () => {
  it('should extract code from HCL template with custom outputPath', async () => {
    const mdxContent = `<TemplatePreview inputsId="test" outputPath="main.tf">
\`\`\`hcl
resource "aws_instance" "web" {
  count = {{ .InstanceCount }}
}
\`\`\`
</TemplatePreview>`;

    const compiledMDX = await evaluate(mdxContent, {
      ...runtime,
      development: false,
      baseUrl: import.meta.url,
      useMDXComponents: () => ({
        TemplatePreview: () => React.createElement('div', {}, 'Test component'),
      })
    });

    const MDXComponent = compiledMDX.default;
    const componentResult = MDXComponent({});
    const children = componentResult.props.children;

    const result = extractTemplateFiles(children, 'main.tf');

    expect(result['main.tf']).toContain('resource "aws_instance" "web"');
    expect(result['main.tf']).toContain('count = {{ .InstanceCount }}');
  });

  it('should extract terraform variables with template syntax', async () => {
    const mdxContent = `<TemplatePreview inputsId="test" outputPath="variables.tf">
\`\`\`terraform
variable "instance_count" {
  type = number
  default = {{ .InstanceCount }}
}
\`\`\`
</TemplatePreview>`;

    const compiledMDX = await evaluate(mdxContent, {
      ...runtime,
      development: false,
      baseUrl: import.meta.url,
      useMDXComponents: () => ({
        TemplatePreview: () => React.createElement('div', {}, 'Test component'),
      })
    });

    const MDXComponent = compiledMDX.default;
    const componentResult = MDXComponent({});
    const children = componentResult.props.children;

    const result = extractTemplateFiles(children, 'variables.tf');

    expect(result['variables.tf']).toContain('variable "instance_count"');
    expect(result['variables.tf']).toContain('type = number');
    expect(result['variables.tf']).toContain('{{ .InstanceCount }}');
  });

  it('should return empty object when no code blocks found', async () => {
    const mdxContent = `<TemplatePreview inputsId="test">
Some regular text without code fences
</TemplatePreview>`;

    const compiledMDX = await evaluate(mdxContent, {
      ...runtime,
      development: false,
      baseUrl: import.meta.url,
      useMDXComponents: () => ({
        TemplatePreview: () => React.createElement('div', {}, 'Test component'),
      })
    });

    const MDXComponent = compiledMDX.default;
    const componentResult = MDXComponent({});
    const children = componentResult.props.children;

    const result = extractTemplateFiles(children);

    expect(result).toEqual({});
  });
});

