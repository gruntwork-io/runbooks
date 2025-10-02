import React from 'react';
import { describe, it, expect } from 'vitest';
import { extractInlineInputsId } from './extractInlineInputsId';

describe('extractInlineInputsId', () => {
  it('should return null when no BoilerplateInputs found', () => {
    expect(extractInlineInputsId(null)).toBe(null);
    expect(extractInlineInputsId(undefined)).toBe(null);
    expect(extractInlineInputsId(React.createElement('div', {}, 'content'))).toBe(null);
  });

  it('should extract id from BoilerplateInputs component', () => {
    function BoilerplateInputs({ id }: { id: string }) {
      return React.createElement('div', {}, `id: ${id}`);
    }
    
    const children = React.createElement(BoilerplateInputs, { id: 'test-id-123' });
    expect(extractInlineInputsId(children)).toBe('test-id-123');
  });

  it('should find BoilerplateInputs nested in children', () => {
    function BoilerplateInputs({ id }: { id: string }) {
      return React.createElement('div', {}, `id: ${id}`);
    }
    
    // Nested: div > section > BoilerplateInputs
    const nested = React.createElement(
      'div',
      {},
      React.createElement(
        'section',
        {},
        React.createElement(BoilerplateInputs, { id: 'nested-789' })
      )
    );
    
    expect(extractInlineInputsId(nested)).toBe('nested-789');
  });

  it('should find BoilerplateInputs in array of children', () => {
    function BoilerplateInputs({ id }: { id: string }) {
      return React.createElement('div', {}, `id: ${id}`);
    }
    
    const children = [
      React.createElement('div', { key: '1' }, 'First'),
      React.createElement(BoilerplateInputs, { key: '2', id: 'in-array' }),
      'Some text'
    ];
    
    expect(extractInlineInputsId(children)).toBe('in-array');
  });
});
