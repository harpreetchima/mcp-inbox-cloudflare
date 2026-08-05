import { createMcpHandler } from "agents/mcp/server";
import { authenticate } from "./auth";
import { handleIncomingEmail, handleQueue } from "./ingest";
import { createMailboxServer } from "./mcp";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json(
        { ok: true, service: "agents-mail" },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    if (url.pathname !== "/mcp") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const actor = await authenticate(request, env);
    if (actor instanceof Response) return actor;

    const handler = createMcpHandler(() => createMailboxServer(env, actor), {
      route: "/mcp",
      corsOptions: false,
      onerror(error) {
        console.error(JSON.stringify({ event: "mcp_error", error: error.message }));
      }
    });
    return handler(request, env, ctx);
  },

  async email(message, env): Promise<void> {
    try {
      await handleIncomingEmail(message, env);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "email_ingress_failed",
          error: error instanceof Error ? error.message : String(error)
        })
      );
      throw error;
    }
  },

  async queue(batch, env): Promise<void> {
    await handleQueue(batch, env);
  }
} satisfies ExportedHandler<Env>;
