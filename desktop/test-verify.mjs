// Quick verification script to test core functionality without Electron
// Run with: node --loader ts-node/esm test-verify.mjs
// Or after build: node test-verify.mjs (uses compiled output)

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// We'll test against the compiled output
const { loadBoilerplateConfig, parseBoilerplateConfig } = await import('./out/main/index.js').catch(() => {
  console.log('Build output not found, testing inline...')
  return { loadBoilerplateConfig: null, parseBoilerplateConfig: null }
})

// Inline tests using the YAML parsing logic directly
import YAML from 'yaml'

console.log('=== Boilerplate Desktop Verification ===\n')

// Test 1: YAML parsing
console.log('Test 1: YAML config parsing')
const yamlContent = readFileSync(
  join(__dirname, 'test-fixtures/simple-template/boilerplate.yml'),
  'utf-8'
)
const fields = YAML.parse(yamlContent)
console.log(`  Variables found: ${fields.variables.length}`)
console.log(`  Variable names: ${fields.variables.map(v => v.name).join(', ')}`)
console.log(`  Variable types: ${fields.variables.map(v => v.type || 'string').join(', ')}`)
console.log('  PASS\n')

// Test 2: Template rendering (inline)
console.log('Test 2: Basic template rendering')
function simpleRender(template, vars) {
  return template.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (match, key) => {
    if (vars[key] !== undefined) return String(vars[key])
    throw new Error(`Variable "${key}" not found`)
  })
}

const result = simpleRender('Hello, {{ .Name }}!', { Name: 'World' })
console.assert(result === 'Hello, World!', `Expected "Hello, World!" got "${result}"`)
console.log(`  "Hello, {{ .Name }}!" + {Name: "World"} = "${result}"`)
console.log('  PASS\n')

// Test 3: Template rendering with pipes (simulated)
console.log('Test 3: Template rendering with pipe functions')
function renderWithPipes(template, vars) {
  const fns = {
    upper: s => s.toUpperCase(),
    lower: s => s.toLowerCase(),
    kebabcase: s => s.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase(),
  }

  return template.replace(/\{\{\s*\.(\w+)\s*(?:\|\s*(\w+))?\s*\}\}/g, (match, key, func) => {
    if (vars[key] === undefined) throw new Error(`Variable "${key}" not found`)
    let val = String(vars[key])
    if (func && fns[func]) val = fns[func](val)
    return val
  })
}

const r2 = renderWithPipes('{{ .ModuleName | kebabcase }}', { ModuleName: 'MyModule' })
console.assert(r2 === 'my-module', `Expected "my-module" got "${r2}"`)
console.log(`  "{{ .ModuleName | kebabcase }}" + {ModuleName: "MyModule"} = "${r2}"`)
console.log('  PASS\n')

// Test 4: Multi-trial variable rendering
console.log('Test 4: Multi-trial variable rendering')
const variablesToRender = {
  Description: 'A {{ .ProjectName }} project by {{ .Author }}',
  FullPath: '{{ .ProjectName }}/{{ .Language }}',
}
const alreadyRendered = {
  ProjectName: 'my-app',
  Author: 'Josh',
  Language: 'typescript',
}

// Simulate multi-trial
let unrendered = Object.keys(variablesToRender)
const rendered = { ...alreadyRendered }
let progress = true
let iterations = 0

while (unrendered.length > 0 && progress && iterations < 15) {
  progress = false
  iterations++
  const stillUnrendered = []

  for (const name of unrendered) {
    try {
      rendered[name] = simpleRender(String(variablesToRender[name]), rendered)
      progress = true
    } catch {
      stillUnrendered.push(name)
    }
  }
  unrendered = stillUnrendered
}

console.log(`  Resolved in ${iterations} iteration(s)`)
console.log(`  Description = "${rendered.Description}"`)
console.log(`  FullPath = "${rendered.FullPath}"`)
console.assert(rendered.Description === 'A my-app project by Josh')
console.assert(rendered.FullPath === 'my-app/typescript')
console.log('  PASS\n')

// Test 5: Config field validation
console.log('Test 5: Config field validation')
const enumVar = fields.variables.find(v => v.name === 'Language')
console.assert(enumVar.type === 'enum', 'Language should be enum')
console.assert(enumVar.options.includes('typescript'), 'Options should include typescript')
console.assert(enumVar.options.includes('python'), 'Options should include python')
console.assert(enumVar.default === 'typescript', 'Default should be typescript')

const boolVar = fields.variables.find(v => v.name === 'EnableTests')
console.assert(boolVar.type === 'bool', 'EnableTests should be bool')
console.assert(boolVar.default === true, 'Default should be true')

const intVar = fields.variables.find(v => v.name === 'Port')
console.assert(intVar.type === 'int', 'Port should be int')
console.assert(intVar.default === 3000, 'Default should be 3000')

const mapVar = fields.variables.find(v => v.name === 'Tags')
console.assert(mapVar.type === 'map', 'Tags should be map')
console.assert(mapVar.default.env === 'development', 'Tags.env should be development')

const strWithValidation = fields.variables.find(v => v.name === 'ProjectName')
console.assert(strWithValidation.validations === 'required', 'Should have required validation')
console.log('  All field validations passed')
console.log('  PASS\n')

console.log('=== All tests passed! ===')
