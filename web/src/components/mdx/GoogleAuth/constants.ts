// Complete list of generally available Google Cloud regions.
// `name` is the location Google publishes for the region (state for US regions,
// city/country elsewhere); `geography` is the broad grouping the picker groups by.
export const GCP_REGIONS = [
  // North America — United States
  { code: 'us-central1', name: 'Iowa', geography: 'North America' },
  { code: 'us-east1', name: 'South Carolina', geography: 'North America' },
  { code: 'us-east4', name: 'Northern Virginia', geography: 'North America' },
  { code: 'us-east5', name: 'Columbus, Ohio', geography: 'North America' },
  { code: 'us-south1', name: 'Dallas, Texas', geography: 'North America' },
  { code: 'us-west1', name: 'Oregon', geography: 'North America' },
  { code: 'us-west2', name: 'Los Angeles', geography: 'North America' },
  { code: 'us-west3', name: 'Salt Lake City', geography: 'North America' },
  { code: 'us-west4', name: 'Las Vegas', geography: 'North America' },
  // North America — Canada and Mexico
  { code: 'northamerica-northeast1', name: 'Montréal', geography: 'North America' },
  { code: 'northamerica-northeast2', name: 'Toronto', geography: 'North America' },
  { code: 'northamerica-south1', name: 'Querétaro, Mexico', geography: 'North America' },
  // South America
  { code: 'southamerica-east1', name: 'São Paulo', geography: 'South America' },
  { code: 'southamerica-west1', name: 'Santiago', geography: 'South America' },
  // Europe
  { code: 'europe-central2', name: 'Warsaw', geography: 'Europe' },
  { code: 'europe-north1', name: 'Hamina, Finland', geography: 'Europe' },
  { code: 'europe-north2', name: 'Stockholm', geography: 'Europe' },
  { code: 'europe-southwest1', name: 'Madrid', geography: 'Europe' },
  { code: 'europe-west1', name: 'Belgium', geography: 'Europe' },
  { code: 'europe-west2', name: 'London', geography: 'Europe' },
  { code: 'europe-west3', name: 'Frankfurt', geography: 'Europe' },
  { code: 'europe-west4', name: 'Netherlands', geography: 'Europe' },
  { code: 'europe-west6', name: 'Zurich', geography: 'Europe' },
  { code: 'europe-west8', name: 'Milan', geography: 'Europe' },
  { code: 'europe-west9', name: 'Paris', geography: 'Europe' },
  { code: 'europe-west10', name: 'Berlin', geography: 'Europe' },
  { code: 'europe-west12', name: 'Turin', geography: 'Europe' },
  // Middle East
  { code: 'me-central1', name: 'Doha, Qatar', geography: 'Middle East' },
  { code: 'me-central2', name: 'Dammam, Saudi Arabia', geography: 'Middle East' },
  { code: 'me-west1', name: 'Tel Aviv, Israel', geography: 'Middle East' },
  // Africa
  { code: 'africa-south1', name: 'Johannesburg', geography: 'Africa' },
  // Asia
  { code: 'asia-east1', name: 'Taiwan', geography: 'Asia Pacific' },
  { code: 'asia-east2', name: 'Hong Kong', geography: 'Asia Pacific' },
  { code: 'asia-northeast1', name: 'Tokyo', geography: 'Asia Pacific' },
  { code: 'asia-northeast2', name: 'Osaka', geography: 'Asia Pacific' },
  { code: 'asia-northeast3', name: 'Seoul', geography: 'Asia Pacific' },
  { code: 'asia-south1', name: 'Mumbai', geography: 'Asia Pacific' },
  { code: 'asia-south2', name: 'Delhi', geography: 'Asia Pacific' },
  { code: 'asia-southeast1', name: 'Singapore', geography: 'Asia Pacific' },
  { code: 'asia-southeast2', name: 'Jakarta', geography: 'Asia Pacific' },
  // Australia
  { code: 'australia-southeast1', name: 'Sydney', geography: 'Australia' },
  { code: 'australia-southeast2', name: 'Melbourne', geography: 'Australia' },
] as const

export type GcpRegionCode = typeof GCP_REGIONS[number]['code']

/**
 * OAuth scopes requested by the Google Sign-In tab when the author does not set
 * the `scopes` prop.
 *
 * Deliberately duplicated from `DEFAULT_GOOGLE_SCOPES` in
 * `src/domain/google/auth.ts` (the authority, used by main when the renderer
 * sends no scopes): `web/` must not import from `src/domain/`. This copy exists
 * so instruction mode can render the scope hint without an IPC round trip.
 */
export const DEFAULT_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
] as const


/**
 * Hand-run equivalent of Google Sign-In with the author's scopes. Duplicated
 * from `src/domain/google/scopes.ts` so instruction mode and the insufficient-
 * scopes card can render without importing from `src/domain/`.
 */
export function formatGcloudAdcLoginCommand(scopes: readonly string[]): string {
  if (scopes.length === 0) return 'gcloud auth application-default login'
  return `gcloud auth application-default login --scopes=${scopes.join(',')}`
}
