-- Cadastros-base do Vonixx Performance Center.
-- Execute depois de `supabase/schema.sql`.
-- Contem somente departamentos e indicadores reais do MVP, sem lancamentos de teste.

insert into public.departments (slug, name, color)
values
  ('almoxarifado', 'Almoxarifado U&C', '#1d6b57'),
  ('recebimento', 'Recebimento e Armazenagem', '#2f68a7'),
  ('estoque', 'Estoque e Inventário', '#7352a3'),
  ('secos', 'Operação Secos', '#b87818'),
  ('quimicas', 'Operações Químicas', '#c8452d')
on conflict (slug) do update
set
  name = excluded.name,
  color = excluded.color,
  active = true,
  updated_at = now();

with department_map as (
  select id, slug
  from public.departments
)
insert into public.indicators (
  department_id,
  name,
  unit,
  target,
  goal,
  target_label,
  formula_type,
  position
)
select department_map.id, catalog.name, catalog.unit, catalog.target, catalog.goal, catalog.target_label, catalog.formula_type, catalog.position
from (
  values
    ('almoxarifado', 'Ruptura de Material de Estocáveis (Manutenção)', '%', 5, 'lower', 'Meta', 'ruptura_estocaveis', 1),
    ('almoxarifado', 'Acuracidade de Estoque (Itens)', '%', 95, 'higher', 'Meta', 'acuracidade_uso_consumo', 2),
    ('almoxarifado', 'Aderência ao Estoque Mínimo', '%', 95, 'higher', 'Meta', 'aderencia_estoque_minimo', 3),
    ('almoxarifado', 'Cumprimento do Plano de Inventário', '%', 100, 'higher', 'Meta', 'cumprimento_plano_inventario', 4),
    ('almoxarifado', 'Estoque Slow Mover (Maior que 90 dias)', '%', 10, 'lower', 'Meta', 'slow_mover', 5),
    ('almoxarifado', 'Produtividade Individual (Uso & Consumo)', '%', null, 'tracking', 'Acompanhamento', 'produtividade_individual', 6),

    ('recebimento', 'Tempo de Recebimento', 'min', 60, 'lower', 'Limite', 'tempo_recebimento', 1),
    ('recebimento', 'SLA de Armazenagem', '%', 95, 'higher', 'Meta', 'sla_recebimento', 2),
    ('recebimento', 'Avarias no Recebimento', '%', 0.5, 'lower', 'Limite', 'avarias_recebimento', 3),
    ('recebimento', 'Acurácia de Conferência', '%', 99, 'higher', 'Meta', 'acuracia_recebimento', 4),
    ('recebimento', 'Giro de Docas', '%', 90, 'higher', 'Meta', 'giro_recebimento', 5),

    ('estoque', 'Acuracidade do Estoque', '%', 98, 'higher', 'Meta', 'acuracidade', 1),
    ('estoque', 'Contábil x WMS', '%', 1, 'lower', 'Limite', 'divergencia_wms', 2),
    ('estoque', 'Material Obsoleto', '%', 5, 'lower', 'Limite', 'obsolescencia', 3),
    ('estoque', 'Produtividade de Contagens', 'itens/colab', 40, 'higher', 'Meta', 'produtividade_contagens', 4),
    ('estoque', 'Perdas de Inventário', '%', 1, 'lower', 'Limite', 'perdas_inventario', 5),

    ('secos', 'Movimentação por Colaborador', 'itens/colab', 50, 'higher', 'Meta', 'movimentacao_colaborador', 1),
    ('secos', 'Tempo Médio de Carregamento', 'min', 70, 'lower', 'Limite', 'tempo_carregamento', 2),
    ('secos', 'Taxa de Erros de Movimentação', '%', 1, 'lower', 'Limite', 'erros_movimentacao', 3),
    ('secos', 'Taxa de Avarias de Movimentação', '%', 1, 'lower', 'Limite', 'avarias_movimentacao', 4),
    ('secos', 'Tempo de Espera de Carregamento', 'min', 20, 'lower', 'Limite', 'espera_carregamento', 5),

    ('quimicas', 'Conformidade Química', '%', 99, 'higher', 'Meta', null, 1),
    ('quimicas', 'Perdas Químicas', '%', 0.8, 'lower', 'Limite', null, 2),
    ('quimicas', 'Produtividade Química', 'bat/h', 100, 'higher', 'Meta', null, 3),
    ('quimicas', 'Acuracidade de Lote', '%', 98, 'higher', 'Meta', null, 4),
    ('quimicas', 'Segurança Operacional', 'ocorr', 0, 'lower', 'Limite', null, 5)
) as catalog(slug, name, unit, target, goal, target_label, formula_type, position)
join department_map on department_map.slug = catalog.slug
on conflict (department_id, name) do update
set
  unit = excluded.unit,
  target = excluded.target,
  goal = excluded.goal,
  target_label = excluded.target_label,
  formula_type = excluded.formula_type,
  position = excluded.position,
  active = true,
  updated_at = now();
