import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hotmart-hottok',
}

Deno.serve(async (req) => {
  // Responde imediatamente a requisições OPTIONS (necessário para webhooks)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. VERIFICAÇÃO DE SEGURANÇA
    const hotmartToken = req.headers.get('x-hotmart-hottok');
    const secretToken = Deno.env.get('HOTMART_SECRET_TOKEN');

    if (!hotmartToken || hotmartToken !== secretToken) {
      return new Response('Acesso não autorizado.', { status: 401 });
    }

    const payload = await req.json();
    const buyerEmail = payload.data?.buyer?.email;
    const buyerName = payload.data?.buyer?.name;

    if (!buyerEmail || !buyerName) {
      return new Response('Dados do comprador em falta no payload.', { status: 400 });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // 2. CONVIDAR O UTILIZADOR E ENVIAR E-MAIL PARA DEFINIR SENHA
    const { data, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      buyerEmail,
      { 
        data: { name: buyerName, full_name: buyerName },
        redirectTo: 'https://applua.fengshuiedecoracao.com.br/set-password' 
      }
    );

    if (inviteError) {
      // Se o erro for "User already registered", não é um problema.
      // Podemos tratar isso como um sucesso, pois o usuário já existe.
      if (inviteError.message.includes('User already registered')) {
        console.log(`Utilizador ${buyerEmail} já existe. O convite não será reenviado.`);
      } else {
        // Para outros erros, lançamos uma exceção.
        throw new Error(`Erro ao convidar utilizador: ${inviteError.message}`);
      }
    } else {
      console.log(`E-mail de convite enviado para ${buyerEmail}.`);
    }

    // 3. DESATIVAR A SEQUÊNCIA DE E-MAILS PARA O LEAD
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('id')
      .eq('email', buyerEmail)
      .single();

    if (lead) {
      // Se encontrámos um lead com este e-mail, atualizamos a sua subscrição
      await supabaseAdmin
        .from('lead_email_subscriptions')
        .update({ status: 'completed' }) // Mudamos o status para 'completed'
        .eq('lead_id', lead.id);
      console.log(`Sequência de e-mails interrompida para o lead ${buyerEmail}.`);
    } else {
      console.log(`Nenhum lead correspondente encontrado para o e-mail ${buyerEmail}.`);
    }

    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});