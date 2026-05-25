export function loadGithubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  return token ?? '';
}
