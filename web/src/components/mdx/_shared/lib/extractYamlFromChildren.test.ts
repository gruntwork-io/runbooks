import React from 'react';
import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import { evaluate } from '@mdx-js/mdx';
import * as runtime from 'react/jsx-runtime';
import type { ReactNode } from 'react';
import remarkGfm from 'remark-gfm';
import { extractYamlFromChildren } from './extractYamlFromChildren';
import { CodeBlock } from '../components/CodeBlock';

/**
 * Compiles MDX containing a single <Inputs> block with the same evaluate and
 * remark-gfm options as MDXContainer, and returns the children MDX passes to
 * it. The app's rehype plugins (asset paths, task-list ids) are left out; they
 * don't touch Inputs content.
 */
async function compileInputsChildren(
  mdxContent: string,
  components: Record<string, unknown> = {},
): Promise<ReactNode> {
  const compiledMDX = await evaluate(mdxContent, {
    ...runtime,
    development: false,
    baseUrl: import.meta.url,
    remarkPlugins: [remarkGfm],
    useMDXComponents: () => ({
      Inputs: () => React.createElement('div', {}, 'Test component'),
      ...components,
    }),
  });
  return compiledMDX.default({}).props.children;
}

const MISSING_FENCE_ERROR = 'Invalid inline boilerplate configuration format';

describe('extractYamlFromChildren', () => {
  it('should extract YAML from real MDX compilation and parse it correctly', async () => {
    // Use the exact same MDX content from the real runbook file
    const mdxContent = `<Inputs id="test">
\`\`\`yaml
variables:
  - name: AccountName
    description: Name for the AWS account
    type: string
    default: "My account"
    
  - name: Environment
    description: Deployment environment
    type: enum
    options:
      - dev
      - stage
      - prod
    default: dev
\`\`\`
</Inputs>`;

    // Compile the MDX with the app's evaluate options
    const capturedChildren = await compileInputsChildren(mdxContent);

    const extractedYaml = extractYamlFromChildren(capturedChildren);

    // Parse the extracted YAML to verify it is well-formed.
    const parsedYaml = YAML.parse(extractedYaml.content);
    
    // Verify the parsed structure
    expect(parsedYaml).toBeDefined();
    expect(parsedYaml.variables).toBeDefined();
    expect(Array.isArray(parsedYaml.variables)).toBe(true);
    expect(parsedYaml.variables).toHaveLength(2);
    
    // Check first variable
    const accountNameVar = parsedYaml.variables.find((v: { name: string }) => v.name === 'AccountName');
    expect(accountNameVar).toBeDefined();
    expect(accountNameVar.description).toBe('Name for the AWS account');
    expect(accountNameVar.type).toBe('string');
    expect(accountNameVar.default).toBe('My account');
    
    // Check second variable
    const environmentVar = parsedYaml.variables.find((v: { name: string }) => v.name === 'Environment');
    expect(environmentVar).toBeDefined();
    expect(environmentVar.description).toBe('Deployment environment');
    expect(environmentVar.type).toBe('enum');
    expect(environmentVar.options).toEqual(['dev', 'stage', 'prod']);
    expect(environmentVar.default).toBe('dev');
  });

  it('extracts fenced YAML when pre is rendered by the CodeBlock component', async () => {
    const children = await compileInputsChildren(`<Inputs id="test">
\`\`\`yaml
variables:
  - name: Region
    default: us-east-1
\`\`\`
</Inputs>`, { pre: CodeBlock });

    // The fence's trailing newline is trimmed only when CodeBlock is recognized as a pre element
    expect(extractYamlFromChildren(children)).toEqual({
      content: 'variables:\n  - name: Region\n    default: us-east-1',
      error: null,
    });
  });

  it('extracts single-line inline YAML passed as a plain string', async () => {
    const children = await compileInputsChildren('<Inputs id="test">variables: []</Inputs>');

    expect(extractYamlFromChildren(children)).toEqual({ content: 'variables: []', error: null });
  });

  it('rejects unfenced YAML with a code-fence configuration error', async () => {
    const children = await compileInputsChildren(`<Inputs id="test">
variables:
  - name: AccountName
    type: string
  - name: Environment
    type: string
</Inputs>`);

    const result = extractYamlFromChildren(children);

    expect(result.content).toBe('');
    expect(result.error?.message).toBe(MISSING_FENCE_ERROR);
    expect(result.error?.details).toContain('code fence');
  });

  it('rejects unfenced YAML separated by blank lines with a code-fence configuration error', async () => {
    const children = await compileInputsChildren(`<Inputs id="test">
variables:

  - name: AccountName
    type: string

  - name: Environment
    type: enum
    options:
      - dev
      - prod
    default: dev
</Inputs>`);

    const result = extractYamlFromChildren(children);

    expect(result.content).toBe('');
    expect(result.error?.message).toBe(MISSING_FENCE_ERROR);
  });
});
