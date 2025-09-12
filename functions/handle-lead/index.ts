import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { corsHeaders } from "../_shared/cors.ts";

// EdgeFunction to save a lead to the DB and send an email with the bait link

// Mailgun email service and Supabase database access settings
// This data is stored as SECRETS in Supabase EdgeFunctions
const CLIENT_KEY = Deno.env.get("CLIENT_KEY");

const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
const MAILGUN_DOMAIN = "mail.fengshuiedecoracao.com.br";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const receivedClientKey = req.headers.get("X-Internal-Api-Key");
  if (receivedClientKey !== CLIENT_KEY) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const { name, email, phone, productLink, utm_source, utm_medium, utm_campaign, utm_content, utm_term, email_html } = await req.json();

    if (!name || !email || !productLink) {
      return new Response(
        JSON.stringify({
          message: "Name, email, productLink and email_html are required.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // const url = new URL(req.url);
    // const utm_source = url.searchParams.get("utm_source");
    // const utm_medium = url.searchParams.get("utm_medium");
    // const utm_campaign = url.searchParams.get("utm_campaign");
    // const utm_content = url.searchParams.get("utm_content");
    // const utm_term = url.searchParams.get("utm_term");

    // Initialize Supabase client to interact with the database
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    // 1. Save to Supabase database
    const { data, error: dbError } = await supabase
      .from("leads")
      .insert({
        first_name: name,
        email,
        phone,
        product_link: productLink,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
      })
      .select();

    if (dbError) {
      console.error("Error saving lead to database:", dbError);
      if (dbError.code === "23505") {
        // Code for "unique_violation"
        return new Response(
          JSON.stringify({ message: "This email is already registered." }),
          {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
      throw dbError;
    }

    console.log("Lead saved to Supabase:", data);

    // 2. Send email using Mailgun API with fetch
    const body = new FormData();
    // const body = new URLSearchParams();
    body.append("from", `Ajuda do Céu <contato@fengshuiedecoracao.com.br>`);
    body.append("to", `${name} <${email}>`);
    body.append("subject", `${name}, seu link de acesso ao app Ajuda do Céu chegou!`);
    body.append("html", email_html)
    // body.append(
    //   "html",
    //   `<p>Olá ${name},</p><p>Muito obrigado por se registrar! Aqui está o link de acesso do seu app: <a href="${productLink}">${productLink}</a></p>
    //   <p>Um abraço,<br>Equipe Ajuda do Céu</p>
    //   <p>Enviado para: ${email}`
    // );

    try {
      const response = await fetch(
        `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: "Basic " + btoa("api:" + MAILGUN_API_KEY),
          },
          body,
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        console.error("Error sending email via Mailgun:", errorData);
      } else {
        console.log("Email sent via Mailgun to:", email);
      }
    } catch (emailError) {
      console.error("Error sending email via Mailgun:", emailError);
    }

    return new Response(
      JSON.stringify({ message: "Subscription successful, email sent!" }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error in Edge Function:", error);
    return new Response(
      JSON.stringify({ message: "Internal server error.", error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
