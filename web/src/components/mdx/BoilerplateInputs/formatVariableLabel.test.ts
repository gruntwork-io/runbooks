import { describe, it, expect } from 'vitest'
import { formatVariableLabel } from './formatVariableLabel'

describe('formatVariableLabel', () => {
  describe('basic camelCase conversion', () => {
    it('should convert simple camelCase to readable format', () => {
      expect(formatVariableLabel('accountName')).toBe('Account Name')
      expect(formatVariableLabel('firstName')).toBe('First Name')
      expect(formatVariableLabel('lastName')).toBe('Last Name')
      expect(formatVariableLabel('emailAddress')).toBe('Email Address')
    })

    it('should handle single words', () => {
      expect(formatVariableLabel('name')).toBe('Name')
      expect(formatVariableLabel('email')).toBe('Email')
      expect(formatVariableLabel('url')).toBe('URL')
    })

    it('should handle multiple camelCase words', () => {
      expect(formatVariableLabel('awsAccountName')).toBe('AWS Account Name')
      expect(formatVariableLabel('databaseConnectionString')).toBe('Database Connection String')
      expect(formatVariableLabel('apiEndpointUrl')).toBe('API Endpoint URL')
      expect(formatVariableLabel('AllowedIPs')).toBe('Allowed IPs')
    })
  })

  describe('IT acronym handling', () => {
    it('should capitalize common IT acronyms', () => {
      expect(formatVariableLabel('awsRegion')).toBe('AWS Region')
      expect(formatVariableLabel('apiKey')).toBe('API Key')
      expect(formatVariableLabel('sdkVersion')).toBe('SDK Version')
      expect(formatVariableLabel('oauthFlow')).toBe('Oauth Flow') // Not ideal, but consistent
      expect(formatVariableLabel('samlAssertion')).toBe('SAML Assertion')
      expect(formatVariableLabel('XMLHttpRequest')).toBe('XML HTTP Request')
    })
  })

  describe('consecutive capitals handling', () => {
    it('should handle consecutive capitals correctly', () => {
      expect(formatVariableLabel('HTTPSConnection')).toBe('HTTPS Connection')
      expect(formatVariableLabel('JSONWebToken')).toBe('JSON Web Token')
      expect(formatVariableLabel('AWSAccountID')).toBe('AWS Account ID')
    })

    it('should preserve full acronyms', () => {
      expect(formatVariableLabel('API')).toBe('API')
      expect(formatVariableLabel('AWS')).toBe('AWS')
      expect(formatVariableLabel('RANDOM')).toBe('RANDOM')
    })
  })

  describe('edge cases', () => {
    it('should handle empty string', () => {
      expect(formatVariableLabel('')).toBe('')
    })

    it('should handle single character', () => {
      expect(formatVariableLabel('a')).toBe('A')
      expect(formatVariableLabel('A')).toBe('A')
    })

    it('should handle numbers in names', () => {
      expect(formatVariableLabel('apiV2')).toBe('API V2')
      expect(formatVariableLabel('http5Protocol')).toBe('HTTP5 Protocol')
      expect(formatVariableLabel('ssl3Version')).toBe('SSL3 Version')
    })

    it('should handle mixed case with numbers', () => {
      expect(formatVariableLabel('awsS3Bucket')).toBe('AWS S3 Bucket')
      expect(formatVariableLabel('ec2InstanceType')).toBe('EC2 Instance Type')
      expect(formatVariableLabel('rdsMysqlEngine')).toBe('RDS MySQL Engine')
    })

    it('should handle complex real-world examples', () => {
      expect(formatVariableLabel('awsAccountName')).toBe('AWS Account Name')
      expect(formatVariableLabel('databaseConnectionString')).toBe('Database Connection String')
      expect(formatVariableLabel('apiEndpointUrl')).toBe('API Endpoint URL')
      expect(formatVariableLabel('rdsMysqlDatabaseUrl')).toBe('RDS MySQL Database URL')
    })
  })

  describe('preserving existing capitalization', () => {
    it('should preserve proper nouns and special cases', () => {
      expect(formatVariableLabel('MysqlDatabase')).toBe('MySQL Database')
      expect(formatVariableLabel('mongodbCollection')).toBe('MongoDB Collection')
    })
  })
})
