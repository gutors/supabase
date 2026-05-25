import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { encrypt, importKey } from "https://deno.land/x/vapid@v0.2.2/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey",
};

// Helper para converter a chave VAPID de base64url para um formato que a API de criptografia entende
function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");

    if (!vapidPublicKey || !vapidPrivateKey) {
      throw new Error("VAPID keys are not configured.");
    }

    const privateKey = await importKey(vapidPrivateKey);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl!, serviceRoleKey!);

    const { data: subscriptions, error } = await supabase
      .from("push_subscriptions")
      .select("subscription");

    if (error) throw error;

    console.log(`Found ${subscriptions.length} subscriptions.`);

    const response = await fetch(
      "https://applua.fengshuiedecoracao.com.br/dados_diarios_completos.json",
    );
    const astrologicalData = await response.json();
    const today = new Date().toISOString().slice(0, 10);
    const todayData = astrologicalData[today];

    if (todayData && todayData.lfc && todayData.lfc.length > 0) {
      const notificationPayload = JSON.stringify({
        title: "Lua Fora de Curso!",
        body: `Hoje a lua está fora de curso nos seguintes horários: ${
          todayData.lfc.map((p) => `${p.inicio} às ${p.fim}`).join(", ")
        }`,
        icon: "https://applua.fengshuiedecoracao.com.br/favicon.png",
      });

      console.log("Sending notifications...");

      const promises = subscriptions.map(async (s) => {
        const subscription = s.subscription as PushSubscription;
        const audience = new URL(subscription.endpoint).origin;

        // 1. Criar o VAPID JWT
        const jwt = await create(
          { alg: "ES256", typ: "JWT" },
          {
            aud: audience,
            exp: getNumericDate(12 * 60 * 60), // 12 hours from now
            sub: "mailto:admin@applua.fengshuiedecoracao.com.br",
          },
          privateKey,
        );

        // 2. Criptografar o payload
        const encrypted = await encrypt(
          subscription,
          notificationPayload,
          vapidPublicKey,
        );

        // 3. Enviar a requisição HTTP POST
        return fetch(subscription.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Encoding": encrypted.contentEncoding,
            "Content-Length": encrypted.body.byteLength.toString(),
            "Authorization": `vapid t=${jwt}, k=${vapidPublicKey}`,
          },
          body: encrypted.body,
        }).catch(err => console.error(`Failed to send to ${audience}:`, err.message));
      });

      await Promise.all(promises);
    }

    console.log("Finished sending notifications.");

    return new Response(
      JSON.stringify({ message: `Notification process finished.` }),
      { headers: { "Content-Type": "application/json" }, status: 200 },
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    });
  }
});
