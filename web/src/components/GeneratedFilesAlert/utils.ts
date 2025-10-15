import { shouldShowAlert, setDontShowAgain } from '../../lib/localStorage';

export const GENERATED_FILES_ALERT_KEY = 'runbooks-dont-ask-generated-files';

/**
 * Check if the generated files alert should be shown
 */
export function shouldShowGeneratedFilesAlert(): boolean {
  return shouldShowAlert(GENERATED_FILES_ALERT_KEY);
}

/**
 * Mark the generated files alert as dismissed
 */
export function dismissGeneratedFilesAlert(): void {
  setDontShowAgain(GENERATED_FILES_ALERT_KEY);
}


