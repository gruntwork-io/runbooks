// This is a comically over-engineered function whose job is to convert ACamelCaseVar to "A Camel Case Var".
// It's a mess, but it's tested, it's contained, and it works. Welcome to the new era of AI code.

// Utility function to convert camelCase to readable label
// e.g. The boilerplate variable name "AccountName" becomes "Account Name"

export const formatVariableLabel = (name: string): string => {
  // Common IT acronyms that should be capitalized
  const itAcronyms = new Set([
    'aws', 'gcp', 'api', 'sdk', 'cli', 'ui', 'ux', 'db', 'id', 'sql', 'http', 'https',
    'ssl', 'tls', 'dns', 'ip', 'url', 'json', 'xml',
    'html', 'css', 'js', 'ts', 'rest', 'jwt', 'saml', 'ldap',
    'vpc', 'vpn', 'cdn', 's3', 'ec2', 'rds', 'iam', 'kms', 'sns', 'sqs',
    'elb', 'alb', 'nlb', 'asg', 'ebs', 'efs', 'waf',
  ])
  
  // Special proper nouns that should be capitalized
  const properNouns = new Map([
    ['mysql', 'MySQL'],
    ['mongodb', 'MongoDB'],
    ['opentofu', 'OpenTofu'],
    ['github', 'GitHub'],
    ['gitlab', 'GitLab'],
  ])

  // Handle empty string
  if (!name) return name

  // Use regex to split camelCase words more intelligently
  const processed = name
    // Convert snake_case underscores to spaces
    .replace(/_/g, ' ')
    // Split on lowercase followed by uppercase
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Split on uppercase followed by lowercase (but not if it's part of an acronym)
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    // Split on number followed by letter
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    // Split on letter followed by number
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')


  const words = processed
    .split(' ')
    .filter(word => word.length > 0)

  // Post-process to merge certain patterns
  const mergedWords: string[] = []
  for (let i = 0; i < words.length; i++) {
    const current = words[i]
    const next = words[i + 1]
    const nextNext = words[i + 2]
    
    // Check if current + next words form a proper noun
    if (next && properNouns.has((current + next).toLowerCase())) {
      mergedWords.push(current + next)
      i++ // Skip the next word
      continue
    }
    
    // Merge single letter + number (e.g., "V" + "2" -> "V2", "s" + "3" -> "s3")
    if (current.length === 1 && /^[A-Za-z]$/.test(current) && next && /^\d+$/.test(next)) {
      mergedWords.push(current + next)
      i++ // Skip the next word
    }
    // Merge single letter + single letter (e.g., "I" + "P" -> "IP")
    else if (current.length === 1 && /^[A-Z]$/.test(current) && next && next.length === 1 && /^[A-Z]$/.test(next)) {
      mergedWords.push(current + next)
      i++ // Skip the next word
    }
    // Merge single letter + word starting with lowercase (e.g., "I" + "Ps" -> "IPs")
    else if (current.length === 1 && /^[A-Z]$/.test(current) && next && /^[A-Z][a-z]/.test(next)) {
      mergedWords.push(current + next)
      i++ // Skip the next word
    }
    // Merge single letter + word starting with number (e.g., "S" + "3Bucket" -> "S3Bucket")
    else if (current.length === 1 && /^[A-Z]$/.test(current) && next && /^\d/.test(next)) {
      mergedWords.push(current + next)
      i++ // Skip the next word
    }
    // Merge word + number (e.g., "HTTP" + "5" -> "HTTP5")
    else if (current.length > 1 && /^[A-Z]+$/.test(current) && next && /^\d+$/.test(next)) {
      mergedWords.push(current + next)
      i++ // Skip the next word
    }
    // Merge lowercase word + number (e.g., "http" + "5" -> "http5", "ec" + "2" -> "ec2")
    else if (current.length > 1 && /^[a-z]+$/.test(current) && next && /^\d+$/.test(next)) {
      mergedWords.push(current + next)
      i++ // Skip the next word
    }
    // Merge single letter + number + word (e.g., "E" + "c" + "2" -> "Ec2")
    else if (current.length === 1 && /^[A-Z]$/.test(current) && next && next.length === 1 && /^[a-z]$/.test(next) && nextNext && /^\d+$/.test(nextNext)) {
      mergedWords.push(current + next + nextNext)
      i += 2 // Skip the next two words
    }
    else {
      mergedWords.push(current)
    }
  }


  // Process each word
  return mergedWords
    .map(word => {
      const lowerWord = word.toLowerCase()
      
      // Handle IT acronyms (including those with numbers)
      if (itAcronyms.has(lowerWord) || 
          (lowerWord.startsWith('http') && /^\d+$/.test(lowerWord.slice(4))) ||
          (lowerWord.startsWith('ssl') && /^\d+$/.test(lowerWord.slice(3))) ||
          (lowerWord.startsWith('v') && /^\d+$/.test(lowerWord.slice(1)))) {
        return word.toUpperCase()
      }
      
      // Handle proper nouns
      if (properNouns.has(lowerWord)) {
        return properNouns.get(lowerWord)!
      }
      
      // Keep full acronyms (all caps) as-is
      if (word === word.toUpperCase() && word.length > 1) {
        return word
      }
      
      // Special case: if word is just numbers, keep as-is
      if (/^\d+$/.test(word)) {
        return word
      }
      
      // Otherwise capitalize first letter, preserve rest of casing
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}