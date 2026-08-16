const redirectBase = process.env.E2E_TOKEN_REDIRECT_BASE;

if (!redirectBase) {
  throw new Error(
    "E2E_TOKEN_REDIRECT_BASE is required by the E2E fetch redirector.",
  );
}

const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = (input, init) => {
  const requestedUrl =
    typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const url = new URL(requestedUrl);

  if (
    url.origin === "https://mcp.neo4j.io" &&
    url.pathname === "/oauth/token"
  ) {
    return nativeFetch(new URL("/oauth/token", redirectBase), init);
  }

  return nativeFetch(input, init);
};
