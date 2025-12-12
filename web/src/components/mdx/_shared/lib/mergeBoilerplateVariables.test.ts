import { describe, it, expect } from 'vitest';
import { mergeBoilerplateVariables } from './mergeBoilerplateVariables';

describe('mergeBoilerplateVariables', () => {
  const variablesByInputsId: Record<string, Record<string, unknown>> = {
    'lambda-config': {
      FunctionName: 'my-lambda',
      Environment: 'dev',
      AwsRegion: 'us-east-1',
    },
    'repo-config': {
      GithubOrgName: 'gruntwork-io',
      GithubRepoName: 'runbooks-example',
      Environment: 'prod', // Intentional conflict with lambda-config
    },
    'inline-vars': {
      CustomVar: 'inline-value',
      Environment: 'staging', // Intentional conflict - should win
    },
  };

  describe('single inputsId (string)', () => {
    it('should return variables from a single ID', () => {
      const result = mergeBoilerplateVariables('lambda-config', variablesByInputsId);
      
      expect(result).toEqual({
        FunctionName: 'my-lambda',
        Environment: 'dev',
        AwsRegion: 'us-east-1',
      });
    });

    it('should return empty object for non-existent ID', () => {
      const result = mergeBoilerplateVariables('non-existent', variablesByInputsId);
      
      expect(result).toEqual({});
    });
  });

  describe('multiple inputsIds (array)', () => {
    it('should merge variables from multiple IDs', () => {
      const result = mergeBoilerplateVariables(
        ['lambda-config', 'repo-config'],
        variablesByInputsId
      );
      
      expect(result).toEqual({
        FunctionName: 'my-lambda',
        AwsRegion: 'us-east-1',
        GithubOrgName: 'gruntwork-io',
        GithubRepoName: 'runbooks-example',
        Environment: 'prod', // repo-config wins (later in array)
      });
    });

    it('should apply variables in order (later IDs override earlier)', () => {
      // Order matters: repo-config comes after lambda-config
      const result1 = mergeBoilerplateVariables(
        ['lambda-config', 'repo-config'],
        variablesByInputsId
      );
      expect(result1.Environment).toBe('prod'); // repo-config wins

      // Reverse order: lambda-config comes after repo-config
      const result2 = mergeBoilerplateVariables(
        ['repo-config', 'lambda-config'],
        variablesByInputsId
      );
      expect(result2.Environment).toBe('dev'); // lambda-config wins
    });

    it('should skip non-existent IDs in array', () => {
      const result = mergeBoilerplateVariables(
        ['lambda-config', 'non-existent', 'repo-config'],
        variablesByInputsId
      );
      
      expect(result).toEqual({
        FunctionName: 'my-lambda',
        AwsRegion: 'us-east-1',
        GithubOrgName: 'gruntwork-io',
        GithubRepoName: 'runbooks-example',
        Environment: 'prod',
      });
    });

    it('should handle empty array', () => {
      const result = mergeBoilerplateVariables([], variablesByInputsId);
      
      expect(result).toEqual({});
    });
  });

  describe('inline variables precedence', () => {
    it('should give inline variables highest precedence', () => {
      const result = mergeBoilerplateVariables(
        ['lambda-config', 'repo-config'],
        variablesByInputsId,
        'inline-vars'
      );
      
      expect(result).toEqual({
        FunctionName: 'my-lambda',
        AwsRegion: 'us-east-1',
        GithubOrgName: 'gruntwork-io',
        GithubRepoName: 'runbooks-example',
        CustomVar: 'inline-value',
        Environment: 'staging', // inline-vars wins over both
      });
    });

    it('should handle inline variables with single inputsId', () => {
      const result = mergeBoilerplateVariables(
        'lambda-config',
        variablesByInputsId,
        'inline-vars'
      );
      
      expect(result.Environment).toBe('staging'); // inline wins
      expect(result.FunctionName).toBe('my-lambda'); // from lambda-config
      expect(result.CustomVar).toBe('inline-value'); // from inline
    });

    it('should handle null inlineInputsId', () => {
      const result = mergeBoilerplateVariables(
        'lambda-config',
        variablesByInputsId,
        null
      );
      
      expect(result.Environment).toBe('dev');
    });
  });

  describe('edge cases', () => {
    it('should return empty object when inputsId is undefined', () => {
      const result = mergeBoilerplateVariables(undefined, variablesByInputsId);
      
      expect(result).toEqual({});
    });

    it('should handle empty variablesByInputsId', () => {
      const result = mergeBoilerplateVariables(['lambda-config'], {});
      
      expect(result).toEqual({});
    });

    it('should handle single ID in array same as string', () => {
      const resultArray = mergeBoilerplateVariables(['lambda-config'], variablesByInputsId);
      const resultString = mergeBoilerplateVariables('lambda-config', variablesByInputsId);
      
      expect(resultArray).toEqual(resultString);
    });
  });
});

