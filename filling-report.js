import ExcelJS from "exceljs";

export function createFillingWorkbook(analysis, departments) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Vonixx Performance";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Pendências", { views: [{ state: "frozen", ySplit: 1 }] });
  const rows = departments.flatMap((department) => department.missing.map((item) => [
    department.department, item.indicator, item.date,
    item.frequency === "Semanal" ? item.periodKey : "", item.shift, item.frequency,
  ]));
  const columns = ["Departamento", "Indicador", "Data no período", "Início da semana", "Turno", "Frequência"];
  sheet.addTable({
    name: "PendenciasPreenchimento", ref: "A1", headerRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: columns.map((name) => ({ name, filterButton: true })), rows,
  });
  [38, 64, 20, 20, 18, 18].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.eachRow((row, index) => {
    row.alignment = { vertical: "middle", wrapText: true };
    row.height = index === 1 ? 30 : 34;
  });
  return workbook;
}
