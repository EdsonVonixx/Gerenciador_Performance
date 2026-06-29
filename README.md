# Vonixx Performance Center

MVP frontend do Vonixx Performance Center (VPC) para acompanhamento de indicadores operacionais da Logistica.

## Estado atual

- Aplicacao frontend estatica.
- Login por perfil operacional simulado no navegador.
- Indicadores por departamento.
- Lancamentos manuais com calculos automaticos.
- Evidencias, justificativas e planos de acao.
- Modulo TV para visualizacao consolidada.
- Checklist 5S operacional para Operacoes Quimicas.
- Persistencia temporaria em `localStorage`.
- Estrutura inicial de Supabase em `supabase/schema.sql`.

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

## Observacoes importantes

Este MVP ainda nao possui backend real nem autenticacao segura. Os acessos atuais sao apenas uma simulacao de frontend para homologacao visual e operacional.

Antes de compartilhar como sistema corporativo definitivo, a proxima fase deve conectar:

- Supabase PostgreSQL
- Supabase Auth ou outro provedor de autenticacao
- Regras de permissao por departamento
- Persistencia real dos lancamentos
- Auditoria de edicoes e exclusoes

Consulte tambem:

- `docs/cloud-readiness.md`
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
