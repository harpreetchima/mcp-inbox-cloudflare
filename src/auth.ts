import type { Actor } from "./model";

const encoder = new TextEncoder();

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

function unauthorized(): Response {
  return Response.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Bearer realm="agents-mail"'
      }
    }
  );
}

export async function authenticate(
  request: Request,
  env: Pick<Env, "MCP_CODEX_TOKEN" | "MCP_HERMES_TOKEN">
): Promise<Actor | Response> {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("Authorization") ?? "");
  const provided = match?.[1] ?? "";
  const codexToken = env.MCP_CODEX_TOKEN;
  const hermesToken = env.MCP_HERMES_TOKEN;

  if (!codexToken || !hermesToken) {
    console.error(JSON.stringify({ event: "auth_configuration_invalid" }));
    return Response.json(
      { error: "Authentication is not configured" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const [providedHash, codexHash, hermesHash] = await Promise.all([
    digest(provided),
    digest(codexToken),
    digest(hermesToken)
  ]);
  const isCodex = crypto.subtle.timingSafeEqual(providedHash, codexHash);
  const isHermes = crypto.subtle.timingSafeEqual(providedHash, hermesHash);

  if (isCodex && isHermes) {
    console.error(JSON.stringify({ event: "auth_tokens_not_distinct" }));
    return Response.json(
      { error: "Authentication is not configured" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (isCodex) return "codex";
  if (isHermes) return "hermes";
  return unauthorized();
}
