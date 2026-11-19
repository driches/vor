/**
 * Validators for the public-facing signup endpoint. Returns
 * `null` on success and an error message on failure.
 */

/**
 * Validate that `age` is in the allowed range for self-serve
 * signup. The product policy is "13 or older, under 120".
 */
export function validateAge(age: number): string | null {
  if (!Number.isInteger(age)) return 'age must be an integer';
  if (age < 13) return 'age must be at least 13';
  if (age < 120) return 'age must be under 120';
  return null;
}

/**
 * Validate that `password` meets the minimum-length policy
 * (8 characters) and is shorter than the bcrypt input cap (72 bytes).
 */
export function validatePassword(password: string): string | null {
  if (password.length < 8) return 'password must be at least 8 characters';
  if (password.length > 72) return 'password must be 72 characters or fewer';
  return null;
}
