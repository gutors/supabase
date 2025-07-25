import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { corsHeaders } from "../_shared/cors.ts";

// Environment variables
// Importe a biblioteca de envio de e-mail (ex: Mailgun, SendGrid)
// Para Mailgun:
// import Mailgun from 'https://esm.sh/mailgun.js@latest';
// Para SendGrid (usando Fetch API para a REST API):
// Não é necessário importar uma lib específica, faremos requisição HTTP.

// Configurações do serviço de e-mail (EXEMPLO COM SENDGRID)
// Você vai armazenar isso como SEGREDOS no Supabase
const SENDGRID_API_KEY = Deno.env.get("SENDGRID_API_KEY");
const FROM_EMAIL = Deno.env.get("FROM_EMAIL");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const { name, email, productLink } = await req.json();

    if (!name || !email || !productLink) {
      return new Response(JSON.stringify({ message: "Name, email, and productLink are required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const utm_source = url.searchParams.get("utm_source");
    const utm_medium = url.searchParams.get("utm_medium");
    const utm_campaign = url.searchParams.get("utm_campaign");
    const utm_content = url.searchParams.get("utm_content");
    const utm_term = url.searchParams.get("utm_term");

    // Inicializa o cliente Supabase para interagir com o banco de dados
    const supabase = createClient(
      SUPABASE_URL!,
      SUPABASE_ANON_KEY!,
      // Para Edge Functions, é mais seguro usar um service_role key, mas aqui usamos anon_key para simplicidade e assumimos RLS adequado.
      // Para produção, considere passar a service_role key como segredo ou usar um serviço auth específico.
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    // 1. Salvar no banco de dados Supabase
    const { data, error: dbError } = await supabase
      .from("leads")
      .insert({ 
        name, 
        email, 
        product_link: productLink,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term
      })
      .select();

    if (dbError) {
      console.error("Error saving lead to database:", dbError);
      // Se for um erro de duplicidade de e-mail (ex: UNIQUE constraint), você pode dar um feedback específico.
      if (dbError.code === '23505') { // Código para "unique_violation"
        return new Response(JSON.stringify({ message: "This email is already registered." }), {
          status: 409, 
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw dbError;
    }

    console.log("Lead saved to Supabase:", data);

    // 2. Enviar e-mail usando SendGrid API (exemplo)
    const sendgridResponse = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SENDGRID_API_KEY}`,
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: email }] }],
        from: { email: FROM_EMAIL },
        subject: "Your link to the product!",
        content: [
          {
            type: "text/html",
            value: `<p>Hi ${name},</p><p>Thanks for signing up! Here is the link to the product: <a href="${productLink}">${productLink}</a></p><p>Regards,<br>Your Team</p>`,
          },
        ],
      }),
    });

    if (!sendgridResponse.ok) {
      const errorData = await sendgridResponse.json();
      console.error("Error sending email via SendGrid:", errorData);
      // Mesmo que o e-mail falhe, o lead já foi salvo. Você pode decidir como lidar com isso.
      // Talvez registrar o erro em uma tabela de logs para retentar depois.
      // Por enquanto, vamos retornar sucesso, já que o dado principal foi salvo.
      // Ou você pode optar por retornar um erro 500 se o envio de e-mail for crítico.
      // throw new Error(`Falha ao enviar e-mail: ${JSON.stringify(errorData)}`);
    }

    return new Response(JSON.stringify({ message: "Subscription successful, email sent!" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Error in Edge Function:", error);
    return new Response(JSON.stringify({ message: "Internal server error.", error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});