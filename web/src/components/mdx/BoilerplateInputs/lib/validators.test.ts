import { describe, it, expect } from 'vitest'
import {
  isValidEmail,
  isValidUrl,
  isAlpha,
  isDigit,
  isAlphanumeric,
  isSemver,
  isValidLength,
  isCountryCode2,
  applyValidationRule
} from './validators'
import { BoilerplateValidationType } from '@/types/boilerplateVariable'
import type { ValidationRule } from '@/types/boilerplateVariable'

describe('validators', () => {
  describe('isValidEmail', () => {
    it('should accept valid email addresses', () => {
      expect(isValidEmail('user@example.com')).toBe(true)
      expect(isValidEmail('user.name@example.com')).toBe(true)
      expect(isValidEmail('user+tag@example.co.uk')).toBe(true)
      expect(isValidEmail('user123@subdomain.example.org')).toBe(true)
    })

    it('should reject invalid email addresses', () => {
      expect(isValidEmail('')).toBe(false)
      expect(isValidEmail('invalid')).toBe(false)
      expect(isValidEmail('invalid@')).toBe(false)
      expect(isValidEmail('@example.com')).toBe(false)
      expect(isValidEmail('user@')).toBe(false)
      expect(isValidEmail('user@example')).toBe(false)
      expect(isValidEmail('user name@example.com')).toBe(false)
    })
  })

  describe('isValidUrl', () => {
    it('should accept valid HTTP/HTTPS URLs', () => {
      expect(isValidUrl('https://example.com')).toBe(true)
      expect(isValidUrl('http://example.com')).toBe(true)
      expect(isValidUrl('https://www.example.com/path/to/page')).toBe(true)
      expect(isValidUrl('https://example.com:8080/path?query=value')).toBe(true)
      expect(isValidUrl('https://subdomain.example.co.uk')).toBe(true)
    })

    it('should reject invalid URLs', () => {
      expect(isValidUrl('')).toBe(false)
      expect(isValidUrl('example.com')).toBe(false)
      expect(isValidUrl('www.example.com')).toBe(false)
      expect(isValidUrl('ftp://example.com')).toBe(false)
      expect(isValidUrl('not a url')).toBe(false)
      expect(isValidUrl('javascript:alert(1)')).toBe(false)
    })
  })

  describe('isAlpha', () => {
    it('should accept strings with only letters', () => {
      expect(isAlpha('abc')).toBe(true)
      expect(isAlpha('ABC')).toBe(true)
      expect(isAlpha('HelloWorld')).toBe(true)
      expect(isAlpha('a')).toBe(true)
    })

    it('should reject strings with non-letter characters', () => {
      expect(isAlpha('')).toBe(false)
      expect(isAlpha('abc123')).toBe(false)
      expect(isAlpha('hello world')).toBe(false)
      expect(isAlpha('hello-world')).toBe(false)
      expect(isAlpha('hello_world')).toBe(false)
      expect(isAlpha('123')).toBe(false)
    })
  })

  describe('isDigit', () => {
    it('should accept strings with only digits', () => {
      expect(isDigit('123')).toBe(true)
      expect(isDigit('0')).toBe(true)
      expect(isDigit('9876543210')).toBe(true)
    })

    it('should reject strings with non-digit characters', () => {
      expect(isDigit('')).toBe(false)
      expect(isDigit('abc')).toBe(false)
      expect(isDigit('123abc')).toBe(false)
      expect(isDigit('12.34')).toBe(false)
      expect(isDigit('-123')).toBe(false)
      expect(isDigit('1 2 3')).toBe(false)
    })
  })

  describe('isAlphanumeric', () => {
    it('should accept strings with only letters and numbers', () => {
      expect(isAlphanumeric('abc123')).toBe(true)
      expect(isAlphanumeric('ABC')).toBe(true)
      expect(isAlphanumeric('123')).toBe(true)
      expect(isAlphanumeric('Hello123World')).toBe(true)
    })

    it('should reject strings with non-alphanumeric characters', () => {
      expect(isAlphanumeric('')).toBe(false)
      expect(isAlphanumeric('hello world')).toBe(false)
      expect(isAlphanumeric('hello-world')).toBe(false)
      expect(isAlphanumeric('hello_world')).toBe(false)
      expect(isAlphanumeric('hello@world')).toBe(false)
    })
  })

  describe('isSemver', () => {
    it('should accept valid semantic versions', () => {
      expect(isSemver('1.0.0')).toBe(true)
      expect(isSemver('0.0.1')).toBe(true)
      expect(isSemver('10.20.30')).toBe(true)
      expect(isSemver('1.2.3')).toBe(true)
    })

    it('should accept semantic versions with v prefix', () => {
      expect(isSemver('v1.0.0')).toBe(true)
      expect(isSemver('V1.0.0')).toBe(true)
      expect(isSemver('v0.0.1')).toBe(true)
      expect(isSemver('v10.20.30')).toBe(true)
    })

    it('should accept semantic versions with prerelease', () => {
      expect(isSemver('1.0.0-alpha')).toBe(true)
      expect(isSemver('1.0.0-alpha.1')).toBe(true)
      expect(isSemver('1.0.0-beta.2')).toBe(true)
      expect(isSemver('1.0.0-rc.1')).toBe(true)
      expect(isSemver('v1.0.0-alpha')).toBe(true)
    })

    it('should accept semantic versions with build metadata', () => {
      expect(isSemver('1.0.0+build')).toBe(true)
      expect(isSemver('1.0.0+build.123')).toBe(true)
      expect(isSemver('1.0.0-alpha+build')).toBe(true)
      expect(isSemver('v1.0.0+20230101')).toBe(true)
    })

    it('should reject invalid semantic versions', () => {
      expect(isSemver('')).toBe(false)
      expect(isSemver('1')).toBe(false)
      expect(isSemver('1.0')).toBe(false)
      expect(isSemver('1.0.0.0')).toBe(false)
      expect(isSemver('v')).toBe(false)
      expect(isSemver('version1.0.0')).toBe(false)
      expect(isSemver('1.0.a')).toBe(false)
      expect(isSemver('01.0.0')).toBe(false) // Leading zeros not allowed
    })
  })

  describe('isValidLength', () => {
    it('should accept strings within the length range', () => {
      expect(isValidLength('hello', 1, 10)).toBe(true)
      expect(isValidLength('a', 1, 10)).toBe(true)
      expect(isValidLength('1234567890', 1, 10)).toBe(true)
      expect(isValidLength('exact', 5, 5)).toBe(true)
    })

    it('should reject strings outside the length range', () => {
      expect(isValidLength('', 1, 10)).toBe(false)
      expect(isValidLength('hello world!', 1, 10)).toBe(false)
      expect(isValidLength('ab', 5, 10)).toBe(false)
    })
  })

  describe('isCountryCode2', () => {
    it('should accept valid two-letter country codes', () => {
      expect(isCountryCode2('US')).toBe(true)
      expect(isCountryCode2('GB')).toBe(true)
      expect(isCountryCode2('DE')).toBe(true)
      expect(isCountryCode2('JP')).toBe(true)
      expect(isCountryCode2('us')).toBe(true) // lowercase should work
      expect(isCountryCode2('Gb')).toBe(true) // mixed case should work
    })

    it('should reject invalid country codes', () => {
      expect(isCountryCode2('')).toBe(false)
      expect(isCountryCode2('U')).toBe(false)
      expect(isCountryCode2('USA')).toBe(false)
      expect(isCountryCode2('12')).toBe(false)
      expect(isCountryCode2('U1')).toBe(false)
    })
  })
})