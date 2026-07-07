import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey",
};

/**
 * Get the current date/time string in America/Maceio timezone (UTC-3).
 * Supabase Edge Functions run in UTC, but our data is in BRT.
 */
function getBRTNow(): { date: string; hours: number; minutes: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Maceio",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  const date = `${year}-${month}-${day}`;

  const timeFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Maceio",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const timeParts = timeFormatter.formatToParts(new Date());
  const hours = parseInt(timeParts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minutes = parseInt(timeParts.find((p) => p.type === "minute")?.value ?? "0", 10);

  return { date, hours, minutes };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const log: string[] = [];

  try {
    // ── 1. Get VAPID keys ──────────────────────────────────────────
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");

    if (!vapidPublicKey || !vapidPrivateKey) {
      throw new Error("VAPID keys are not configured.");
    }
    log.push("VAPID keys loaded");

    // Configure web-push with VAPID details
    webpush.setVapidDetails(
      "mailto:admin@applua.fengshuitradicional.world",
      vapidPublicKey,
      vapidPrivateKey,
    );
    log.push("web-push configured with VAPID keys");

    // ── 2. Connect to Supabase ──────────────────────────────────────
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured.");
    }
    log.push(`Connecting to Supabase at: ${supabaseUrl}`);

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
      },
    });
    log.push("Supabase client created with service role key");

    // ── 3. Get today's date and current time in BRT ────────────────
    const brt = getBRTNow();
    const today = brt.date;
    const currentTimeMinutes = brt.hours * 60 + brt.minutes;
    log.push(`Today (BRT): ${today} at ${String(brt.hours).padStart(2, "0")}:${String(brt.minutes).padStart(2, "0")}`);

    // ── 4. Query moon_void_of_course for today ─────────────────────
    const { data: lfcPeriods, error: lfcError } = await supabase
      .from("moon_void_of_course")
      .select("*")
      .lte("start_date", today)
      .gte("end_date", today);

    if (lfcError) throw lfcError;
    log.push(`LFC periods found for today: ${lfcPeriods?.length || 0}`);

    // ── 5. Build notification messages for each LFC period ────────
    const notificationReasons: string[] = [];

    if (lfcPeriods && lfcPeriods.length > 0) {
      for (const period of lfcPeriods) {
        const startParts = (period.start_time as string).split(":").map(Number);
        const endParts = (period.end_time as string).split(":").map(Number);
        const startMinutes = startParts[0] * 60 + startParts[1];
        const endMinutes = endParts[0] * 60 + endParts[1];

        const isCrossMidnight = period.start_date !== period.end_date;
        const todayIsStartDate = period.start_date === today;
        const todayIsEndDate = period.end_date === today;
        const startTimeStr = (period.start_time as string).slice(0, 5);
        const endTimeStr = (period.end_time as string).slice(0, 5);

        if (!isCrossMidnight) {
          // ── SAME DAY period ──
          const isInside = currentTimeMinutes >= startMinutes && currentTimeMinutes <= endMinutes;

          if (isInside) {
            notificationReasons.push(
              `Lua Fora de Curso das ${startTimeStr} às ${endTimeStr}`,
            );
          } else {
            notificationReasons.push(
              `Lua Fora de Curso das ${startTimeStr} às ${endTimeStr}`,
            );
          }
        } else {
          // ── CROSS-MIDNIGHT period ──
          // Period spans two days: [start_date startTime] → [end_date endTime]

          // We're on the start date
          if (todayIsStartDate) {
            notificationReasons.push(
              `Lua Fora de Curso das ${startTimeStr} até amanhã às ${endTimeStr}`,
            );
          } else if (todayIsEndDate) {
            // We're on the end date — it started yesterday
            if (currentTimeMinutes <= endMinutes) {
              // Still going (before end_time today)
              notificationReasons.push(
                `Lua Fora de Curso desde ontem (horário ${startTimeStr}) até hoje às ${endTimeStr}`,
              );
            }
            // After end_time → already finished, don't notify
          } else {
            // Today is between start_date and end_date (multi-day period spanning 3+ days)
            // Still active — notify with full context
            notificationReasons.push(
              `Lua Fora de Curso ativa (iniciada dia ${period.start_date} às ${startTimeStr}, termina dia ${period.end_date} às ${endTimeStr})`,
            );
          }
        }
      }
    }

    // ── 6. Get all push subscriptions ──────────────────────────────
    const { data: subscriptions, error: subError } = await supabase
      .from("push_subscriptions")
      .select("subscription");

    if (subError) throw subError;
    log.push(`Subscriptions found: ${subscriptions?.length || 0}`);

    // ── 7. Prepare notification payload ────────────────────────────
    let title = "";
    let body = "";

    if (notificationReasons.length > 0) {
      title = "🌙 Atenção: Lua Fora de Curso!";
      body = notificationReasons.join(". ");
    } else {
      body = "✨ Dia favorável para decisões, sem lua fora de curso.";
    }

    const notificationPayload = JSON.stringify({
      title,
      body,
      icon: "https://applua.fengshuitradicional.world/favicon.png",
    });
    log.push(`Notification payload: ${notificationPayload}`);

    // ── 8. Send push notifications to all subscribers ──────────────
    log.push(`Sending to ${subscriptions.length} subscribers...`);

    const promises = subscriptions.map(async (s: Record<string, unknown>) => {
      const subscription = s.subscription as {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      };
      const audience = new URL(subscription.endpoint).origin;

      try {
        await webpush.sendNotification(
          subscription as unknown as webpush.PushSubscription,
          notificationPayload,
        );
        log.push(`Sent to ${audience}: OK`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // 410 Gone or 404 Not Found means subscription is invalid
        if (msg.includes("410") || msg.includes("404") || msg.includes("gone") || msg.includes("not found")) {
          await supabase
            .from("push_subscriptions")
            .delete()
            .filter("subscription->>endpoint", "eq", subscription.endpoint);
          log.push(`Removed invalid subscription: ${audience}`);
        } else {
          log.push(`Failed to send to ${audience}: ${msg}`);
        }
      }
    });

    await Promise.all(promises);
    log.push("Finished sending all notifications");

    return new Response(
      JSON.stringify({
        message: `Sent ${notificationReasons.length} notification(s) to ${subscriptions.length} subscriber(s)`,
        log,
      }),
      { headers: { "Content-Type": "application/json" }, status: 200 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ error: msg, log }),
      { headers: { "Content-Type": "application/json" }, status: 500 },
    );
  }
});