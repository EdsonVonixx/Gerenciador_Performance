-- Atualiza somente o cadastro dos indicadores de Almoxarifado.
-- Os lancamentos historicos permanecem intactos e sao reconhecidos por alias no aplicativo.
begin;

alter table public.vpc_indicators
  add column if not exists frequency text not null default 'Diário';

update public.vpc_departments
set name = 'Almoxarifado (Uso e Consumo)', updated_at = now()
where slug = 'almoxarifado';

update public.vpc_indicators
set name = case formula_type
      when 'ruptura_estocaveis' then 'Ruptura de Materiais Estocáveis'
      when 'slow_mover' then 'Estoque Slow Mover (> 90 dias)'
      else name
    end,
    target = case formula_type
      when 'acuracidade_uso_consumo' then 97
      else target
    end,
    frequency = case formula_type
      when 'slow_mover' then 'Semanal'
      when 'cumprimento_plano_inventario' then 'Mensal'
      else 'Diário'
    end,
    updated_at = now()
where department_slug = 'almoxarifado'
  and formula_type in (
    'ruptura_estocaveis',
    'acuracidade_uso_consumo',
    'aderencia_estoque_minimo',
    'cumprimento_plano_inventario',
    'slow_mover'
  );

update public.vpc_indicators
set active = false, updated_at = now()
where id = 'almoxarifado:produtividade_individual';

commit;
