import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";

// EdgeFunction to send the emails every lead or user needs to receive

// Interface para o formato da sequencia de emails e dos leads
interface Subscription {
  id: number;
  current_day: number;
  leads: {
    email: string;
    first_name: string;
  };
  email_sequences: {
    id: number;
    total_days: number;
  };
}

const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
const MAILGUN_DOMAIN = "mail.fengshuiedecoracao.com.br";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(async (req) => {
  try {
    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      throw new Error('Mailgun API Key or Domain not set in secrets');
    }

    const supabaseAdmin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    const today = new Date().toISOString().slice(0, 10);

    // 1. Encontra todas as inscrições ativas agendadas para hoje
    const { data: subscriptions, error: subsError } = await supabaseAdmin
      .from('lead_email_subscriptions')
      .select(`
        id,
        current_day,
        leads ( email, first_name ),
        email_sequences ( id, total_days )
      `)
      .eq('status', 'active')
      .eq('next_send_date', today)
      .limit(20);

    if (subsError) throw subsError;
    if (!subscriptions || subscriptions.length === 0) {
      return new Response('Nenhuma subscrição para processar hoje.', { status: 200 });
    }

    // 2. Busca todos os templates de e-mail necessários de uma só vez
    const sequenceIds = [...new Set((subscriptions as Subscription[]).map(sub => sub.email_sequences.id))];
    
    const { data: templates, error: templatesError } = await supabaseAdmin
      .from('email_templates')
      .select('sequence_id, day_number, subject, html_content, text_content')
      .in('sequence_id', sequenceIds);

    if (templatesError) throw templatesError;
    if (!templates) {
      return new Response('Nenhum template de email encontrado para as sequências.', { status: 404 });
    }

    // 3. Processa cada subscrição, agora com os templates em memória
    for (const sub of subscriptions as Subscription[]) {
      const nextDay = sub.current_day + 1;
      const sequenceId = sub.email_sequences.id;

      // Encontra o template de e-mail localmente
      const template = templates.find(t => t.sequence_id === sequenceId && t.day_number === nextDay);

      if (!template) {
        console.error(`Template para dia ${nextDay} da sequência ${sequenceId} não encontrado.`);
        continue;
      }

      // Personaliza o conteúdo
      const leadName = sub.leads.first_name || '';
      const personalizedSubject = template.subject.replace('{{nome}}', leadName);
      const personalizedHtml = template.html_content.replace('{{nome}}', leadName);
      const personalizedText = (template.text_content || '').replace('{{nome}}', leadName);

      // 4. Envia o e-mail usando a API do Mailgun
      const formData = new URLSearchParams();
      formData.append('from', `Ajuda do Céu <contato@fengshuiedecoracao.com.br>`);
      formData.append('to', sub.leads.email);
      formData.append('subject', personalizedSubject);
      formData.append('text', personalizedText);
      formData.append('html', personalizedHtml);

      const response = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${btoa(`api:${MAILGUN_API_KEY}`)}`,
        },
        body: formData,
      });

      if (!response.ok) {
        console.error(`Erro ao enviar e-mail para ${sub.leads.email}:`, await response.text());
        continue; // Pula para o próximo
      }

      // 5. Atualiza o estado da subscrição
      const isSequenceComplete = nextDay >= sub.email_sequences.total_days;
      const nextStatus = isSequenceComplete ? 'completed' : 'active';

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const nextSendDate = isSequenceComplete ? null : tomorrow.toISOString().slice(0, 10);

      await supabaseAdmin
        .from('lead_email_subscriptions')
        .update({
          current_day: nextDay,
          status: nextStatus,
          next_send_date: nextSendDate,
        })
        .eq('id', sub.id);

      console.log(`E-mail dia ${nextDay} enviado para ${sub.leads.email}. Status: ${nextStatus}`);
    }

    return new Response(JSON.stringify({ message: `Processadas ${subscriptions.length} subscrições.` }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});