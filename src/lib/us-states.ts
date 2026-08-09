/**
 * USPS state/territory codes for the early-access form's state field
 * (docs/sprints/SPRINT_01_PublicPreview _VercelReadiness.md item 5). Shared
 * between the client form and the server-side validation schema so the two
 * can never drift.
 */
export const US_STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
  "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM",
  "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY", "PR", "GU", "VI", "AS", "MP",
] as const;

export type UsStateCode = (typeof US_STATE_CODES)[number];
