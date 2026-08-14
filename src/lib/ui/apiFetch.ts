/**
 * Sprint 18B: thin client-side fetch wrapper matching the API's actual error
 * shape ({status:"error", code, message} — see src/lib/api-handler.ts).
 * Every UI data call should go through here rather than raw fetch, so
 * "step-up required" and other error codes are handled consistently instead
 * of each component re-parsing the response shape.
 */
export interface ApiErrorBody {
  status: "error";
  code: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(body: ApiErrorBody, httpStatus: number) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.httpStatus = httpStatus;
  }
}

export const STEP_UP_REQUIRED_CODE = "STEP_UP_REQUIRED";

export function isStepUpRequired(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === STEP_UP_REQUIRED_CODE;
}

/**
 * Runs `request` and throws ApiError on any non-2xx response with the
 * standard error shape. Callers that need to retry after a step-up
 * challenge should catch with isStepUpRequired() — see StepUpChallenge.tsx.
 */
export async function apiFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    if (body && body.status === "error") throw new ApiError(body, response.status);
    throw new ApiError({ status: "error", code: "UNKNOWN", message: "Something went wrong. Please try again." }, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
