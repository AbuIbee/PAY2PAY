export interface StaffDisplayInfo {
  name: string | null;
  email: string | null;
}

/**
 * PRSprint 25: best-effort name/email lookup for staff-roster display —
 * mirrors the existing ProfileDisplayReader (src/lib/documents) and
 * UserEmailReader (./staffService) readers. Never used for authorization;
 * a missing/never-set name resolves to `null`, and the caller decides the
 * user-facing fallback (never a raw UUID).
 */
export interface StaffDisplayReader {
  loadDisplayInfo(userIds: string[]): Promise<Map<string, StaffDisplayInfo>>;
}
