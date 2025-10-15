/**
 * Check if user has set a "don't show again" preference for a given key
 */
export function shouldShowAlert(key: string): boolean {
  return localStorage.getItem(key) !== 'true';
}

/**
 * Set a "don't show again" preference for a given key
 */
export function setDontShowAgain(key: string): void {
  localStorage.setItem(key, 'true');
}

/**
 * Clear a "don't show again" preference for a given key
 */
export function clearDontShowAgain(key: string): void {
  localStorage.removeItem(key);
}

