import React from 'react';
import { describe, it, expect } from 'vitest';
import { extractInlineInputsId } from './extractInlineInputsId';

describe('extractInlineInputsId', () => {
  it('should return null when no Inputs found', () => {
    expect(extractInlineInputsId(null)).toBe(null);
    expect(extractInlineInputsId(undefined)).toBe(null);
    expect(extractInlineInputsId(React.createElement('div', {}, 'content'))).toBe(null);
  });

  it('should extract id from Inputs component', () => {
    function Inputs({ id }: { id: string }) {
      return React.createElement('div', {}, `id: ${id}`);
    }
    
    const children = React.createElement(Inputs, { id: 'inputs-test-456' });
    expect(extractInlineInputsId(children)).toBe('inputs-test-456');
  });

  it('should extract id from Inputs component with displayName', () => {
    function InputsComponent({ id }: { id: string }) {
      return React.createElement('div', {}, `id: ${id}`);
    }
    InputsComponent.displayName = 'Inputs';
    
    const children = React.createElement(InputsComponent, { id: 'displayname-test-789' });
    expect(extractInlineInputsId(children)).toBe('displayname-test-789');
  });

  it('should find Inputs nested in children', () => {
    function Inputs({ id }: { id: string }) {
      return React.createElement('div', {}, `id: ${id}`);
    }
    
    // Nested: div > section > Inputs
    const nested = React.createElement(
      'div',
      {},
      React.createElement(
        'section',
        {},
        React.createElement(Inputs, { id: 'nested-789' })
      )
    );
    
    expect(extractInlineInputsId(nested)).toBe('nested-789');
  });

  it('should find Inputs in array of children', () => {
    function Inputs({ id }: { id: string }) {
      return React.createElement('div', {}, `id: ${id}`);
    }
    
    const children = [
      React.createElement('div', { key: '1' }, 'First'),
      React.createElement(Inputs, { key: '2', id: 'in-array' }),
      'Some text'
    ];
    
    expect(extractInlineInputsId(children)).toBe('in-array');
  });
});
