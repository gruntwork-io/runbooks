/**
 * A field's label, from its name, as today's form writes it
 * (web/src/components/mdx/_shared/lib/formatVariableLabel.ts): `AwsAccountName`
 * and `aws_account_name` are "AWS Account Name". Words split at case changes,
 * underscores and digits; IT acronyms are upper case, a few proper nouns
 * keep their own case, and any other word starts upper case.
 */

const ACRONYMS: ReadonlySet<string> = new Set(
  [
    "aws gcp api sdk cli ui ux db id sql http https ssl tls dns ip url json xml html css js ts",
    "rest jwt saml ldap vpc vpn cdn s3 ec2 rds iam kms sns sqs elb alb nlb asg ebs efs waf",
  ].flatMap((line) => line.split(" ")),
)

const PROPER_NOUNS: ReadonlyMap<string, string> = new Map([
  ["mysql", "MySQL"],
  ["mongodb", "MongoDB"],
  ["opentofu", "OpenTofu"],
  ["github", "GitHub"],
  ["gitlab", "GitLab"],
])

const LETTER = /^[A-Za-z]$/
const UPPER = /^[A-Z]$/
const LOWER = /^[a-z]$/
const DIGITS = /^\d+$/

/** How many of the words from `at` make one word: a proper noun split in two, or an acronym split by the case rules. */
function joined(words: ReadonlyArray<string>, at: number): number {
  const word = words[at] ?? ""
  const next = words[at + 1]
  const after = words[at + 2]
  if (next === undefined) return 1
  if (PROPER_NOUNS.has((word + next).toLowerCase())) return 2
  // "V" "2", "s" "3": a letter and a number.
  if (LETTER.test(word) && DIGITS.test(next)) return 2
  if (UPPER.test(word)) {
    // "I" "P", "I" "Ps", "S" "3Bucket".
    if (UPPER.test(next) || /^[A-Z][a-z]/.test(next) || /^\d/.test(next)) return 2
    // "E" "c" "2".
    if (LOWER.test(next) && after !== undefined && DIGITS.test(after)) return 3
  }
  // "HTTP" "5", "ec" "2".
  if (word.length > 1 && /^(?:[A-Z]+|[a-z]+)$/.test(word) && DIGITS.test(next)) return 2
  return 1
}

function wordOf(word: string): string {
  const lower = word.toLowerCase()
  if (ACRONYMS.has(lower) || /^(?:http|ssl|v)\d+$/.test(lower)) return word.toUpperCase()
  const proper = PROPER_NOUNS.get(lower)
  if (proper !== undefined) return proper
  if (word.length > 1 && word === word.toUpperCase()) return word
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export function fieldLabel(name: string): string {
  const words = name
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .split(" ")
    .filter((word) => word.length > 0)
  const merged: string[] = []
  for (let at = 0; at < words.length;) {
    const count = joined(words, at)
    merged.push(words.slice(at, at + count).join(""))
    at += count
  }
  return merged.map(wordOf).join(" ")
}
