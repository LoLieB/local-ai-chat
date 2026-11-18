export function resolveServerToken(env: NodeJS.ProcessEnv = process.env) {
  return (env.SERVER_TOKEN || "").trim();
}

export function isValidServerToken(expectedToken: string, providedToken: string | null | undefined) {
  if (!expectedToken) {
    return true;
  }

  return (providedToken || "").trim() === expectedToken;
}
