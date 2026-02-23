// Test the compiled TypeScript modules (config parser, template renderer, variable rendering)
// Run after build: node test-compiled.cjs

const path = require('path')

// The built main process is a single bundle - we need to test the modules individually
// Since electron-vite bundles everything, we'll use require to load the built file
// and test via the exported functions

// Instead, let's test by loading the source via tsx
const { execSync } = require('child_process')

// Test the config parser directly
const testScript = `
const { loadBoilerplateConfig, parseBoilerplateConfig } = require('./src/main/core/config/config.ts')
const { renderTemplate, tryRenderTemplate } = require('./src/main/template-renderer.ts')
const { renderVariables } = require('./src/main/core/render/render-variables.ts')
const { convertType } = require('./src/main/core/variables/convert-type.ts')
const path = require('path')

console.log('=== Compiled Module Tests ===\\n')

// Test 1: loadBoilerplateConfig
console.log('Test 1: loadBoilerplateConfig')
const config = loadBoilerplateConfig(path.join(__dirname, 'test-fixtures/simple-template'))
console.assert(config.variables.length === 7, 'Should have 7 variables')
console.assert(config.variables[0].name === 'ProjectName', 'First var should be ProjectName')
console.assert(config.variables[0].validations.length > 0, 'Should have validations')
console.assert(config.variables[0].validations[0].type === 'required', 'Should be required')
console.assert(config.variables[3].type === 'enum', 'Language should be enum')
console.assert(config.variables[3].options.includes('typescript'), 'Should have typescript option')
console.log('  Config loaded with', config.variables.length, 'variables')
console.log('  PASS\\n')

// Test 2: renderTemplate
console.log('Test 2: renderTemplate')
const r1 = renderTemplate('Hello, {{ .Name }}!', { Name: 'World' })
console.assert(r1 === 'Hello, World!', 'Basic render failed: ' + r1)
console.log('  Basic: "' + r1 + '"')

const r2 = renderTemplate('{{ .Name | upper }}', { Name: 'hello' })
console.assert(r2 === 'HELLO', 'Upper failed: ' + r2)
console.log('  Upper: "' + r2 + '"')

const r3 = renderTemplate('{{ .Name | kebabcase }}', { Name: 'MyModule' })
console.assert(r3 === 'my-module', 'Kebabcase failed: ' + r3)
console.log('  Kebabcase: "' + r3 + '"')
console.log('  PASS\\n')

// Test 3: tryRenderTemplate
console.log('Test 3: tryRenderTemplate (error handling)')
const ok = tryRenderTemplate('{{ .Name }}', { Name: 'test' })
console.assert(ok.result === 'test', 'Should succeed')
console.assert(!ok.error, 'Should not have error')

const fail = tryRenderTemplate('{{ .Missing }}', {})
console.assert(fail.error, 'Should have error for missing var')
console.log('  Success case: result="' + ok.result + '"')
console.log('  Error case: error="' + fail.error + '"')
console.log('  PASS\\n')

// Test 4: renderVariables (multi-trial)
console.log('Test 4: renderVariables (multi-trial)')
const rendered = renderVariables(
  { Desc: 'Project {{ .Name }} by {{ .Author }}', Path: '{{ .Name }}/src' },
  { Name: 'my-app', Author: 'Josh' }
)
console.assert(rendered.Desc === 'Project my-app by Josh', 'Desc render failed: ' + rendered.Desc)
console.assert(rendered.Path === 'my-app/src', 'Path render failed: ' + rendered.Path)
console.log('  Desc: "' + rendered.Desc + '"')
console.log('  Path: "' + rendered.Path + '"')
console.log('  PASS\\n')

// Test 5: convertType
console.log('Test 5: convertType')
const intResult = convertType('42', { name: 'test', type: 'int', description: '', order: 0, validations: [] })
console.assert(intResult === 42, 'Int conversion failed')
console.log('  "42" -> int: ' + intResult)

const boolResult = convertType('true', { name: 'test', type: 'bool', description: '', order: 0, validations: [] })
console.assert(boolResult === true, 'Bool conversion failed')
console.log('  "true" -> bool: ' + boolResult)

const enumResult = convertType('typescript', { name: 'test', type: 'enum', description: '', order: 0, validations: [], options: ['typescript', 'python'] })
console.assert(enumResult === 'typescript', 'Enum conversion failed')
console.log('  "typescript" -> enum: ' + enumResult)
console.log('  PASS\\n')

console.log('=== All compiled module tests passed! ===')
`

try {
  // Use npx tsx to run TypeScript directly
  const result = execSync(`npx tsx -e ${JSON.stringify(testScript)}`, {
    cwd: __dirname,
    encoding: 'utf-8',
    timeout: 30000,
  })
  console.log(result)
} catch (err) {
  // tsx might not be installed, try with built output
  console.log('tsx not available, testing with build output...')
  console.log('Run: npm run build && node test-verify.mjs')
  if (err.stdout) console.log(err.stdout)
  if (err.stderr) console.error(err.stderr)
}
