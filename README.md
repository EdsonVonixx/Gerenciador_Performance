# Vonixx Performance Center

MVP frontend do Vonixx Performance Center (VPC) para acompanhamento de indicadores operacionais da Logistica.

## Estado atual

- Aplicacao frontend estatica.
- Login por perfil operacional simulado no navegador.
- Indicadores por departamento.
- Lancamentos manuais com calculos automaticos.
- Evidencias, justificativas e planos de acao.
- Modulo TV para visualizacao consolidada.
- Checklist 5S operacional preparado para evolucao.
- Persistencia local em `localStorage` quando `VITE_VPC_DATA_MODE=local`.
- Persistencia SQL no Supabase quando `VITE_VPC_DATA_MODE=supabase`.
- Estrutura Supabase isolada em tabelas `vpc_` para evitar conflito com outros projetos.

## Tecnologias

- HTML
- CSS
- JavaScript
- Vite

## Como rodar localmente

```bash
npm install
npm run dev
```

Depois acesse:

```text
http://127.0.0.1:4173/
```

## Build de producao

```bash
npm run build
npm run preview
```

O build final sera gerado em `dist/`.

## Deploy na Vercel

Configuracao recomendada:

- Framework Preset: `Vite`
- Build Command: `npm run build`
- Output Directory: `dist`
- Install Command: `npm install`

O arquivo `vercel.json` ja deixa esses parametros definidos para o projeto.

## Supabase

Para conectar a uma base Supabase existente, execute:

```text
supabase/schema.sql
supabase/catalog.sql
```

Depois configure na Vercel:

```text
VITE_VPC_DATA_MODE=supabase
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_VPC_AUTH_EMAIL_SUFFIX=vpc.vonixx.local
```

O VPC usa tabelas prefixadas com `vpc_` e nao grava registros excluidos como soft delete. Ao excluir lancamentos ou tratativas em producao, a aplicacao executa `DELETE` real na base SQL.

## Observacoes importantes

No modo local, os acessos continuam simulados no navegador para homologacao visual. No modo Supabase, a autenticacao deve ser feita com usuarios do Supabase Auth e as permissoes por departamento sao aplicadas por RLS.

Consulte tambem:

- `docs/cloud-readiness.md`
- `docs/supabase-integration.md`
- `supabase/schema.sql`
- `supabase/catalog.sql`

## Estrutura principal

```text
.
+-- index.html
+-- app.js
+-- styles.css
+-- vonixx-logo.png
+-- package.json
+-- vercel.json
+-- .env.example
+-- README.md
+-- docs/
+-- supabase/
```
