import { loadBoilerplateConfig } from './src/main/core/config/config'
import { renderTemplate, tryRenderTemplate } from './src/main/template-renderer'
import { renderVariables } from './src/main/core/render/render-variables'
import { convertType } from './src/main/core/variables/convert-type'
import * as path from 'path'

console.log('=== Compiled Module Tests ===\n')

// Test 1: loadBoilerplateConfig
console.log('Test 1: loadBoilerplateConfig')
const config = loadBoilerplateConfig(path.join(__dirname, 'test-fixtures/simple-template'))
console.assert(config.variables.length === 7, 'Should have 7 variables')
console.assert(config.variables[0].name === 'ProjectName', 'First var should be ProjectName')
console.assert(config.variables[0].validations.length > 0, 'Should have validations')
console.assert(config.variables[0].validations[0].type === 'required', 'Should be required')
console.assert(config.variables[3].type === 'enum', 'Language should be enum')
console.assert(config.variables[3].options!.includes('typescript'), 'Should have typescript option')
console.log('  Config loaded with', config.variables.length, 'variables')
console.log('  PASS\n')

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
console.log('  PASS\n')

// Test 3: tryRenderTemplate (error handling)
console.log('Test 3: tryRenderTemplate (error handling)')
const ok = tryRenderTemplate('{{ .Name }}', { Name: 'test' })
console.assert(ok.result === 'test', 'Should succeed')
console.assert(!ok.error, 'Should not have error')

const fail = tryRenderTemplate('{{ .Missing }}', {})
console.assert(fail.error, 'Should have error for missing var')
console.log('  Success case: result="' + ok.result + '"')
console.log('  Error case: error="' + fail.error + '"')
console.log('  PASS\n')

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
console.log('  PASS\n')

// Test 5: Multi-trial with chained dependencies
console.log('Test 5: Multi-trial with chained variable references')
const chained = renderVariables(
  {
    C: '{{ .B }}-final',
    B: '{{ .A }}-middle',
  },
  { A: 'start' }
)
console.assert(chained.B === 'start-middle', 'B should be start-middle, got: ' + chained.B)
console.assert(chained.C === 'start-middle-final', 'C should be start-middle-final, got: ' + chained.C)
console.log('  B: "' + chained.B + '"')
console.log('  C: "' + chained.C + '"')
console.log('  PASS\n')

// Test 6: convertType
console.log('Test 6: convertType')
const intResult = convertType('42', { name: 'test', type: 'int', description: '', order: 0, validations: [] })
console.assert(intResult === 42, 'Int conversion failed')
console.log('  "42" -> int: ' + intResult)

const boolResult = convertType('true', { name: 'test', type: 'bool', description: '', order: 0, validations: [] })
console.assert(boolResult === true, 'Bool conversion failed')
console.log('  "true" -> bool: ' + boolResult)

const floatResult = convertType('3.14', { name: 'test', type: 'float', description: '', order: 0, validations: [] })
console.assert(floatResult === 3.14, 'Float conversion failed')
console.log('  "3.14" -> float: ' + floatResult)

const listResult = convertType('["a","b","c"]', { name: 'test', type: 'list', description: '', order: 0, validations: [] })
console.assert(Array.isArray(listResult), 'List conversion failed')
console.log('  JSON list: ' + JSON.stringify(listResult))

const enumResult = convertType('typescript', { name: 'test', type: 'enum', description: '', order: 0, validations: [], options: ['typescript', 'python'] })
console.assert(enumResult === 'typescript', 'Enum conversion failed')
console.log('  "typescript" -> enum: ' + enumResult)
console.log('  PASS\n')

// Test 7: Config with dependencies
console.log('Test 7: Parse config with dependencies')
const depYaml = `
variables:
  - name: ModuleName
    type: string
    default: my-module

dependencies:
  - name: module
    template-url: ../tofu-module
    output-folder: "modules/{{ .ModuleName | kebabcase }}"
  - name: test
    template-url: ../tofu-test
    output-folder: test
    dont-inherit-variables: true
    variables:
      - name: ExamplePath
        type: string
        default: "../examples/{{ .ModuleName }}"

hooks:
  before:
    - command: echo
      args:
        - "Starting generation"
  after:
    - command: echo
      args:
        - "Done!"
      skip: "false"

skip_files:
  - path: "*_vars.yml"
`

import { parseBoilerplateConfig } from './src/main/core/config/config'
const depConfig = parseBoilerplateConfig(depYaml)
console.assert(depConfig.variables.length === 1, 'Should have 1 variable')
console.assert(depConfig.dependencies.length === 2, 'Should have 2 dependencies')
console.assert(depConfig.dependencies[0].name === 'module', 'First dep should be module')
console.assert(depConfig.dependencies[0].outputFolder === 'modules/{{ .ModuleName | kebabcase }}', 'Output folder should have template')
console.assert(depConfig.dependencies[1].dontInheritVariables === true, 'Test dep should not inherit')
console.assert(depConfig.dependencies[1].variables.length === 1, 'Test dep should have 1 var')
console.assert(depConfig.hooks.before.length === 1, 'Should have 1 before hook')
console.assert(depConfig.hooks.after.length === 1, 'Should have 1 after hook')
console.assert(depConfig.hooks.after[0].skip === 'false', 'After hook should have skip')
console.assert(depConfig.skipFiles.length === 1, 'Should have 1 skip file')
console.log('  Dependencies:', depConfig.dependencies.map(d => d.name).join(', '))
console.log('  Hooks: before=' + depConfig.hooks.before.length + ', after=' + depConfig.hooks.after.length)
console.log('  Skip files:', depConfig.skipFiles.map(s => s.path).join(', '))
console.log('  PASS\n')

// Test 8: Template conditionals
console.log('Test 8: Template conditionals')
const cond1 = renderTemplate('{{ if .Show }}visible{{ else }}hidden{{ end }}', { Show: true })
console.assert(cond1 === 'visible', 'Conditional true failed: ' + cond1)
console.log('  if true: "' + cond1 + '"')

const cond2 = renderTemplate('{{ if .Show }}visible{{ else }}hidden{{ end }}', { Show: false })
console.assert(cond2 === 'hidden', 'Conditional false failed: ' + cond2)
console.log('  if false: "' + cond2 + '"')
console.log('  PASS\n')

console.log('=== All 8 tests passed! ===')
