# Proxima etapa cloud

Este documento separa o que ja esta pronto para publicacao do frontend e o que ainda precisa ser feito para o uso real com varios departamentos.

## Situacao atual

- O MVP roda como frontend estatico.
- A navegacao, filtros, lancamentos, evidencias, tratativas, modulo TV e 5S estao no navegador.
- A persistencia atual usa `localStorage`, portanto os dados ficam somente na maquina/navegador de quem esta usando.
- O login atual e uma simulacao por senha no frontend. Ele nao deve ser usado como seguranca real em producao.

## Pronto para Vercel

O projeto ja tem a base necessaria para hospedar o frontend:

- `package.json`
- `vercel.json`
- `.env.example`
- `README.md`

Configuracao esperada na Vercel:

- Framework: `Vite`
- Build command: `npm run build`
- Output directory: `dist`
- Node: 20 ou superior

## Pendente para Supabase

Para operar com varios usuarios e departamentos, ainda falta implementar:

- Criar projeto no Supabase.
- Executar `supabase/schema.sql`.
- Executar `supabase/catalog.sql` para carregar departamentos e indicadores reais.
- Criar usuarios reais no Supabase Auth.
- Cadastrar perfis vinculados aos departamentos.
- Substituir `localStorage` por CRUD no Supabase.
- Garantir regras RLS por departamento e acesso global para Gestao.
- Validar edicao, exclusao, filtros e modulo TV lendo do banco.

## Fluxo de permissao recomendado

- Perfil operacional: visualiza e altera somente o proprio departamento.
- Perfil Gestao: visualiza todos os departamentos, modulo TV e consolidado de tratativas.
- Cadastros-base: indicadores, departamentos e checklist 5S devem ser alterados somente por Gestao ou administrador tecnico.

## Ordem recomendada

1. Publicar o frontend no GitHub.
2. Importar o repositorio na Vercel.
3. Criar projeto Supabase.
4. Executar o schema inicial.
5. Executar o catalogo base.
6. Criar usuarios e perfis.
7. Conectar o frontend ao Supabase.
8. Fazer homologacao por departamento.
9. Ativar regras finais de seguranca e auditoria.

## Observacao

Os arquivos `supabase/schema.sql` e `supabase/catalog.sql` nao incluem lancamentos de teste. Eles criam a estrutura e os cadastros-base reais para que o projeto avance limpo para a fase de banco.
