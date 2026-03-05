type Provider = { domain: string; applicationID: string };

function readOptionalEnv(name: string): string | undefined {
  const value = (process.env as Record<string, string | undefined>)[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "disabled") return undefined;
  return trimmed;
}

const providers: Provider[] = [];

const convexDomain = readOptionalEnv("CONVEX_SITE_URL");
if (convexDomain) {
  providers.push({
    domain: convexDomain,
    applicationID: "convex",
  });
}

const clerkDomain = readOptionalEnv("CLERK_JWT_ISSUER_DOMAIN");
if (clerkDomain) {
  providers.push({
    domain: clerkDomain,
    applicationID: "convex",
  });
}

export default { providers };
