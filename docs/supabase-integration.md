# Integração Supabase do VPC

Este projeto pode usar o mesmo Supabase já existente para a base "Indicadores Operacionais", desde que as tabelas do VPC fiquem isoladas pelo prefixo `vpc_`.

## Estrutura

Execute no SQL Editor do Supabase:

1. `supabase/schema.sql`
2. `supabase/catalog.sql`

As principais tabelas criadas são:

- `vpc_departments`
- `vpc_profiles`
- `vpc_indicators`
- `vpc_launches`
- `vpc_action_records`
- `vpc_five_s_audits`

Nenhuma tabela de lançamento ou tratativa usa `deleted_at`. Quando o usuário exclui um lançamento ou registro no sistema, o front-end executa `DELETE` real no Supabase.

## Usuários

Crie usuários no Supabase Auth para cada perfil operacional. O front-end monta o e-mail com o padrão:

```text
<perfil>@<VITE_VPC_AUTH_EMAIL_SUFFIX>
```

Com o sufixo padrão, os usuários são:

```text
almoxarifado@vpc.vonixx.local
recebimento@vpc.vonixx.local
estoque@vpc.vonixx.local
secos@vpc.vonixx.local
quimicas@vpc.vonixx.local
gestao@vpc.vonixx.local
```

Depois de criar os usuários, cadastre cada um em `vpc_profiles`, relacionando ao departamento correto. Gestão usa `role = 'gestao'` e pode ficar sem departamento.

## Variáveis da Vercel

Configure no projeto Vercel:

```text
VITE_VPC_DATA_MODE=supabase
VITE_SUPABASE_URL=<url do projeto Supabase>
VITE_SUPABASE_ANON_KEY=<anon/publishable key>
VITE_VPC_AUTH_EMAIL_SUFFIX=vpc.vonixx.local
```

Nunca coloque `service_role` ou secret key no front-end.

## Segurança

As tabelas têm Row Level Security habilitado.

- Operacional acessa apenas o próprio departamento.
- Gestão acessa todos os departamentos.
- `anon` não recebe permissão de leitura ou escrita nas tabelas do VPC.
- Exclusões são físicas para evitar acúmulo de registros removidos.
