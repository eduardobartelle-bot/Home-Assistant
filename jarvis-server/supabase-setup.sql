-- Tabela de memória de conversa do Nero.
-- Rode isto no Supabase: seu projeto > SQL Editor > New query > Run.

create table if not exists conversas (
  user_id       text primary key,
  mensagens     jsonb       not null default '[]'::jsonb,
  atualizado_em timestamptz not null default now()
);

-- (Opcional) Limpa conversas paradas há mais de 30 dias.
-- Rode manualmente quando quiser, ou agende com pg_cron.
-- delete from conversas where atualizado_em < now() - interval '30 days';
