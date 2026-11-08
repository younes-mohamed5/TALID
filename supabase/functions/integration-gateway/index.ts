// TALID Secure Integration Gateway
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: cors }
    );
  }

  const auth = req.headers.get("Authorization");

  if (!auth) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: cors }
    );
  }

  let payload: { provider?: string; action?: string };

  try {
    payload = await req.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON" },
      { status: 400, headers: cors }
    );
  }

  const allowedProviders = [
    "easyorders",
    "taager",
    "shipping",
    "meta"
  ];

  if (!payload.provider || !allowedProviders.includes(payload.provider)) {
    return Response.json(
      { error: "Unsupported provider" },
      { status: 400, headers: cors }
    );
  }

  return Response.json(
    {
      status: "not_implemented",
      provider: payload.provider,
      action: payload.action ?? null,
      message: "Integration is not activated yet."
    },
    { status: 501, headers: cors }
  );
});
