interface ProfileResult {
  user: { name: string } | null;
}

declare function fetchProfile(): Promise<ProfileResult>;

export async function handleProfile(): Promise<string> {
  const result = await fetchProfile();
  // PLANT_ANCHOR: missing-null-check
  return name;
}
