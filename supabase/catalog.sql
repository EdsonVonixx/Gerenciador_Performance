-- Cadastros-base do Vonixx Performance Center.
-- Execute depois de `supabase/schema.sql`.
-- Contem somente departamentos e indicadores reais do MVP, sem lancamentos de teste.

insert into public.departments (slug, name, color)
values
  ('almoxarifado', 'Almoxarifado U&C', '#1d6b57'),
  ('recebimento', 'Recebimento e Armazenagem', '#2f68a7'),
  ('estoque', 'Estoque e Inventário', '#7352a3'),
  ('secos', 'Operação Secos e Expedição', '#b87818'),
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

    ('recebimento', 'Capacidade de Recebimento Diário', '%', 85, 'higher', 'Meta', 'recebimento_capacidade_diaria', 1),
    ('recebimento', 'OTIF de Recebimento de Fornecedores x Follow Up', '%', 95, 'higher', 'Meta', 'recebimento_otif_fornecedores', 2),
    ('recebimento', 'Eficiência de Recebimento', '%', 95, 'higher', 'Meta', 'recebimento_eficiencia', 3),
    ('recebimento', 'Tempo Médio de Liberação do Material', 'h', 8, 'lower', 'Até', 'recebimento_tempo_liberacao', 4),
    ('recebimento', 'Erros de Armazenagem e Movimentação', '%', 3, 'lower', 'Meta', 'recebimento_erros_armazenagem', 5),
    ('recebimento', 'Produtividade Individual', '%', null, 'tracking', 'Acompanhamento', 'recebimento_produtividade_individual', 6),

    ('estoque', 'Acuracidade de Estoque (SKU)', '%', 95, 'higher', 'Meta', 'estoque_acuracidade_sku', 1),
    ('estoque', 'Divergência Contábil x WMS (SKU)', '%', 8, 'lower', 'Meta', 'estoque_divergencia_wms_sku', 2),
    ('estoque', 'Cumprimento do Plano de Inventário', '%', 100, 'higher', 'Meta', 'estoque_cumprimento_plano_inventario', 3),
    ('estoque', 'Índice de Divergências Tratadas', '%', 98, 'higher', 'Meta', 'estoque_divergencias_tratadas', 4),
    ('estoque', 'Estoque Slow Mover (Maior que 90 dias)', '%', 10, 'lower', 'Meta', 'estoque_slow_mover', 5),
    ('estoque', 'Produtividade de Contagens', 'SKU/dia', 20, 'higher', 'Meta', 'estoque_produtividade_individual_contagens', 6),

    ('secos', 'Índice de Perdas por Ajuste no Picks Secos', '%', 0.05, 'lower', 'Meta', 'secos_perdas_picks', 1),
    ('secos', 'Índice de Ruptura de Embalagens na Produção', 'OPs', 0, 'lower', 'Meta', 'secos_ruptura_embalagens', 2),
    ('secos', 'Índice de OPs Atendidas Erradas', '%', 0.3, 'lower', 'Meta', 'secos_ops_atendidas_erradas', 3),
    ('secos', 'Índice de Erros de Movimentação', '%', 0.5, 'lower', 'Meta', 'secos_erros_movimentacao', 4),
    ('secos', 'Erros Expedição Fábrica (Produto Acabado)', 'R$', 0, 'lower', 'Meta', 'secos_erros_expedicao_fabrica', 5),
    ('secos', 'Tempo Médio Carregamento Carretas', 'min', 60, 'lower', 'Meta', 'secos_tempo_carregamento_carretas', 6),
    ('secos', 'Produtividade Individual', 'atividades/colab', null, 'tracking', 'Acompanhamento', 'secos_produtividade_individual', 7),

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
