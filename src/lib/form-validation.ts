/** Only validate visibility; preserve the original text, including emoji joiners. */
export function hasVisibleText(value: unknown): value is string {
  return typeof value === "string" && value.replace(/[\s\p{Cf}\p{Cc}\p{M}\u2800\u3164\u115f\u1160\uffa0]/gu, "").length > 0;
}

export function requiredText(message: string) {
  return {
    required: true,
    validator: (_: unknown, value: unknown) => hasVisibleText(value) ? Promise.resolve() : Promise.reject(new Error(message)),
  };
}

export function isFormValidationError(error: unknown): boolean {
  return !!error && typeof error === "object" && "errorFields" in error && Array.isArray(error.errorFields);
}
