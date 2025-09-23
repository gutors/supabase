import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { buildPushHTTPRequest } from "https://cdn.jsdelivr.net/npm/@pushforge/builder/dist/lib/main.js";

// Headers para permitir a chamada da função (CORS)
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey",
};

Deno.serve(async (req) => {
  // Trata a chamada OPTIONS do navegador (necessário para CORS)
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");

    if (!vapidPublicKey || !vapidPrivateKey) {
      throw new Error(
        "As chaves VAPID não foram configuradas nos segredos do projeto.",
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl!, serviceRoleKey!);

    const { data: subscriptions, error } = await supabase
      .from("push_subscriptions")
      .select("subscription");

    if (error) {
      throw new Response(JSON.stringify({ error: error.message }), {
        headers: { "Content-Type": "application/json" },
        status: 500,
      });
    }

    console.log("Fetching dados_diarios_completos for LFC");

    const response = await fetch(
      "https://applua.fengshuiedecoracao.com.br/dados_diarios_completos.json",
    );
    const astrologicalData = await response.json();
    const today = new Date().toISOString().slice(0, 10);
    const todayData = astrologicalData[today];

    if (todayData && todayData.lfc && todayData.lfc.length > 0) {
      const notificationPayload = {
        payload: {
          title: "Lua Fora de Curso!",
          body: `Hoje a lua está fora de curso nos seguintes horários: ${
            todayData.lfc.map((p) => `${p.inicio} às ${p.fim}`).join(", ")
          }`,
          icon: "https://applua.fengshuiedecoracao.com.br/favicon.png",
        },
        options: {
          //Default value is 24 * 60 * 60 (24 hours).
          //The VAPID JWT expiration claim (`exp`) must not exceed 24 hours from the time of the request.
          ttl: 3600, // Time-to-live in seconds
          urgency: "normal", // Options: "very-low", "low", "normal", "high"
          topic: "updates", // Optional topic for replacing notifications
        },
        adminContact: "mailto:contato@fengshuiedecoracao.com.br",
      };

      console.log(`Sending notifications for ${subscriptions.length} subscribers ...`);
      
      const promises = subscriptions.map(async (s) => {
        try {
          const request = await buildPushHTTPRequest({
            vapidPrivateKey,
            notificationPayload,
            s
          });

          await fetch(request.endpoint, {
            method: "POST",
            headers: request.headers,
            body: request.body,
          });
        } catch (err) {
          // Se uma inscrição for inválida, o `buildPushHTTPRequest` pode falhar.
          // Logamos o erro e continuamos com os outros.
          console.error("Failed to send notification to a subscription:", err.message);
        }
      });

      await Promise.all(promises);
    }

    console.log("Finished sending daily notifications");

    return new Response(
      JSON.stringify({
        message: `Processo de notificação finalizado para ${subscriptions.length} inscritos.`,
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    });
  }
});
