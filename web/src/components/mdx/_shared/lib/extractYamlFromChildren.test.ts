import React from 'react';
import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import { evaluate } from '@mdx-js/mdx';
import * as runtime from 'react/jsx-runtime';
import { extractYamlFromChildren } from './extractYamlFromChildren';

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

    // Compile the MDX exactly as the real application does
    const compiledMDX = await evaluate(mdxContent, {
      ...runtime,
      development: false,
      baseUrl: import.meta.url,
      useMDXComponents: () => ({
        Inputs: () => {
          return React.createElement('div', {}, 'Test component');
        },
      })
    });

    // Create the component and get the actual children structure
    const MDXComponent = compiledMDX.default;
    
    // Call the component to get the React element tree
    const componentResult = MDXComponent({ id: "test" });
    
    // Extract the children from the component result
    // The children are the content inside the <NoName> wrapper
    const capturedChildren = componentResult.props.children;

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
});