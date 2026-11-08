
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const WORKER_SECRET = Deno.env.get("TALID_WORKER_SECRET");

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

Deno.serve(async (req) => {
  if (req.method === "GET") {
    return json({
      service: "TALID Worker",
      status: "available",
      mode: "safe-review",
    });
  }

  if (req.method !== "POST") {
    return json({ error: "POST required" }, 405);
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !WORKER_SECRET) {
    return json({
      error: "Worker environment is not configured",
    }, 503);
  }

  if (req.headers.get("x-talid-worker-secret") !== WORKER_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    const { data: jobs, error } = await db
      .from("talid_jobs")
      .select("id, job_type, status, created_at")
      .in("status", ["pending", "queued"])
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) {
      return json({
        error: "Could not read job queue",
        details: error.message,
      }, 500);
    }

    return json({
      service: "TALID Worker",
      status: "review",
      execution_enabled: false,
      jobs_found: jobs?.length ?? 0,
      jobs: jobs ?? [],
      message:
        "Jobs were inspected only. No synchronization was executed.",
    });
  } catch (error) {
    return json({
      error: "Worker error",
      details: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
