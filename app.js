import { createClient } from "@supabase/supabase-js";

const operationalDepartmentKeys = ["almoxarifado", "recebimento", "estoque", "secos", "quimicas"];

function readViteEnv(name) {
  return String(import.meta.env?.[name] || "").trim();
}

const vpcSupabaseConfig = {
  url: readViteEnv("VITE_SUPABASE_URL").replace(/\/+$/, ""),
  anonKey: readViteEnv("VITE_SUPABASE_ANON_KEY"),
  dataMode: readViteEnv("VITE_VPC_DATA_MODE").toLowerCase(),
  authEmailSuffix: readViteEnv("VITE_VPC_AUTH_EMAIL_SUFFIX") || "vpc.vonixx.local",
};

let vpcSupabaseSession = null;
const useSupabasePersistence =
  vpcSupabaseConfig.dataMode === "supabase" && Boolean(vpcSupabaseConfig.url && vpcSupabaseConfig.anonKey);
const vpcSupabaseClient = useSupabasePersistence
  ? createClient(vpcSupabaseConfig.url, vpcSupabaseConfig.anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
    })
  : null;
const supabaseRealtimeTables = ["vpc_launches", "vpc_action_records", "vpc_five_s_audits"];
const supabaseRealtimeRefreshDelayMs = 800;
const supabasePollingFallbackMs = 60000;
const supabaseFullRefreshIntervalMs = 30 * 60 * 1000;
const supabaseIncrementalLookbackMs = 2 * 60 * 1000;
const supabaseRequestTimeoutMs = 15000;
const supabaseRequestMaxAttempts = 3;
let vpcSupabaseRealtimeChannel = null;
let vpcSupabaseRefreshTimer = null;
let vpcSupabasePollingTimer = null;
let vpcSupabaseSessionRefreshTimer = null;
let vpcSupabaseRenderTimer = null;
let supabaseStateReloadInFlight = false;
let supabaseStateReloadQueued = false;
let supabaseLastFullRefreshAt = 0;
let supabaseLastIncrementalSyncAt = null;
const pendingLocalRealtimeMutations = new Map();
const localRealtimeMutationTtlMs = 15000;
const confirmedLaunchesAwaitingReconciliation = new Map();
const confirmedLaunchReconciliationTtlMs = 5 * 60 * 1000;

const actionExtraIndicatorName = "5S Operacional";
const actionExtraIndicatorDepartments = new Set(["almoxarifado", "estoque"]);
const commercialOnlyDepartmentKeys = new Set(["almoxarifado", "recebimento", "estoque"]);
const fullShiftOptions = ["Comercial", "Turno A", "Turno B", "Turno C", "Turno D"];

const accessProfiles = [
  {
    key: "almoxarifado",
    label: "Almoxarifado (Uso e Consumo)",
    password: "UC1",
    role: "Acesso operacional",
    departmentKey: "almoxarifado",
  },
  {
    key: "recebimento",
    label: "Recebimento e Armazenagem",
    password: "RA2",
    role: "Acesso operacional",
    departmentKey: "recebimento",
  },
  {
    key: "estoque",
    label: "Estoque e Inventário",
    password: "EI3",
    role: "Acesso operacional",
    departmentKey: "estoque",
  },
  {
    key: "secos",
    label: "Operação Secos e Expedição",
    password: "OS4",
    role: "Acesso operacional",
    departmentKey: "secos",
  },
  {
    key: "quimicas",
    label: "Separação Química",
    password: "OQ5",
    role: "Acesso operacional",
    departmentKey: "quimicas",
  },
  {
    key: "gestao",
    label: "Gestão",
    password: "GE6",
    role: "Acesso gerencial",
    departmentKey: "almoxarifado",
    management: true,
  },
];

const profileAvatarIcons = {
  almoxarifado:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8 12 3l9 5-9 5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>',
  recebimento:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h11v8H3z"/><path d="M14 11h3l3 3v2h-6z"/><circle cx="7.5" cy="18" r="1.5"/><circle cx="17.5" cy="18" r="1.5"/></svg>',
  estoque:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/></svg>',
  secos:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/><path d="m14 6 6 6-6 6"/><path d="m10 6-6 6 6 6"/></svg>',
  quimicas:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3h4"/><path d="M10 3v5l-5 8a3 3 0 0 0 2.6 5h8.8a3 3 0 0 0 2.6-5l-5-8V3"/><path d="M8 13h8"/></svg>',
  gestao:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16"/><path d="M7 17v-5"/><path d="M12 17V8"/><path d="M17 17V5"/></svg>',
  default:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.2"/><path d="M5.8 19a6.2 6.2 0 0 1 12.4 0"/></svg>',
};

const departments = {
  almoxarifado: {
    label: "Almoxarifado (Uso e Consumo)",
    color: "#1d6b57",
    indicators: [
      { name: "Ruptura de Materiais Estocáveis", unit: "%", target: 5, goal: "lower", targetLabel: "Meta", frequency: "Diário" },
      { name: "Acuracidade de Estoque (Itens)", unit: "%", target: 97, goal: "higher", targetLabel: "Meta", frequency: "Diário" },
      { name: "Aderência ao Estoque Mínimo", unit: "%", target: 95, goal: "higher", targetLabel: "Meta", frequency: "Diário" },
      { name: "Cumprimento do Plano de Inventário", unit: "%", target: 100, goal: "higher", targetLabel: "Meta", frequency: "Mensal" },
      { name: "Estoque Slow Mover (> 90 dias)", unit: "%", target: 10, goal: "lower", targetLabel: "Meta", frequency: "Semanal" },
    ],
    launches: [],
    records: [],
  },
  recebimento: {
    label: "Recebimento e Armazenagem",
    color: "#2f68a7",
    indicators: [
      { name: "Capacidade de Recebimento Diário", unit: "%", target: 85, goal: "higher", targetLabel: "Meta" },
      { name: "OTIF de Recebimento de Fornecedores x Follow Up", unit: "%", target: 95, goal: "higher", targetLabel: "Meta" },
      { name: "Eficiência de Recebimento", unit: "%", target: 95, goal: "higher", targetLabel: "Meta" },
      { name: "Tempo Médio de Recebimento", unit: "min", target: 50, goal: "lower", targetLabel: "Até" },
      { name: "Erros de Armazenagem e Movimentação", unit: "%", target: 3, goal: "lower", targetLabel: "Meta" },
      { name: "Produtividade Individual", unit: "atividades/colab", target: null, goal: "tracking", statusText: "Acompanhamento" },
    ],
    launches: [],
    records: [],
  },
  estoque: {
    label: "Estoque e Inventário",
    color: "#7352a3",
    indicators: [
      { name: "Acuracidade de Estoque (SKU)", unit: "%", target: 95, goal: "higher", targetLabel: "Meta" },
      { name: "Divergência Contábil x WMS (SKU)", unit: "%", target: 8, goal: "lower", targetLabel: "Meta" },
      { name: "Cumprimento do Plano de Inventário", unit: "%", target: 100, goal: "higher", targetLabel: "Meta" },
      { name: "Índice de Divergências Tratadas", unit: "%", target: 98, goal: "higher", targetLabel: "Meta" },
      { name: "Estoque Slow Mover (Maior que 90 dias)", unit: "%", target: 10, goal: "lower", targetLabel: "Meta" },
      {
        name: "Produtividade de Contagens",
        unit: "SKU/dia",
        target: 20,
        goal: "higher",
        targetLabel: "Meta",
      },
    ],
    launches: [],
    records: [],
  },
  secos: {
    label: "Operação Secos e Expedição",
    color: "#b87818",
    indicators: [
      { name: "Índice de Perdas por Ajuste nos Picks Secos", unit: "%", target: 0.05, goal: "lower", targetLabel: "Meta" },
      { name: "Índice de OPs Atendidas Erradas", unit: "%", target: 0.3, goal: "lower", targetLabel: "Meta" },
      { name: "Índice de Erros de Movimentação", unit: "%", target: 0.5, goal: "lower", targetLabel: "Meta" },
      { name: "Erros Expedição Fábrica (Produto Acabado)", unit: "R$", target: 0, goal: "lower", targetLabel: "Meta" },
      { name: "Tempo Médio Carregamento Carretas", unit: "min", target: 80, goal: "lower", targetLabel: "Meta" },
      { name: "Produtividade Individual", unit: "atividades/colab", target: null, goal: "tracking", statusText: "Acompanhamento" },
    ],
    launches: [],
    records: [],
  },
  quimicas: {
    label: "Separação Química",
    color: "#c8452d",
    indicators: [
      { name: "Confiabilidade do Abastecimento da Produção", unit: "%", target: 90, goal: "higher", targetLabel: "Meta" },
      { name: "Eficiência no Atendimento das OPs", unit: "%", target: 90, goal: "higher", targetLabel: "Meta" },
      { name: "Índice de Retrabalho de Separação", unit: "%", target: 0.1, goal: "lower", targetLabel: "Meta" },
      { name: "Taxa de Giro do Kanban", unit: "%", target: 3, goal: "lower", targetLabel: "Meta" },
      { name: "Produtividade de OPs Separadas", unit: "%", target: 100, goal: "higher", targetLabel: "Meta" },
      { name: "Produtividade Individual", unit: "atividades/colab", target: null, goal: "tracking", statusText: "Acompanhamento" },
    ],
    launches: [],
    records: [],
  },
};
const statusLabel = {
  success: "Dentro da meta",
  warn: "Atenção",
  danger: "Fora da meta",
  tracking: "Acompanhamento",
  neutral: "Sem dados",
};

const statusColor = {
  success: "#22d285",
  warn: "#ffb000",
  danger: "#ff6469",
  tracking: "#3b82f6",
  neutral: "#7d8da8",
};

const chartTheme = {
  fontFamily: "Roboto, Inter, ui-sans-serif, system-ui, sans-serif",
  plotBackground: "rgba(16, 29, 58, 0.52)",
  markerFill: "#0b1730",
  axisText: "#92a4c0",
  valueText: "#f4f7ff",
  tooltipBackground: "rgba(16, 29, 58, 0.94)",
  tooltipBorder: "#2d3d5e",
  guide: "rgba(146, 164, 192, 0.32)",
  target: "#e29a12",
  lineGlow: "#7cb5ff",
  analysisStart: "#3b82f6",
  analysisMiddle: "#22d285",
  analysisEnd: "#ffb000",
};

function syncChartTheme() {
  const style = getComputedStyle(document.documentElement);
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  chartTheme.plotBackground = read("--chart-surface", chartTheme.plotBackground);
  chartTheme.markerFill = read("--surface", chartTheme.markerFill);
  chartTheme.axisText = read("--muted", chartTheme.axisText);
  chartTheme.valueText = read("--ink", chartTheme.valueText);
  chartTheme.tooltipBackground = read("--surface-raised", chartTheme.tooltipBackground);
  chartTheme.tooltipBorder = read("--line-strong", chartTheme.tooltipBorder);
  chartTheme.guide = read("--line-strong", chartTheme.guide);
  chartTheme.target = read("--chart-target", read("--accent", chartTheme.target));
  chartTheme.lineGlow = read("--series-1", chartTheme.lineGlow);
  chartTheme.analysisStart = read("--series-1", chartTheme.analysisStart);
  chartTheme.analysisMiddle = read("--series-3", chartTheme.analysisMiddle);
  chartTheme.analysisEnd = read("--series-4", chartTheme.analysisEnd);
  statusColor.success = read("--good", statusColor.success);
  statusColor.warn = read("--warning", statusColor.warn);
  statusColor.danger = read("--critical", statusColor.danger);
  statusColor.tracking = read("--series-1", statusColor.tracking);
}

function getTodayInputDate() {
  const today = new Date();
  const localDate = new Date(today.getTime() - today.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

const fiveSSenses = ["Utilização", "Ordenação", "Limpeza", "Padronização", "Disciplina"];

const fiveSAnswerOptions = [
  { value: 0, label: "Não atende", tone: "danger" },
  { value: 1, label: "Atende muito pouco", tone: "danger" },
  { value: 2, label: "Atende parcialmente", tone: "warn" },
  { value: 3, label: "Atende bem", tone: "warn" },
  { value: 4, label: "Atende plenamente", tone: "success" },
];

let fiveSChecklistEntries = [
  {
    id: "5s-q-01",
    sense: "Utilização",
    area: "Produtos químicos",
    checkpoint: "Materiais, embalagens e insumos sem uso foram removidos da área operacional.",
    weight: 1.2,
    critical: false,
    score: null,
    evidence: "",
    action: "",
  },
  {
    id: "5s-q-02",
    sense: "Utilização",
    area: "Resíduos",
    checkpoint: "Resíduos e recipientes vazios possuem destino definido e não ficam acumulados no processo.",
    weight: 1.5,
    critical: true,
    score: null,
    evidence: "",
    action: "",
  },
  {
    id: "5s-q-03",
    sense: "Ordenação",
    area: "Rotulagem",
    checkpoint: "Produtos, frascos e recipientes intermediários estão identificados de forma legível.",
    weight: 1.8,
    critical: true,
    score: null,
    evidence: "",
    action: "",
  },
  {
    id: "5s-q-04",
    sense: "Ordenação",
    area: "Manipulação",
    checkpoint: "Ferramentas, utensílios e materiais de apoio têm local definido e sinalizado.",
    weight: 1,
    critical: false,
    score: null,
    evidence: "",
    action: "",
  },
  {
    id: "5s-q-05",
    sense: "Limpeza",
    area: "Envase",
    checkpoint: "Piso, equipamentos e superfícies estão livres de resíduos, poeira e produto derramado.",
    weight: 1.4,
    critical: false,
    score: null,
    evidence: "",
    action: "",
  },
  {
    id: "5s-q-06",
    sense: "Limpeza",
    area: "Contenção",
    checkpoint: "Não há vazamentos, gotejamentos ou contenções improvisadas na área.",
    weight: 2,
    critical: true,
    score: null,
    evidence: "",
    action: "",
  },
  {
    id: "5s-q-07",
    sense: "Padronização",
    area: "Segurança e EPI",
    checkpoint: "EPIs obrigatórios, kit de emergência e FISPQ estão disponíveis e sinalizados.",
    weight: 2,
    critical: true,
    score: null,
    evidence: "",
    action: "",
  },
  {
    id: "5s-q-08",
    sense: "Padronização",
    area: "Manipulação",
    checkpoint: "Instruções de trabalho e parâmetros críticos estão visíveis no posto.",
    weight: 1.4,
    critical: false,
    score: null,
    evidence: "",
    action: "",
  },
  {
    id: "5s-q-09",
    sense: "Disciplina",
    area: "Ronda de turno",
    checkpoint: "Checklist de início e fim de turno foi executado e registrado.",
    weight: 1.5,
    critical: false,
    score: null,
    evidence: "",
    action: "",
  },
  {
    id: "5s-q-10",
    sense: "Disciplina",
    area: "Gestão visual",
    checkpoint: "Desvios 5S são tratados com responsável, prazo e recorrência controlada.",
    weight: 1.6,
    critical: false,
    score: null,
    evidence: "",
    action: "",
  },
];
function ensureFiveSMetadata() {
  fiveSChecklistEntries = fiveSChecklistEntries.map((entry, index) => ({
    ...entry,
    id: entry.id || `5s-q-${String(index + 1).padStart(2, "0")}`,
    evidence: entry.evidence || "",
    action: entry.action || "",
    score:
      entry.score === null || entry.score === undefined || entry.score === ""
        ? null
        : Math.max(0, Math.min(4, Number(entry.score))),
    weight: Number(entry.weight) || 1,
  }));
}

let fiveSAuditDate = getTodayInputDate();

let fiveSAuditRecords = [];
function ensureFiveSAuditRecordsMetadata() {
  fiveSAuditDate = /^\d{4}-\d{2}-\d{2}$/.test(fiveSAuditDate) ? fiveSAuditDate : getTodayInputDate();
  fiveSAuditRecords = (Array.isArray(fiveSAuditRecords) ? fiveSAuditRecords : [])
    .map((record, index) => ({
      id: record.id || `5s-audit-${record.date || getTodayInputDate()}-${index + 1}`,
      date: /^\d{4}-\d{2}-\d{2}$/.test(record.date || "") ? record.date : getTodayInputDate(),
      score: Number.isFinite(Number(record.score)) ? Number(record.score) : 0,
      tone: ["success", "warn", "danger"].includes(record.tone) ? record.tone : "warn",
      status: record.status || "Controlado",
      answered: Number(record.answered) || 0,
      total: Number(record.total) || fiveSChecklistEntries.length,
      criticalFailures: Number(record.criticalFailures) || 0,
      openActions: Number(record.openActions) || 0,
      focus: record.focus || "-",
      createdAt: record.createdAt || new Date().toISOString(),
    }))
    .sort((left, right) => String(right.date).localeCompare(String(left.date)) || String(right.createdAt).localeCompare(String(left.createdAt)));
}

const prototypeStorageKey = "vpc-logistica-mvp-state-v3";
const legacyPrototypeStorageKeys = ["vpc-logistica-mvp-state-v1", "vpc-logistica-mvp-state-v2"];
const actionAttachmentStorageKey = "vpc-action-record-attachments-v1";
const maxInlineAttachmentSize = 512 * 1024;

let currentUser = null;
let selectedDepartmentKey = "almoxarifado";
let currentView = "dashboard";
let currentPeriod = "semana";
let selectedMonthFilter = "";
let selectedQuarterFilter = "";
let editingLaunchId = null;
let editingRecordId = null;
let launchIdCounter = 1;
let recordIdCounter = 1;

const launchTableFilterDefaults = {
  date: "",
  indicator: "",
  value: "",
  shift: "",
  status: "",
  comment: "",
};

const actionTableFilterDefaults = {
  recordDate: "",
  type: "",
  indicator: "",
  owner: "",
  status: "",
  dueDate: "",
  description: "",
};

const managementActionTableFilterDefaults = {
  department: "",
  recordDate: "",
  type: "",
  indicator: "",
  owner: "",
  status: "",
  dueDate: "",
  description: "",
};

let launchTableFilters = { ...launchTableFilterDefaults };
let actionTableFilters = { ...actionTableFilterDefaults };
let managementActionTableFilters = { ...managementActionTableFilterDefaults };
const baselineRecordsByDepartment = {};

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

const htmlEscapeMap = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => htmlEscapeMap[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function readActionAttachments() {
  try {
    const rawAttachments = window.localStorage.getItem(actionAttachmentStorageKey);
    if (!rawAttachments) return {};
    const parsedAttachments = JSON.parse(rawAttachments);
    return parsedAttachments && typeof parsedAttachments === "object" ? parsedAttachments : {};
  } catch (error) {
    console.warn("Não foi possível carregar os anexos locais.", error);
    return {};
  }
}

function writeActionAttachments(attachments) {
  try {
    window.localStorage.setItem(actionAttachmentStorageKey, JSON.stringify(attachments));
    return true;
  } catch (error) {
    console.warn("Não foi possível salvar o anexo local.", error);
    return false;
  }
}

function removeActionAttachment(recordId) {
  if (!recordId) return;
  const attachments = readActionAttachments();
  if (!attachments[recordId]) return;
  delete attachments[recordId];
  writeActionAttachments(attachments);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error || new Error("Falha ao ler arquivo.")));
    reader.readAsDataURL(file);
  });
}

async function buildRecordFilePayload(recordId, file, existingRecord) {
  if (!file || !file.name) {
    return { file: existingRecord?.file || "" };
  }

  if (file.size > maxInlineAttachmentSize) {
    removeActionAttachment(recordId);
    showToast("Arquivo acima de 512 KB: nome salvo, visualização indisponível.", "warn");
    return { file: file.name };
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const attachment = {
      name: file.name,
      type: file.type || "",
      size: file.size || 0,
      dataUrl,
      savedAt: new Date().toISOString(),
    };
    return { file: attachment };
  } catch (error) {
    console.warn("Não foi possível preparar o arquivo para visualização.", error);
    showToast("Nome do arquivo salvo, mas não foi possível processar o conteúdo.", "warn");
  }

  return { file: file.name };
}

function getRecordFileName(record) {
  if (!record?.file) return "";
  return typeof record.file === "object" ? String(record.file.name || "") : String(record.file);
}

function serializeRecordFile(file) {
  if (!file) return null;
  if (typeof file === "object" && file.dataUrl) return JSON.stringify({ version: 1, ...file });
  return String(file);
}

function deserializeRecordFile(value) {
  if (!value || typeof value !== "string" || !value.startsWith("{")) return value || "";
  try {
    const parsed = JSON.parse(value);
    return parsed?.version === 1 && parsed?.dataUrl ? parsed : value;
  } catch {
    return value;
  }
}

function getRecordAttachment(record) {
  if (!record?.id || !record.file) return null;
  if (typeof record.file === "object" && record.file.dataUrl) return record.file;
  const attachment = readActionAttachments()[record.id];
  if (!attachment?.dataUrl) return null;
  if (attachment.name && attachment.name !== getRecordFileName(record)) return null;
  return attachment;
}

function renderRecordAttachment(record) {
  if (!record?.file) return "";
  const attachment = getRecordAttachment(record);
  const fileName = escapeHtml(getRecordFileName(record));

  if (!attachment) {
    return `<span class="record-file-name" title="Arquivo registrado sem visualização local">Arquivo: ${fileName}</span>`;
  }

  return `
    <button class="record-file-link" type="button" data-attachment-record-id="${escapeAttribute(record.id)}">
      Arquivo: ${fileName}
    </button>
  `;
}

function findRecordById(recordId) {
  for (const [departmentKey, department] of Object.entries(departments)) {
    const record = department.records.find((item) => item.id === recordId);
    if (record) return { departmentKey, record };
  }
  return null;
}

function closeAttachmentPreview() {
  qs("#attachmentPreview")?.remove();
}

function renderAttachmentPreviewContent(attachment, fileName) {
  const dataUrl = escapeAttribute(attachment.dataUrl);
  const type = String(attachment.type || "").toLowerCase();

  if (type.startsWith("image/")) {
    return `<img class="attachment-preview-media" src="${dataUrl}" alt="${fileName}" />`;
  }

  if (type === "application/pdf") {
    return `<iframe class="attachment-preview-frame" src="${dataUrl}" title="${fileName}"></iframe>`;
  }

  return `
    <div class="attachment-preview-empty">
      <p>Este tipo de arquivo não possui pré-visualização no navegador.</p>
      <a class="primary-button attachment-download" href="${dataUrl}" download="${fileName}">Baixar arquivo</a>
    </div>
  `;
}

function openAttachmentPreview(recordId) {
  const recordMatch = findRecordById(recordId);
  const record = recordMatch?.record;
  const attachment = record ? getRecordAttachment(record) : null;

  if (!record || !attachment) {
    showToast("Arquivo salvo apenas como nome. Pré-visualização indisponível.", "warn");
    return;
  }

  const fileName = escapeHtml(getRecordFileName(record));
  closeAttachmentPreview();
  document.body.insertAdjacentHTML(
    "beforeend",
    `
      <div class="attachment-modal" id="attachmentPreview" data-attachment-preview>
        <section class="attachment-dialog" role="dialog" aria-modal="true" aria-label="Pré-visualização do arquivo">
          <header class="attachment-dialog-header">
            <div>
              <p class="eyebrow">Arquivo de apoio</p>
              <h2>${fileName}</h2>
            </div>
            <button class="mini-action" type="button" data-attachment-close>Fechar</button>
          </header>
          <div class="attachment-preview-body">
            ${renderAttachmentPreviewContent(attachment, fileName)}
          </div>
        </section>
      </div>
    `,
  );
}

const textEncodingReplacements = new Map([
  ["\u00c3\u0081", "Á"],
  ["\u00c3\u00a1", "á"],
  ["\u00c3\u00a2", "â"],
  ["\u00c3\u00a3", "ã"],
  ["\u00c3\u00a7", "ç"],
  ["\u00c3\u00a9", "é"],
  ["\u00c3\u00aa", "ê"],
  ["\u00c3\u00ad", "í"],
  ["\u00c3\u00b3", "ó"],
  ["\u00c3\u00ba", "ú"],
  ["\u00c3\u00b5", "õ"],
  ["\u00c3\u0161", "Ú"],
]);

function repairTextEncoding(value) {
  let nextValue = String(value ?? "");
  textEncodingReplacements.forEach((replacement, search) => {
    nextValue = nextValue.split(search).join(replacement);
  });
  return nextValue;
}

function repairStoredText(value) {
  if (typeof value === "string") return repairTextEncoding(value);
  if (Array.isArray(value)) return value.map((item) => repairStoredText(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, repairStoredText(item)]));
  }
  return value;
}

function readPrototypeState() {
  try {
    const rawState = window.localStorage.getItem(prototypeStorageKey);
    if (!rawState) return null;
    const parsedState = JSON.parse(rawState);
    return parsedState && parsedState.version === 3 ? parsedState : null;
  } catch (error) {
    console.warn("Não foi possível carregar o estado local do MVP.", error);
    return null;
  }
}

function writePrototypeState() {
  // The SQL database is authoritative online. Rewriting thousands of rows to
  // localStorage blocks the UI and can resurrect stale data after a refresh.
  if (remotePersistenceActive()) return;

  try {
    const departmentsState = {};
    operationalDepartmentKeys.forEach((departmentKey) => {
      const department = departments[departmentKey];
      departmentsState[departmentKey] = {
        launches: clonePlain(department.launches || []),
        records: clonePlain(department.records || []),
        indicators: (department.indicators || []).map((indicator) => ({
          name: indicator.name,
          value: indicator.value,
          history: clonePlain(indicator.history || []),
          details: clonePlain(indicator.details || []),
        })),
      };
    });

    window.localStorage.setItem(
      prototypeStorageKey,
      JSON.stringify({
        version: 3,
        savedAt: new Date().toISOString(),
        departments: departmentsState,
        fiveSChecklistEntries: clonePlain(fiveSChecklistEntries),
        fiveSAuditDate,
        fiveSAuditRecords: clonePlain(fiveSAuditRecords),
      }),
    );
  } catch (error) {
    console.warn("Não foi possível salvar o estado local do MVP.", error);
  }
}

function clearLegacyPrototypeState() {
  try {
    legacyPrototypeStorageKeys.forEach((key) => window.localStorage.removeItem(key));
  } catch (error) {
    console.warn("Não foi possível limpar os dados locais de teste.", error);
  }
}

const periodWindows = {
  dia: 1,
  semana: 7,
  mes: 31,
  trimestre: 93,
};

function qs(selector) {
  return document.querySelector(selector);
}

function qsa(selector) {
  return Array.from(document.querySelectorAll(selector));
}

function isManagement() {
  return Boolean(currentUser?.management);
}

function currentDepartment() {
  return departments[selectedDepartmentKey];
}

function remotePersistenceActive() {
  return useSupabasePersistence && Boolean(vpcSupabaseSession?.access_token);
}

function updateSupabaseRealtimeAuth() {
  if (!vpcSupabaseClient || !vpcSupabaseSession?.access_token) return;
  vpcSupabaseClient.realtime.setAuth(vpcSupabaseSession.access_token);
}

function clearSupabaseSessionRefreshTimer() {
  if (vpcSupabaseSessionRefreshTimer) {
    window.clearTimeout(vpcSupabaseSessionRefreshTimer);
    vpcSupabaseSessionRefreshTimer = null;
  }
}

async function refreshSupabaseSessionNow() {
  if (!vpcSupabaseSession?.refresh_token) throw new Error("Sessão expirada. Entre novamente.");
  const refreshedSession = await supabaseAuthRequest("token?grant_type=refresh_token", {
    method: "POST",
    body: JSON.stringify({ refresh_token: vpcSupabaseSession.refresh_token }),
  });
  vpcSupabaseSession = refreshedSession;
  updateSupabaseRealtimeAuth();
  scheduleSupabaseSessionRefresh();
  return refreshedSession;
}

function scheduleSupabaseSessionRefresh() {
  clearSupabaseSessionRefreshTimer();
  if (!remotePersistenceActive() || !vpcSupabaseSession?.refresh_token) return;

  const expiresAtMs = Number(vpcSupabaseSession.expires_at)
    ? Number(vpcSupabaseSession.expires_at) * 1000
    : Date.now() + Number(vpcSupabaseSession.expires_in || 3600) * 1000;
  const refreshDelayMs = Math.max(60000, expiresAtMs - Date.now() - 120000);

  vpcSupabaseSessionRefreshTimer = window.setTimeout(async () => {
    try {
      await refreshSupabaseSessionNow();
    } catch (error) {
      console.warn("Não foi possível renovar a sessão Supabase.", error);
      scheduleSupabaseSessionRefresh();
    }
  }, refreshDelayMs);
}

function getSupabaseAuthEmail(profile) {
  return `${profile.key}@${vpcSupabaseConfig.authEmailSuffix}`;
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function fetchSupabaseWithRetry(url, options = {}, maxAttempts = supabaseRequestMaxAttempts) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), supabaseRequestTimeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      window.clearTimeout(timeoutId);
      const retryableStatus = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryableStatus || attempt === maxAttempts) return response;
      lastError = new Error(`Supabase respondeu com status ${response.status}.`);
    } catch (error) {
      window.clearTimeout(timeoutId);
      lastError = error?.name === "AbortError" ? new Error("Tempo limite de comunicação com o banco excedido.") : error;
      if (attempt === maxAttempts) break;
    }
    await wait(350 * attempt);
  }

  throw lastError || new Error("Falha na comunicação com o Supabase.");
}

async function supabaseAuthRequest(path, options = {}) {
  const response = await fetchSupabaseWithRetry(`${vpcSupabaseConfig.url}/auth/v1/${path}`, {
    ...options,
    headers: {
      apikey: vpcSupabaseConfig.anonKey,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }, 2);

  const responseText = await response.text();
  const payload = responseText ? JSON.parse(responseText) : null;

  if (!response.ok) {
    throw new Error(payload?.msg || payload?.message || "Falha de autenticação no Supabase.");
  }

  return payload;
}

async function signInSupabaseProfile(profile, password) {
  if (!useSupabasePersistence) return null;

  vpcSupabaseSession = await supabaseAuthRequest("token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({
      email: getSupabaseAuthEmail(profile),
      password,
    }),
  });
  updateSupabaseRealtimeAuth();
  scheduleSupabaseSessionRefresh();

  return vpcSupabaseSession;
}

function signOutSupabaseProfile() {
  stopSupabaseRealtimeSync();
  clearSupabaseSessionRefreshTimer();
  vpcSupabaseSession = null;
  supabaseLastFullRefreshAt = 0;
  supabaseLastIncrementalSyncAt = null;
}

async function supabaseRestRequest(table, options = {}) {
  if (!remotePersistenceActive()) {
    throw new Error("Supabase não está autenticado.");
  }

  const {
    method = "GET",
    query = "",
    body = null,
    prefer = null,
  } = options;

  const requestUrl = `${vpcSupabaseConfig.url}/rest/v1/${table}${query}`;
  const headers = {
    apikey: vpcSupabaseConfig.anonKey,
    Authorization: `Bearer ${vpcSupabaseSession.access_token}`,
    "Content-Type": "application/json",
  };

  if (prefer) headers.Prefer = prefer;

  let response = await fetchSupabaseWithRetry(requestUrl, {
    method,
    headers,
    body: body === null ? null : JSON.stringify(body),
  });

  if (response.status === 401 && vpcSupabaseSession?.refresh_token) {
    await refreshSupabaseSessionNow();
    headers.Authorization = `Bearer ${vpcSupabaseSession.access_token}`;
    response = await fetchSupabaseWithRetry(requestUrl, {
      method,
      headers,
      body: body === null ? null : JSON.stringify(body),
    });
  }

  const responseText = await response.text();
  const payload = responseText ? JSON.parse(responseText) : null;

  if (!response.ok) {
    throw new Error(payload?.message || payload?.hint || "Falha na comunicação com o Supabase.");
  }

  return payload;
}

async function loadAllSupabaseRows(table, query = "?select=*") {
  const pageSize = 1000;
  const rows = [];
  let offset = 0;

  while (true) {
    const separator = query.includes("?") ? "&" : "?";
    const page = await supabaseRestRequest(table, {
      query: `${query}${separator}limit=${pageSize}&offset=${offset}`,
    });
    const pageRows = Array.isArray(page) ? page : [];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

function getIndicatorByName(departmentKey, indicatorName) {
  const department = departments[departmentKey];
  if (!department || !indicatorName) return null;

  const normalizedName = normalizeTextKey(indicatorName);
  const directMatch = department.indicators.find(
    (indicator) => indicator.name === indicatorName || normalizeTextKey(indicator.name) === normalizedName,
  );
  if (directMatch) return directMatch;

  const canonicalNameByAlias = {
    almoxarifado: {
      "ruptura de material de estocaveis (manutencao)": "Ruptura de Materiais Estocáveis",
      "ruptura de materiais de estoque (manutencao)": "Ruptura de Materiais Estocáveis",
      "ruptura de material de estoque (manutencao)": "Ruptura de Materiais Estocáveis",
      "ruptura de materias de manutencao": "Ruptura de Materiais Estocáveis",
      "estoque slow mover (maior que 90 dias)": "Estoque Slow Mover (> 90 dias)",
    },
    recebimento: {
      "tempo medio de liberacao do material": "Tempo Médio de Recebimento",
    },
    secos: {
      "indice de perdas por ajuste no picks secos": "Índice de Perdas por Ajuste nos Picks Secos",
    },
  };
  const canonicalName = canonicalNameByAlias[departmentKey]?.[normalizedName];
  if (!canonicalName) return null;
  return department.indicators.find((indicator) => indicator.name === canonicalName) || null;
}

function encodeSupabaseFilterValue(value) {
  return encodeURIComponent(String(value));
}

function launchToSupabaseRow(launch, departmentKey = selectedDepartmentKey) {
  const indicator = getIndicatorByName(departmentKey, launch.indicator);
  const formulaType = getLaunchFormulaTypeForDepartment(departmentKey, launch.indicator);
  const numericValue = getLaunchNumericValue(launch, indicator);
  const userId = vpcSupabaseSession?.user?.id || null;

  return {
    id: launch.id,
    department_slug: departmentKey,
    indicator_name: indicator?.name || launch.indicator,
    record_date: launch.date,
    shift: normalizeDepartmentShift(launch.shift, departmentKey),
    value: numericValue,
    unit: indicator?.unit || "",
    formula_type: formulaType,
    formula_data: launch.formulaData || {},
    comment: launch.comment || null,
    created_by: launch.createdBy || userId,
    updated_by: userId,
  };
}

function supabaseRowToLaunch(row) {
  const numericValue = Number(row.value);
  const indicator = getIndicatorByName(row.department_slug, row.indicator_name);
  return {
    id: row.id,
    indicator: indicator?.name || row.indicator_name,
    value: Number.isFinite(numericValue) ? numericValue : row.value,
    numericValue,
    shift: normalizeDepartmentShift(row.shift, row.department_slug),
    date: row.record_date,
    comment: row.comment || "",
    formulaData: row.formula_data || {},
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function actionRecordToSupabaseRow(record, departmentKey = selectedDepartmentKey) {
  const indicator = getIndicatorByName(departmentKey, record.indicator);
  const userId = vpcSupabaseSession?.user?.id || null;
  return {
    id: record.id,
    department_slug: departmentKey,
    indicator_name: indicator?.name || record.indicator,
    type: record.type,
    status: normalizeRecordStatusLabel(record.status),
    owner: record.owner || "",
    due_date: record.dueDate || null,
    record_date: getRecordDate(record),
    description: record.description || "",
    file_name: serializeRecordFile(record.file),
    created_by: record.createdBy || userId,
    updated_by: userId,
  };
}

function supabaseRowToActionRecord(row) {
  const indicator = getIndicatorByName(row.department_slug, row.indicator_name);
  return {
    id: row.id,
    type: row.type,
    indicator: indicator?.name || row.indicator_name,
    owner: row.owner || "",
    dueDate: row.due_date || "",
    recordDate: row.record_date,
    status: normalizeRecordStatusLabel(row.status),
    description: row.description || "",
    file: deserializeRecordFile(row.file_name),
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function fiveSAuditRecordToSupabaseRow(record, departmentKey = selectedDepartmentKey) {
  const userId = vpcSupabaseSession?.user?.id || null;
  return {
    id: record.id,
    department_slug: departmentKey,
    audit_date: record.date,
    score: Number.isFinite(record.score) ? record.score : null,
    payload: {
      ...record,
      checklistEntries: clonePlain(fiveSChecklistEntries),
    },
    created_by: record.createdBy || userId,
    updated_by: userId,
  };
}

function supabaseRowToFiveSAuditRecord(row) {
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  const score = Number(row.score);
  return {
    id: payload.id || row.id,
    date: payload.date || row.audit_date,
    score: Number.isFinite(score) ? score : Number(payload.score) || 0,
    tone: payload.tone || "warning",
    status: payload.status || "",
    answered: Number(payload.answered) || 0,
    total: Number(payload.total) || fiveSChecklistEntries.length,
    criticalFailures: Number(payload.criticalFailures) || 0,
    openActions: Number(payload.openActions) || 0,
    focus: payload.focus || "-",
    createdAt: payload.createdAt || row.created_at || new Date().toISOString(),
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at || null,
  };
}

function resetRemoteDepartmentState(departmentKey) {
  const department = departments[departmentKey];
  if (!department) return;

  department.launches = [];
  department.records = [];
  department.indicators = department.indicators.map((indicator) => ({
    ...indicator,
    value: null,
    history: [],
    details: [],
  }));
}

function getRemoteVisibleDepartmentKeys() {
  return isManagement()
    ? [...operationalDepartmentKeys]
    : [currentUser?.departmentKey || selectedDepartmentKey].filter(Boolean);
}

function buildDepartmentRestFilter() {
  if (isManagement()) return "";
  const departmentKey = currentUser?.departmentKey || selectedDepartmentKey;
  return departmentKey ? `department_slug=eq.${encodeSupabaseFilterValue(departmentKey)}&` : "";
}

function pruneConfirmedLaunchReconciliation() {
  const now = Date.now();
  confirmedLaunchesAwaitingReconciliation.forEach((entry, id) => {
    if (entry.expiresAt <= now) confirmedLaunchesAwaitingReconciliation.delete(id);
  });
}

function rememberConfirmedLaunch(departmentKey, launch) {
  if (!launch?.id || !departmentKey) return;
  pruneConfirmedLaunchReconciliation();
  confirmedLaunchesAwaitingReconciliation.set(launch.id, {
    departmentKey,
    launch: clonePlain(launch),
    expiresAt: Date.now() + confirmedLaunchReconciliationTtlMs,
  });
}

function reconcileConfirmedLaunches(remoteLaunchIds, visibleDepartmentKeys) {
  pruneConfirmedLaunchReconciliation();
  confirmedLaunchesAwaitingReconciliation.forEach((entry, id) => {
    if (remoteLaunchIds.has(id)) {
      confirmedLaunchesAwaitingReconciliation.delete(id);
      return;
    }
    if (!visibleDepartmentKeys.includes(entry.departmentKey)) return;
    const department = departments[entry.departmentKey];
    if (!department || department.launches.some((launch) => launch.id === id)) return;
    department.launches.unshift(clonePlain(entry.launch));
  });
}

function rebuildIndicatorsFromLaunches(departmentKey) {
  const department = departments[departmentKey];
  if (!department) return;

  const previousDepartmentKey = selectedDepartmentKey;
  selectedDepartmentKey = departmentKey;

  department.indicators = department.indicators.map((indicator) => ({
    ...indicator,
    value: null,
    history: [],
    details: [],
  }));

  [...department.launches]
    .sort((left, right) => {
      const leftDate = toDateOrNull(left.date);
      const rightDate = toDateOrNull(right.date);
      if (leftDate && rightDate) return leftDate - rightDate;
      return 0;
    })
    .forEach((launch) => {
      const indicator = getIndicatorByName(departmentKey, launch.indicator);
      if (!indicator) return;
      const numericValue = getLaunchNumericValue(launch, indicator);
      if (!Number.isFinite(numericValue)) return;

      const formulaType = getLaunchFormulaType(launch.indicator);
      const historyEntry = buildHistoryEntry(launch.date, numericValue, formulaType, launch.formulaData, launch.id);
      indicator.value = numericValue;
      indicator.history = [...getIndicatorHistory(indicator, department), historyEntry];
      sortIndicatorHistory(indicator);
      applyLaunchFormulaDetails(indicator, formulaType, launch.formulaData);
      applyAlmoxarifadoLaunchFormulaDetails(indicator, formulaType, launch.formulaData);
      applyRecebimentoLaunchFormulaDetails(indicator, formulaType, launch.formulaData);
      applyEstoqueLaunchFormulaDetails(indicator, formulaType, launch.formulaData);
      applySecosLaunchFormulaDetails(indicator, formulaType, launch.formulaData);
      applyQuimicasLaunchFormulaDetails(indicator, formulaType, launch.formulaData);
    });

  selectedDepartmentKey = previousDepartmentKey;
}

async function loadSupabaseState() {
  if (!remotePersistenceActive()) return false;
  const requestStartedAt = new Date().toISOString();
  const departmentFilter = buildDepartmentRestFilter();
  const visibleDepartmentKeys = getRemoteVisibleDepartmentKeys();

  const [launchRows, actionRows, fiveSRows] = await Promise.all([
    loadAllSupabaseRows(
      "vpc_launches",
      `?select=*&${departmentFilter}order=record_date.desc,created_at.desc`,
    ),
    loadAllSupabaseRows(
      "vpc_action_records",
      `?select=*&${departmentFilter}order=record_date.desc,created_at.desc`,
    ),
    supabaseRestRequest(
      "vpc_five_s_audits",
      { query: `?select=*&${departmentFilter}order=audit_date.desc,created_at.desc&limit=12` },
    ),
  ]);

  visibleDepartmentKeys.forEach((departmentKey) => resetRemoteDepartmentState(departmentKey));

  (launchRows || []).forEach((row) => {
    const department = departments[row.department_slug];
    if (!department) return;
    department.launches.push(supabaseRowToLaunch(row));
  });

  (actionRows || []).forEach((row) => {
    const department = departments[row.department_slug];
    if (!department) return;
    department.records.push(supabaseRowToActionRecord(row));
  });

  const remoteLaunchIds = new Set((launchRows || []).map((row) => row.id));
  reconcileConfirmedLaunches(remoteLaunchIds, visibleDepartmentKeys);

  const migratedReceivingLaunches = migrateReceivingAverageLaunches();
  if (migratedReceivingLaunches.length > 0) {
    await Promise.all(
      migratedReceivingLaunches.map(({ departmentKey, launch }) => persistSupabaseLaunch(launch, departmentKey)),
    );
  }

  visibleDepartmentKeys.forEach((departmentKey) => rebuildIndicatorsFromLaunches(departmentKey));
  fiveSAuditRecords = (fiveSRows || []).map((row) => supabaseRowToFiveSAuditRecord(row));
  ensureFiveSAuditRecordsMetadata();
  ensureLaunchIds();
  ensureRecordMetadata();
  syncIdCountersFromState();
  supabaseLastFullRefreshAt = Date.now();
  supabaseLastIncrementalSyncAt = requestStartedAt;
  return true;
}

async function refreshSupabaseStateIncrementally() {
  if (!currentUser || !remotePersistenceActive() || !supabaseLastIncrementalSyncAt) {
    return refreshSupabaseStateFromRemote({ reason: "incremental-bootstrap" });
  }
  if (supabaseStateReloadInFlight) return false;

  const requestStartedAt = new Date().toISOString();
  const lastSyncTime = Date.parse(supabaseLastIncrementalSyncAt);
  const lookbackTime = Number.isFinite(lastSyncTime)
    ? new Date(lastSyncTime - supabaseIncrementalLookbackMs).toISOString()
    : supabaseLastIncrementalSyncAt;
  const since = encodeSupabaseFilterValue(lookbackTime);
  const departmentFilter = buildDepartmentRestFilter();
  supabaseStateReloadInFlight = true;
  try {
    const [launchRows, actionRows, fiveSRows] = await Promise.all([
      loadAllSupabaseRows("vpc_launches", `?select=*&${departmentFilter}updated_at=gt.${since}&order=updated_at.asc`),
      loadAllSupabaseRows("vpc_action_records", `?select=*&${departmentFilter}updated_at=gt.${since}&order=updated_at.asc`),
      loadAllSupabaseRows("vpc_five_s_audits", `?select=*&${departmentFilter}updated_at=gt.${since}&order=updated_at.asc`),
    ]);

    const affectedDepartments = new Set();
    launchRows.forEach((row) => {
      const department = departments[row.department_slug];
      if (!department) return;
      department.launches = department.launches.filter((launch) => launch.id !== row.id);
      department.launches.unshift(supabaseRowToLaunch(row));
      confirmedLaunchesAwaitingReconciliation.delete(row.id);
      affectedDepartments.add(row.department_slug);
    });
    actionRows.forEach((row) => {
      const department = departments[row.department_slug];
      if (!department) return;
      department.records = department.records.filter((record) => record.id !== row.id);
      department.records.unshift(supabaseRowToActionRecord(row));
    });
    fiveSRows.forEach((row) => {
      fiveSAuditRecords = fiveSAuditRecords.filter((record) => record.id !== row.id);
      fiveSAuditRecords.unshift(supabaseRowToFiveSAuditRecord(row));
    });

    affectedDepartments.forEach((departmentKey) => rebuildIndicatorsFromLaunches(departmentKey));
    if (fiveSRows.length) ensureFiveSAuditRecordsMetadata();
    supabaseLastIncrementalSyncAt = requestStartedAt;
    if (launchRows.length || actionRows.length || fiveSRows.length) renderAll();
    return true;
  } catch (error) {
    console.warn("Não foi possível executar a sincronização incremental.", error);
    return false;
  } finally {
    supabaseStateReloadInFlight = false;
  }
}

async function refreshSupabaseStateFromRemote(options = {}) {
  if (!currentUser || !remotePersistenceActive()) return false;

  if (supabaseStateReloadInFlight) {
    supabaseStateReloadQueued = true;
    return false;
  }

  supabaseStateReloadInFlight = true;
  try {
    await loadSupabaseState();
    writePrototypeState();
    renderAll();
    return true;
  } catch (error) {
    console.warn("Não foi possível sincronizar a base SQL.", error);
    if (options.showToast) showToast("Falha ao sincronizar a base SQL.");
    return false;
  } finally {
    supabaseStateReloadInFlight = false;
    if (supabaseStateReloadQueued) {
      supabaseStateReloadQueued = false;
      scheduleSupabaseRealtimeRefresh("queued");
    }
  }
}

function scheduleSupabaseRealtimeRefresh(reason = "realtime") {
  if (!currentUser || !remotePersistenceActive()) return;

  if (vpcSupabaseRefreshTimer) {
    window.clearTimeout(vpcSupabaseRefreshTimer);
  }

  vpcSupabaseRefreshTimer = window.setTimeout(() => {
    vpcSupabaseRefreshTimer = null;
    refreshSupabaseStateFromRemote({ reason });
  }, supabaseRealtimeRefreshDelayMs);
}

function stopSupabasePollingFallback() {
  if (!vpcSupabasePollingTimer) return;
  window.clearInterval(vpcSupabasePollingTimer);
  vpcSupabasePollingTimer = null;
}

function startSupabasePollingFallback() {
  if (vpcSupabasePollingTimer) return;
  vpcSupabasePollingTimer = window.setInterval(async () => {
    if (document.hidden) return;
    if (Date.now() - supabaseLastFullRefreshAt >= supabaseFullRefreshIntervalMs) {
      await refreshSupabaseStateFromRemote({ reason: "polling-full-reconciliation" });
      return;
    }
    await refreshSupabaseStateIncrementally();
  }, supabasePollingFallbackMs);
}

function trackLocalRealtimeMutation(table, recordId) {
  if (!recordId) return;
  const now = Date.now();
  pendingLocalRealtimeMutations.forEach((entry, key) => {
    if (entry.expiresAt <= now) pendingLocalRealtimeMutations.delete(key);
  });
  const key = `${table}:${recordId}`;
  const current = pendingLocalRealtimeMutations.get(key);
  pendingLocalRealtimeMutations.set(key, {
    count: (current?.count || 0) + 1,
    expiresAt: now + localRealtimeMutationTtlMs,
  });
}

function discardLocalRealtimeMutation(table, recordId) {
  if (recordId) pendingLocalRealtimeMutations.delete(`${table}:${recordId}`);
}

function consumeLocalRealtimeMutation(table, payload) {
  const recordId = payload?.new?.id || payload?.old?.id;
  if (!recordId) return false;
  const key = `${table}:${recordId}`;
  const entry = pendingLocalRealtimeMutations.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    pendingLocalRealtimeMutations.delete(key);
    return false;
  }
  if (entry.count > 1) {
    pendingLocalRealtimeMutations.set(key, { ...entry, count: entry.count - 1 });
  } else {
    pendingLocalRealtimeMutations.delete(key);
  }
  return true;
}

function scheduleSupabaseUiRender() {
  if (vpcSupabaseRenderTimer) window.clearTimeout(vpcSupabaseRenderTimer);
  vpcSupabaseRenderTimer = window.setTimeout(() => {
    vpcSupabaseRenderTimer = null;
    renderAll();
  }, 200);
}

function applySupabaseRealtimeChange(table, payload) {
  const isDelete = payload?.eventType === "DELETE";
  const row = isDelete ? payload?.old : payload?.new;
  if (!row?.id) return false;

  if (table === "vpc_launches") {
    const department = departments[row.department_slug];
    if (!department) return false;
    department.launches = department.launches.filter((launch) => launch.id !== row.id);
    if (!isDelete) department.launches.unshift(supabaseRowToLaunch(row));
    if (!isDelete) confirmedLaunchesAwaitingReconciliation.delete(row.id);
    rebuildIndicatorsFromLaunches(row.department_slug);
  } else if (table === "vpc_action_records") {
    const department = departments[row.department_slug];
    if (!department) return false;
    department.records = department.records.filter((record) => record.id !== row.id);
    if (!isDelete) department.records.unshift(supabaseRowToActionRecord(row));
  } else if (table === "vpc_five_s_audits") {
    fiveSAuditRecords = fiveSAuditRecords.filter((record) => record.id !== row.id);
    if (!isDelete) fiveSAuditRecords.unshift(supabaseRowToFiveSAuditRecord(row));
    ensureFiveSAuditRecordsMetadata();
    fiveSAuditRecords = fiveSAuditRecords.slice(0, 12);
  } else {
    return false;
  }

  syncIdCountersFromState();
  scheduleSupabaseUiRender();
  return true;
}

function stopSupabaseRealtimeSync() {
  if (vpcSupabaseRefreshTimer) {
    window.clearTimeout(vpcSupabaseRefreshTimer);
    vpcSupabaseRefreshTimer = null;
  }

  if (vpcSupabaseRenderTimer) {
    window.clearTimeout(vpcSupabaseRenderTimer);
    vpcSupabaseRenderTimer = null;
  }

  stopSupabasePollingFallback();

  if (vpcSupabaseClient && vpcSupabaseRealtimeChannel) {
    vpcSupabaseClient.removeChannel(vpcSupabaseRealtimeChannel);
  }
  vpcSupabaseRealtimeChannel = null;
}

function startSupabaseRealtimeSync() {
  stopSupabaseRealtimeSync();
  if (!vpcSupabaseClient || !remotePersistenceActive()) return;

  updateSupabaseRealtimeAuth();
  // Keep a lightweight incremental reconciliation active even while Realtime
  // reports SUBSCRIBED. Postgres Changes may miss events without closing the
  // channel, and users must not depend on the manual refresh button.
  startSupabasePollingFallback();
  let channel = vpcSupabaseClient.channel(`vpc-operational-sync-${currentUser?.key || "user"}`);
  supabaseRealtimeTables.forEach((table) => {
    channel = channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table,
      },
      (payload) => {
        consumeLocalRealtimeMutation(table, payload);
        if (!applySupabaseRealtimeChange(table, payload)) {
          scheduleSupabaseRealtimeRefresh(`realtime-recovery:${table}`);
        }
      },
    );
  });

  vpcSupabaseRealtimeChannel = channel.subscribe((status, error) => {
    if (status === "SUBSCRIBED") {
      refreshSupabaseStateIncrementally();
      return;
    }
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      console.warn("Canal Realtime indisponível, ativando polling reserva.", error);
      startSupabasePollingFallback();
    }
  });
}

async function persistSupabaseLaunch(launch, departmentKey = selectedDepartmentKey) {
  if (!remotePersistenceActive()) return false;
  trackLocalRealtimeMutation("vpc_launches", launch.id);
  try {
    const rows = await supabaseRestRequest("vpc_launches?on_conflict=id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: launchToSupabaseRow(launch, departmentKey),
    });
    if (!Array.isArray(rows) || rows[0]?.id !== launch.id) {
      throw new Error("O banco não confirmou o lançamento salvo.");
    }
    const confirmedLaunch = supabaseRowToLaunch(rows[0]);
    rememberConfirmedLaunch(departmentKey, confirmedLaunch);
    return confirmedLaunch;
  } catch (error) {
    discardLocalRealtimeMutation("vpc_launches", launch.id);
    throw error;
  }
}

async function findSupabaseDuplicateLaunch(launch, excludedLaunchId = null, departmentKey = selectedDepartmentKey) {
  if (!remotePersistenceActive()) return null;
  const row = launchToSupabaseRow(launch, departmentKey);
  const filters = [
    "select=id",
    `department_slug=eq.${encodeSupabaseFilterValue(row.department_slug)}`,
    `indicator_name=eq.${encodeSupabaseFilterValue(row.indicator_name)}`,
    `record_date=eq.${encodeSupabaseFilterValue(row.record_date)}`,
    `shift=eq.${encodeSupabaseFilterValue(row.shift)}`,
  ];
  if (excludedLaunchId) filters.push(`id=neq.${encodeSupabaseFilterValue(excludedLaunchId)}`);
  filters.push("limit=1");
  const rows = await supabaseRestRequest("vpc_launches", { query: `?${filters.join("&")}` });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function deleteSupabaseLaunch(launchId) {
  if (!remotePersistenceActive()) return false;
  trackLocalRealtimeMutation("vpc_launches", launchId);
  try {
    const rows = await supabaseRestRequest("vpc_launches", {
      method: "DELETE",
      query: `?id=eq.${encodeSupabaseFilterValue(launchId)}`,
      prefer: "return=representation",
    });
    if (!Array.isArray(rows) || rows[0]?.id !== launchId) {
      throw new Error("O banco não confirmou a exclusão do lançamento.");
    }
  } catch (error) {
    discardLocalRealtimeMutation("vpc_launches", launchId);
    throw error;
  }
  return true;
}

async function persistSupabaseActionRecord(record, departmentKey = selectedDepartmentKey) {
  if (!remotePersistenceActive()) return false;
  trackLocalRealtimeMutation("vpc_action_records", record.id);
  try {
    const rows = await supabaseRestRequest("vpc_action_records?on_conflict=id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: actionRecordToSupabaseRow(record, departmentKey),
    });
    if (!Array.isArray(rows) || rows[0]?.id !== record.id) {
      throw new Error("O banco não confirmou o registro salvo.");
    }
    return supabaseRowToActionRecord(rows[0]);
  } catch (error) {
    discardLocalRealtimeMutation("vpc_action_records", record.id);
    throw error;
  }
}

async function patchSupabaseActionRecord(recordId, patch) {
  if (!remotePersistenceActive()) return false;
  trackLocalRealtimeMutation("vpc_action_records", recordId);
  try {
    const rows = await supabaseRestRequest("vpc_action_records", {
      method: "PATCH",
      query: `?id=eq.${encodeSupabaseFilterValue(recordId)}`,
      prefer: "return=representation",
      body: {
        ...patch,
        updated_by: vpcSupabaseSession?.user?.id || null,
      },
    });
    if (!Array.isArray(rows) || rows[0]?.id !== recordId) {
      throw new Error("O banco não confirmou a atualização do registro.");
    }
    return supabaseRowToActionRecord(rows[0]);
  } catch (error) {
    discardLocalRealtimeMutation("vpc_action_records", recordId);
    throw error;
  }
}

async function deleteSupabaseActionRecord(recordId) {
  if (!remotePersistenceActive()) return false;
  trackLocalRealtimeMutation("vpc_action_records", recordId);
  try {
    const rows = await supabaseRestRequest("vpc_action_records", {
      method: "DELETE",
      query: `?id=eq.${encodeSupabaseFilterValue(recordId)}`,
      prefer: "return=representation",
    });
    if (!Array.isArray(rows) || rows[0]?.id !== recordId) {
      throw new Error("O banco não confirmou a exclusão do registro.");
    }
  } catch (error) {
    discardLocalRealtimeMutation("vpc_action_records", recordId);
    throw error;
  }
  return true;
}

async function persistSupabaseFiveSAuditRecord(record, departmentKey = selectedDepartmentKey) {
  if (!remotePersistenceActive()) return false;
  trackLocalRealtimeMutation("vpc_five_s_audits", record.id);
  try {
    const rows = await supabaseRestRequest("vpc_five_s_audits?on_conflict=department_slug,audit_date", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: fiveSAuditRecordToSupabaseRow(record, departmentKey),
    });
    if (!Array.isArray(rows) || rows[0]?.department_slug !== departmentKey) {
      throw new Error("O banco não confirmou a auditoria salva.");
    }
    return supabaseRowToFiveSAuditRecord(rows[0]);
  } catch (error) {
    discardLocalRealtimeMutation("vpc_five_s_audits", record.id);
    throw error;
  }
}

function getInitials(name) {
  return name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function getPeriodWindow() {
  return periodWindows[currentPeriod] || periodWindows.semana;
}

function isValidMonthFilter(value) {
  return /^\d{4}-\d{2}$/.test(value || "");
}

function getMonthFilterValueFromDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getMonthBounds(monthValue) {
  if (!isValidMonthFilter(monthValue)) return null;
  const [year, month] = monthValue.split("-").map(Number);
  return {
    startDate: new Date(year, month - 1, 1),
    endDate: new Date(year, month, 0),
  };
}

function isValidQuarterFilter(value) {
  return /^\d{4}-Q[1-4]$/.test(value || "");
}

function getQuarterFilterValueFromDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`;
}

function getQuarterBounds(quarterValue) {
  if (!isValidQuarterFilter(quarterValue)) return null;
  const [yearValue, quarterValuePart] = quarterValue.split("-Q").map(Number);
  const startMonth = (quarterValuePart - 1) * 3;
  return {
    startDate: new Date(yearValue, startMonth, 1),
    endDate: new Date(yearValue, startMonth + 3, 0),
  };
}

function formatQuarterFilterLabel(quarterValue) {
  if (!isValidQuarterFilter(quarterValue)) return "Trimestre";
  const [yearValue, quarterValuePart] = quarterValue.split("-Q");
  return `${quarterValuePart}º Trimestre de ${yearValue}`;
}

function formatMonthFilterLabel(monthValue) {
  if (!isValidMonthFilter(monthValue)) return "Mês";
  const [year, month] = monthValue.split("-").map(Number);
  const label = new Date(year, month - 1, 1).toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function getDepartmentDateValues(department) {
  const values = [];
  if (!department) return values;

  (department.indicators || []).forEach((indicator) => {
    getIndicatorHistory(indicator, department).forEach((entry) => values.push(entry.date));
  });
  (department.launches || []).forEach((launch) => values.push(launch.date));
  (department.records || []).forEach((record) => values.push(getRecordDate(record)));

  return values;
}

function getPeriodContextDateValues() {
  if (isManagement()) {
    return operationalDepartmentKeys.flatMap((key) => getDepartmentDateValues(departments[key]));
  }

  return getDepartmentDateValues(currentDepartment());
}

function getDefaultMonthFilterValue(values = getPeriodContextDateValues()) {
  return getMonthFilterValueFromDate(maxDateFromValues(values) || new Date());
}

function getAvailableYearFilterValues(values = getPeriodContextDateValues()) {
  const years = Array.from(
    new Set(
      values
        .map((value) => toDateOrNull(value))
        .filter(Boolean)
        .map((date) => String(date.getFullYear())),
    ),
  ).sort((left, right) => Number(right) - Number(left));

  const selectedYear = currentPeriod === "trimestre" && isValidQuarterFilter(selectedQuarterFilter)
    ? selectedQuarterFilter.slice(0, 4)
    : isValidMonthFilter(selectedMonthFilter) ? selectedMonthFilter.slice(0, 4) : "";
  if (selectedYear && !years.includes(selectedYear)) {
    years.unshift(selectedYear);
  }

  if (years.length === 0) {
    years.push(String(new Date().getFullYear()));
  }

  return years;
}

function ensureSelectedMonthFilter(values = getPeriodContextDateValues()) {
  if (!isValidMonthFilter(selectedMonthFilter)) {
    selectedMonthFilter = getDefaultMonthFilterValue(values);
  }
  return selectedMonthFilter;
}

function ensureSelectedQuarterFilter(values = getPeriodContextDateValues()) {
  if (!isValidQuarterFilter(selectedQuarterFilter)) {
    selectedQuarterFilter = getQuarterFilterValueFromDate(maxDateFromValues(values) || new Date());
  }
  return selectedQuarterFilter;
}

function syncYearFilterOptions(yearFilter, values = getPeriodContextDateValues()) {
  if (!yearFilter) return;
  const years = getAvailableYearFilterValues(values);
  const currentOptions = Array.from(yearFilter.options).map((option) => option.value).join("|");
  const nextOptions = years.join("|");

  if (currentOptions !== nextOptions) {
    yearFilter.innerHTML = years.map((year) => `<option value="${year}">${year}</option>`).join("");
  }
}

function setSelectedMonthFilterFromControls() {
  const monthFilter = qs("#monthFilter");
  const yearFilter = qs("#yearFilter");
  const monthValue = monthFilter?.value || selectedMonthFilter.slice(5, 7);
  const yearValue = yearFilter?.value || selectedMonthFilter.slice(0, 4);

  if (!/^\d{4}$/.test(yearValue) || !/^(0[1-9]|1[0-2])$/.test(monthValue)) return false;

  selectedMonthFilter = `${yearValue}-${monthValue}`;
  return true;
}

function setSelectedQuarterFilterFromControls() {
  const quarterValue = qs("#quarterFilter")?.value;
  const yearValue = qs("#yearFilter")?.value || selectedQuarterFilter.slice(0, 4);
  if (!/^[1-4]$/.test(quarterValue || "") || !/^\d{4}$/.test(yearValue)) return false;
  selectedQuarterFilter = `${yearValue}-Q${quarterValue}`;
  return true;
}

function syncMonthFilterControl() {
  const monthFilterWrap = qs("#monthFilterWrap");
  const quarterFilterWrap = qs("#quarterFilterWrap");
  const yearFilterWrap = qs("#yearFilterWrap");
  const monthFilter = qs("#monthFilter");
  const quarterFilter = qs("#quarterFilter");
  const yearFilter = qs("#yearFilter");
  const showMonthFilter = currentPeriod === "mes";
  const showQuarterFilter = currentPeriod === "trimestre";

  if (monthFilterWrap) {
    monthFilterWrap.classList.toggle("hidden", !showMonthFilter);
  }
  if (quarterFilterWrap) {
    quarterFilterWrap.classList.toggle("hidden", !showQuarterFilter);
  }
  if (yearFilterWrap) {
    yearFilterWrap.classList.toggle("hidden", !showMonthFilter && !showQuarterFilter);
  }

  if (yearFilter) {
    yearFilter.disabled = !showMonthFilter && !showQuarterFilter;
  }
  if (monthFilter) {
    monthFilter.disabled = !showMonthFilter;
  }
  if (quarterFilter) {
    quarterFilter.disabled = !showQuarterFilter;
  }
  if (showMonthFilter) {
    const monthValue = ensureSelectedMonthFilter();
    const [year, month] = monthValue.split("-");
    syncYearFilterOptions(yearFilter);
    if (monthFilter) monthFilter.value = month;
    if (yearFilter) yearFilter.value = year;
  }
  if (showQuarterFilter) {
    const quarterValue = ensureSelectedQuarterFilter();
    const [year, quarter] = quarterValue.split("-Q");
    syncYearFilterOptions(yearFilter);
    if (quarterFilter) quarterFilter.value = quarter;
    if (yearFilter) yearFilter.value = year;
  }
}

function getSelectedOptionLabel(selector, fallback) {
  const select = qs(selector);
  return select?.options[select.selectedIndex]?.text || fallback;
}

function getActivePeriodLabel() {
  if (currentPeriod === "mes") {
    return formatMonthFilterLabel(ensureSelectedMonthFilter());
  }

  if (currentPeriod === "trimestre") {
    return formatQuarterFilterLabel(ensureSelectedQuarterFilter());
  }

  const periodLabel = getSelectedOptionLabel("#periodSelect", "Período");
  const bounds = getDateFilterBounds();
  return `${periodLabel} · ${formatDateLabel(getTvDateKey(bounds.startDate))} a ${formatDateLabel(getTvDateKey(bounds.endDate))}`;
}

function getDateFilterBounds(values = []) {
  if (currentPeriod === "mes") {
    return getMonthBounds(ensureSelectedMonthFilter());
  }

  if (currentPeriod === "trimestre") {
    return getQuarterBounds(ensureSelectedQuarterFilter());
  }

  const referenceDate = toDateOrNull(getTodayInputDate());
  return {
    startDate: datePeriodStart(referenceDate, getPeriodWindow()),
    endDate: referenceDate,
  };
}
function formatDateLabel(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }
  return value;
}

function getIndicatorHistory(indicator, department = currentDepartment()) {
  if (Array.isArray(indicator.history) && indicator.history.length > 0) {
    return indicator.history;
  }

  if (Array.isArray(indicator.trend) && indicator.trend.length > 0) {
    const hasDepartmentDates =
      Array.isArray(department.historyDates) &&
      department.historyDates.length === indicator.trend.length;
    const labels = hasDepartmentDates
      ? department.historyDates
      : indicator.trend.map((_, index) => `P${String(index + 1).padStart(2, "0")}`);

    return labels.map((date, index) => ({
      date,
      value: Number(indicator.trend[index]),
    }));
  }

  if (indicator.value !== null && indicator.value !== undefined && Number.isFinite(Number(indicator.value))) {
    return [{ date: "Atual", value: Number(indicator.value) }];
  }

  return [];
}

function getFilteredHistory(indicator, department = currentDepartment()) {
  const history = getIndicatorHistory(indicator, department);
  const bounds = getDateFilterBounds(history.map((item) => item.date));

  if (!bounds) {
    return [];
  }

  return history.filter((item) => {
    if (item.value === null || item.value === undefined || item.value === "" || !Number.isFinite(Number(item.value))) return false;
    const itemDate = toDateOrNull(item.date);
    if (!itemDate) return false;
    return isDateInsidePeriod(itemDate, bounds.startDate, bounds.endDate);
  });
}

function getIndicatorAverageValue(indicator, department = currentDepartment()) {
  const filteredHistory = getFilteredHistory(indicator, department);
  if (filteredHistory.length === 0) {
    return null;
  }
  const total = filteredHistory.reduce((acc, item) => acc + Number(item.value), 0);
  return total / filteredHistory.length;
}

function isSummedIndicator(indicator) {
  const key = normalizeTextKey(indicator?.name);
  return key.includes("erros") && key.includes("expedicao");
}

function getIndicatorAccumulatedValue(indicator, department = currentDepartment()) {
  if (isSummedIndicator(indicator)) {
    const filteredHistory = getFilteredHistory(indicator, department);
    return filteredHistory.length
      ? filteredHistory.reduce((total, item) => total + Number(item.value), 0)
      : null;
  }
  return getIndicatorAverageValue(indicator, department);
}

function getStatus(indicator, department = currentDepartment(), valueOverride = undefined) {
  const currentValue =
    valueOverride !== undefined
      ? valueOverride
      : getIndicatorAccumulatedValue(indicator, department);

  if (currentValue === null || currentValue === undefined || !Number.isFinite(Number(currentValue))) {
    return "neutral";
  }

  if (indicator.goal === "tracking" || indicator.target === null || indicator.target === undefined) {
    return "tracking";
  }

  if (indicator.goal === "higher") {
    if (currentValue >= indicator.target) return "success";
    if (currentValue >= indicator.target * 0.97) return "warn";
    return "danger";
  }

  if (currentValue <= indicator.target) return "success";
  if (indicator.target === 0) return currentValue === 0 ? "success" : "danger";
  if (indicator.warnLimit && currentValue <= indicator.warnLimit) return "warn";
  if (currentValue <= indicator.target * 1.18) return "warn";
  return "danger";
}

function indicatorStatusLabel(indicator, department = currentDepartment()) {
  const status = getStatus(indicator, department);
  if (status === "neutral") return statusLabel.neutral;
  return indicator.statusText || statusLabel[status];
}

function statusCounts(indicators, department = currentDepartment()) {
  return indicators.reduce(
    (summary, indicator) => {
      summary[getStatus(indicator, department)] += 1;
      return summary;
    },
    { success: 0, warn: 0, danger: 0, tracking: 0, neutral: 0 },
  );
}

function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: Number(value) % 1 === 0 ? 0 : 1,
  }).format(Number(value));
}

function shouldDisplayWithoutDecimalsInChart(indicator) {
  const key = normalizeTextKey(indicator?.name);
  return (
    key === "tempo de recebimento" ||
    key === "tempo medio de recebimento" ||
    key === "tempo medio de liberacao do material" ||
    key === "tempo medio carregamento carretas" ||
    key === "produtividade de contagens" ||
    key === "produtividade individual (contagens)"
  );
}

function shouldDisplayWithoutDecimalsInCard(indicator) {
  const key = normalizeTextKey(indicator?.name);
  return (
    shouldDisplayWithoutDecimalsInChart(indicator) ||
    key === "movimentacao por colaborador" ||
    key === "tempo medio de carregamento" ||
    key === "tempo de espera de carregamento"
  );
}

function formatIntegerDisplay(value) {
  return new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: 0,
  }).format(Math.round(Number(value) || 0));
}

function formatMetric(indicator, valueOverride = undefined) {
  const currentValue =
    valueOverride !== undefined ? valueOverride : getIndicatorAccumulatedValue(indicator);
  if (currentValue === null || currentValue === undefined || !Number.isFinite(Number(currentValue))) {
    return "Sem dados";
  }
  if (indicator.unit === "R$") {
    return `R$ ${formatNumber(currentValue)}`;
  }
  if (shouldDisplayWithoutDecimalsInCard(indicator)) {
    return `${formatIntegerDisplay(currentValue)}${indicator.unit === "%" ? "%" : ` ${indicator.unit}`}`;
  }
  return `${formatNumber(currentValue)}${indicator.unit === "%" ? "%" : ` ${indicator.unit}`}`;
}

function formatShortDate(dateValue) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    const [_, month, day] = dateValue.split("-");
    return `${day}/${month}`;
  }
  return dateValue;
}

function getCardDetails(indicator) {
  const history = getFilteredHistory(indicator);
  const indicatorKey = normalizeTextKey(indicator.name);
  const rowsWithFields = (fields) =>
    history.filter((item) => fields.every((field) => Number.isFinite(Number(item[field]))));
  const totalField = (rows, field) => rows.reduce((sum, item) => sum + Number(item[field]), 0);
  const averageField = (rows, field) => totalField(rows, field) / rows.length;
  const sumField = averageField;
  const formatNumber = formatIntegerDisplay;

  if (indicatorKey.includes("capacidade") && indicatorKey.includes("recebimento")) {
    const rows = rowsWithFields(["dailyReceipts", "plannedReceiptCapacity"]);
    if (rows.length > 0) {
      return [
        ["Recebimentos", formatNumber(sumField(rows, "dailyReceipts"))],
        ["Capacidade planejada", formatNumber(sumField(rows, "plannedReceiptCapacity"))],
      ];
    }
  }

  if (indicatorKey.includes("otif") && indicatorKey.includes("recebimento")) {
    const rows = rowsWithFields(["onTimeSupplierDeliveries", "scheduledSupplierDeliveries"]);
    if (rows.length > 0) {
      return [
        ["Entregas no prazo", formatNumber(sumField(rows, "onTimeSupplierDeliveries"))],
        ["Entregas programadas", formatNumber(sumField(rows, "scheduledSupplierDeliveries"))],
      ];
    }
  }

  if (indicatorKey.includes("eficiencia") && indicatorKey.includes("recebimento")) {
    const rows = rowsWithFields(["completedReceiptsOnTime", "totalReceipts"]);
    if (rows.length > 0) {
      return [
        ["Recebimentos no prazo", formatNumber(sumField(rows, "completedReceiptsOnTime"))],
        ["Total de recebimentos", formatNumber(sumField(rows, "totalReceipts"))],
      ];
    }
  }

  if (
    indicatorKey.includes("tempo") &&
    ((indicatorKey.includes("recebimento") && selectedDepartmentKey === "recebimento") ||
      (indicatorKey.includes("liberacao") && indicatorKey.includes("material")))
  ) {
    const rows = rowsWithFields(["releaseTotalHours", "releasedReceipts"]);
    if (rows.length > 0) {
      return [
        ["Tempo total", `${formatNumber(sumField(rows, "releaseTotalHours"))} h`],
        ["Recebimentos", formatNumber(sumField(rows, "releasedReceipts"))],
      ];
    }
  }

  if (indicatorKey.includes("erros") && indicatorKey.includes("armazenagem") && indicatorKey.includes("movimentacao")) {
    const rows = rowsWithFields(["readdressedMaterials", "totalStoredMaterials"]);
    if (rows.length > 0) {
      return [
        ["Materiais reendereçados", formatNumber(sumField(rows, "readdressedMaterials"))],
        ["Materiais armazenados", formatNumber(sumField(rows, "totalStoredMaterials"))],
      ];
    }
  }

  if (indicatorKey.includes("acuracidade") && indicatorKey.includes("estoque") && indicatorKey.includes("sku")) {
    const rows = rowsWithFields(["correctItems", "totalCountedItems"]);
    if (rows.length > 0) {
      return [
        ["Itens corretos", formatNumber(sumField(rows, "correctItems"))],
        ["Itens contados", formatNumber(sumField(rows, "totalCountedItems"))],
      ];
    }
  }

  if (indicatorKey.includes("divergencia") && indicatorKey.includes("contabil") && indicatorKey.includes("wms")) {
    const rows = rowsWithFields(["divergentSkus", "totalSkus"]);
    if (rows.length > 0) {
      return [
        ["SKUs divergentes", formatNumber(sumField(rows, "divergentSkus"))],
        ["Tn��}��G����ƭy�t = Math.max(42, (card?.clientHeight || table.clientHeight) - cardPadding - (header?.offsetHeight || 0) - cardGap);
  const rowHeight = Math.max(42, (availableHeight - rowGap * (visibleRowCount - 1)) / visibleRowCount);
  table.style.setProperty("--tv-alert-viewport-height", `${availableHeight}px`);
  table.style.setProperty("--tv-alert-row-height", `${rowHeight}px`);

  if (!settled) {
    window.requestAnimationFrame(() => syncTvPriorityAlertsViewport(true));
  }
}

function renderTvExecutiveReadings(readings) {
  return `
    <section class="tv-insight-card tv-executive-readings">
      <div class="tv-card-heading">
        <p class="eyebrow light">Leituras executivas</p>
        <h3>Resumo gerencial</h3>
      </div>
      <div class="tv-reading-list">
        ${readings
          .map(
            (reading) => `
              <article class="tv-reading-item ${reading.tone}">
                <span class="tv-reading-icon">${renderTvIcon(reading.icon || (reading.tone === "success" ? "trophy" : reading.tone === "danger" ? "alert" : "health"))}</span>
                <div>
                  <span>${escapeHtml(reading.label)}</span>
                  <strong>${escapeHtml(reading.title)}</strong>
                  <small>${escapeHtml(reading.description)}</small>
                </div>
              </article>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderTvSectorHealthBarChart(items) {
  return `
    <section class="tv-insight-card">
      <div class="tv-card-heading">
        <p class="eyebrow light">Comparativo de saúde por setor</p>
        <h3>Performance consolidada</h3>
      </div>
      <div class="tv-health-bars">
        ${items
          .map((item) => {
            const tone = getTvHealthTone(item.health);
            return `
              <article class="tv-health-row ${tone}">
                <span>${escapeHtml(item.sector)}</span>
                <div class="tv-health-track">
                  <div style="width: ${Math.max(0, Math.min(100, item.health))}%"></div>
                </div>
                <strong>${item.health}%</strong>
              </article>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function getTvDateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getTvDateKeysInRange(startDate, endDate) {
  const dates = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    dates.push(getTvDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function isTvBusinessDay(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function getTvDateKeysForDepartment(startDate, endDate, departmentKey) {
  const dateKeys = getTvDateKeysInRange(startDate, endDate);
  if (!commercialOnlyDepartmentKeys.has(departmentKey)) return dateKeys;
  return dateKeys.filter((dateKey) => isTvBusinessDay(toDateOrNull(dateKey)));
}

function getTvFillingBounds() {
  const values = getPeriodContextDateValues();
  const bounds = getDateFilterBounds(values);
  if (bounds) return bounds;

  const today = toDateOrNull(getTodayInputDate());
  return {
    startDate: today,
    endDate: today,
  };
}

function getTopMissingItem(counter, fallbackLabel) {
  let topLabel = fallbackLabel;
  let topValue = 0;

  counter.forEach((value, label) => {
    if (value > topValue) {
      topValue = value;
      topLabel = label;
    }
  });

  return { label: topLabel, value: topValue };
}

function getFillingIndicatorIdentity(departmentKey, indicatorName) {
  const directIndicator = getIndicatorByName(departmentKey, indicatorName);
  if (directIndicator) return normalizeTextKey(directIndicator.name);

  const formulaType = getLaunchFormulaTypeForDepartment(departmentKey, indicatorName);
  if (formulaType) {
    const formulaIndicator = (departments[departmentKey]?.indicators || []).find(
      (indicator) => getLaunchFormulaTypeForDepartment(departmentKey, indicator.name) === formulaType,
    );
    if (formulaIndicator) return normalizeTextKey(formulaIndicator.name);
  }

  return normalizeTextKey(indicatorName);
}

function getTvFillingAnalysis() {
  const { startDate, endDate } = getTvFillingBounds();
  const today = toDateOrNull(getTodayInputDate());
  const effectiveEnd = endDate > today ? today : endDate;

  const departmentsAnalysis = operationalDepartmentKeys.map((departmentKey) => {
    const department = departments[departmentKey];
    const schedulePending = false;
    const dateKeys = getTvDateKeysForDepartment(startDate, effectiveEnd, departmentKey);
    const shiftOptions = commercialOnlyDepartmentKeys.has(departmentKey) ? ["Comercial"] : ["Turno A", "Turno B", "Turno C", "Turno D"];
    const indicators = department.indicators || [];
    let expectedTotal = 0;
    const filledKeys = new Set();

    (department.launches || []).forEach((launch) => {
      const launchDate = toDateOrNull(launch.date);
      if (!launchDate || launchDate < startDate || launchDate > effectiveEnd) return;
      const indicatorIdentity = getFillingIndicatorIdentity(departmentKey, launch.indicator);
      const indicator = indicators.find((item) => getFillingIndicatorIdentity(departmentKey, item.name) === indicatorIdentity);
      const frequency = getFillingFrequency(departmentKey, indicator);
      filledKeys.add(
        [
          getFillingPeriodKey(launchDate, frequency),
          frequency === "Diário" ? normalizeDepartmentShift(launch.shift, departmentKey) : "Setor",
          indicatorIdentity,
        ].join("|"),
      );
    });
    const missingByShift = new Map(shiftOptions.map((shift) => [shift, 0]));
    const missingByDate = new Map(dateKeys.map((dateKey) => [dateKey, 0]));
    let completedTotal = 0;
    const checkedKeys = new Set();
    const missing = [];

    dateKeys.forEach((dateKey) => {
      getFillingShiftsForDate(dateKey, departmentKey).forEach((shift) => {
        indicators.forEach((indicator) => {
          const frequency = getFillingFrequency(departmentKey, indicator);
          const periodKey = getFillingPeriodKey(toDateOrNull(dateKey), frequency);
          const expectedShift = frequency === "Diário" ? shift : "Setor";
          const key = [periodKey, expectedShift, getFillingIndicatorIdentity(departmentKey, indicator.name)].join("|");
          if (checkedKeys.has(key)) return;
          checkedKeys.add(key);
          expectedTotal += 1;
          if (filledKeys.has(key)) {
            completedTotal += 1;
            return;
          }

          missingByShift.set(expectedShift, (missingByShift.get(expectedShift) || 0) + 1);
          missingByDate.set(dateKey, (missingByDate.get(dateKey) || 0) + 1);
          missing.push({ indicator: indicator.name, date: dateKey, shift: expectedShift, frequency, periodKey });
        });
      });
    });

    const missingTotal = Math.max(0, expectedTotal - completedTotal);
    const coverage = expectedTotal ? Math.round((completedTotal / expectedTotal) * 100) : null;
    const topShift = getTopMissingItem(missingByShift, "Sem pendência");
    const topDate = getTopMissingItem(missingByDate, "Sem pendência");

    return {
      departmentKey,
      schedulePending,
      missing,
      department: department.label,
      expectedTotal,
      completedTotal,
      missingTotal,
      missingDays: Array.from(missingByDate.values()).filter((value) => value > 0).length,
      coverage,
      topShift,
      topDate,
    };
  });

  const expectedTotal = departmentsAnalysis.reduce((sum, item) => sum + item.expectedTotal, 0);
  const completedTotal = departmentsAnalysis.reduce((sum, item) => sum + item.completedTotal, 0);
  const missingTotal = departmentsAnalysis.reduce((sum, item) => sum + item.missingTotal, 0);
  const coverage = expectedTotal ? Math.round((completedTotal / expectedTotal) * 100) : null;

  return {
    periodLabel: getActivePeriodLabel(),
    expectedTotal,
    completedTotal,
    missingTotal,
    coverage,
    pendingSchedules: departmentsAnalysis.filter((item) => item.schedulePending).length,
    departments: departmentsAnalysis
      .sort((left, right) => right.missingTotal - left.missingTotal),
  };
}

function getFillingFrequency(departmentKey, indicator) {
  if (["Diário", "Semanal", "Mensal"].includes(indicator?.frequency)) return indicator.frequency;
  const name = normalizeTextKey(indicator?.name || "");
  if ((departmentKey === "almoxarifado" || departmentKey === "estoque") && name.includes("slow mover")) return "Semanal";
  if (departmentKey === "quimicas" && name.includes("kanban")) return "Semanal";
  if (departmentKey === "almoxarifado" && name.includes("cumprimento") && name.includes("plano") && name.includes("inventario")) return "Mensal";
  return "Diário";
}

function getFillingPeriodKey(date, frequency) {
  if (frequency === "Semanal") return getFillingWeekKey(date);
  if (frequency === "Mensal") return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
  return getTvDateKey(date);
}

function isWeeklyFillingIndicator(departmentKey, indicator) {
  return getFillingFrequency(departmentKey, indicator) === "Semanal";
}

function getFillingShiftsForDate(dateKey, departmentKey) {
  if (commercialOnlyDepartmentKeys.has(departmentKey)) return ["Comercial"];
  // The date belongs to the start of the shift; UTC arithmetic avoids DST drift.
  const dayOffset = Math.round((Date.parse(`${dateKey}T00:00:00Z`) - Date.UTC(2026, 8, 4)) / 86400000);
  const shifts = dayOffset % 2 === 0 ? ["Turno A", "Turno B"] : ["Turno C", "Turno D"];
  return shifts.filter((shift, index) => Date.parse(`${dateKey}T${index === 0 ? "07" : "19"}:00:00-03:00`) <= Date.now());
}

function getFillingWeekKey(date) {
  const monday = new Date(date);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return getTvDateKey(monday);
}

function getTvSectorStatusFromTone(tone) {
  if (tone === "success") return "best";
  if (tone === "warn") return "medium";
  if (tone === "danger") return "critical";
  return "neutral";
}

function isTvProductivityIndicator(indicator) {
  return normalizeTextKey(indicator?.name).includes("produtividade individual");
}

function formatTvIndicatorValue(row) {
  if (!row || row.accumulatedValue === null || row.accumulatedValue === undefined) return "Sem dados";
  return formatMetric(row.indicator, row.accumulatedValue);
}

function buildTvSectorData() {
  return operationalDepartmentKeys.map((departmentKey, index) => {
    const stats = getDepartmentAnalysisStats(departmentKey);
    const indicators = stats.rows
      .filter((row) => !isTvProductivityIndicator(row.indicator))
      .map((row) => ({
        name: row.indicator.name,
        accumulated: formatTvIndicatorValue(row),
        target: formatTargetValue(row.indicator),
        status: row.status,
      }));
    const productivityRow = stats.rows.find((row) => isTvProductivityIndicator(row.indicator));

    return {
      rank: index + 1,
      name: stats.label,
      health: stats.score === null ? null : Math.round(stats.score),
      status: getTvSectorStatusFromTone(stats.tone),
      counts: stats.counts,
      indicators,
      productivity: productivityRow
        ? {
            name: productivityRow.indicator.name,
            value: formatTvIndicatorValue(productivityRow),
          }
        : null,
    };
  });
}

function getTvPriorityAlerts(rows) {
  return rows
    .filter((row) => row.status === "danger" || row.status === "warn")
    .sort((left, right) => {
      const riskDiff = getIndicatorRiskWeight(right) - getIndicatorRiskWeight(left);
      if (riskDiff !== 0) return riskDiff;
      const gapDiff = getIndicatorGap(right) - getIndicatorGap(left);
      if (gapDiff !== 0) return gapDiff;
      return String(left.departmentLabel).localeCompare(String(right.departmentLabel), "pt-BR");
    })
    .slice(0, 11)
    .map((row) => ({
      indicator: row.indicator.name,
      sector: row.departmentLabel,
      accumulated: formatTvIndicatorValue(row),
      target: formatTargetValue(row.indicator),
      status: row.status,
    }));
}

function buildTvExecutiveReadings(sectors, alerts, fillingAnalysis) {
  const rankedSectors = sectors.filter((sector) => sector.health !== null).sort((left, right) => right.health - left.health);
  const bestSector = rankedSectors[0];
  const maxCritical = Math.max(0, ...sectors.map((sector) => sector.counts?.danger || 0));
  const criticalSectors = sectors
    .filter((sector) => maxCritical > 0 && (sector.counts?.danger || 0) === maxCritical)
    .map((sector) => sector.name);
  const topAlert = alerts[0];
  const fillingFocus = fillingAnalysis.departments[0];
  const missingDataSectors = sectors.filter((sector) => sector.counts.neutral > 0);
  const missingIndicators = missingDataSectors.reduce((sum, sector) => sum + sector.counts.neutral, 0);

  return [
    {
      tone: "success",
      label: "Melhor setor",
      title: bestSector?.name || "Sem dados",
      icon: "trophy",
      description: bestSector
        ? `${bestSector.health}% de saúde no período selecionado.`
        : "Sem dados no período selecionado.",
    },
    {
      tone: maxCritical > 0 ? "danger" : "success",
      label: "Setores mais críticos",
      title: criticalSectors.length ? criticalSectors.join(" e ") : bestSector ? "Sem setores críticos" : "Sem dados",
      icon: "alert",
      description:
        maxCritical > 0
          ? `Cada um com ${maxCritical} indicadores críticos.`
          : "Nenhum indicador crítico no período selecionado.",
    },
    {
      tone: topAlert ? "warn" : "success",
      label: "Principal risco",
      title: topAlert?.indicator || (bestSector ? "Risco controlado" : "Sem dados"),
      icon: "health",
      description: topAlert
        ? `${topAlert.sector}: acumulado ${topAlert.accumulated} frente à meta ${topAlert.target}.`
        : bestSector ? "Sem alertas em atenção ou críticos no período." : "Sem dados no período selecionado.",
    },
    {
      tone: fillingFocus ? "process" : "success",
      label: "Ritmo de gestão",
      title: fillingFocus ? "Rotina de preenchimento" : "Preenchimento completo",
      icon: "checklist",
      description: fillingFocus
        ? `${fillingFocus.department}: ${fillingFocus.missingTotal} pendências em ${fillingAnalysis.periodLabel}.`
        : "Todos os registros previstos foram preenchidos.",
    },
    {
      tone: missingIndicators ? "warn" : "success",
      label: "Cobertura dos indicadores",
      title: missingIndicators ? `${missingIndicators} indicadores sem dados em ${missingDataSectors.length} setores` : "Todos os indicadores com dados",
      icon: "clipboard",
      description: missingIndicators
        ? missingDataSectors.map((sector) => `${sector.name}: ${sector.counts.neutral}`).join(" · ")
        : "Todos os indicadores cadastrados possuem resultados no período selecionado.",
    },
  ];
}

function buildTvDashboardData() {
  const rows = getOperationalIndicatorRows();
  const monitoredRows = rows.filter((row) => row.indicator.goal !== "tracking");
  const statusRows = monitoredRows.filter((row) => isOperationalStatus(row.status));
  const onTarget = statusRows.filter((row) => row.status === "success").length;
  const attention = statusRows.filter((row) => row.status === "warn").length;
  const critical = statusRows.filter((row) => row.status === "danger").length;
  const sectors = buildTvSectorData();
  const alerts = getTvPriorityAlerts(statusRows);
  const fillingAnalysis = getTvFillingAnalysis();

  return {
    periodLabel: getActivePeriodLabel(),
    generatedAt: new Date(),
    summary: {
      totalIndicators: statusRows.length,
      onTarget,
      attention,
      critical,
      health: statusRows.length ? Math.round((onTarget / statusRows.length) * 100) : null,
    },
    sectors,
    alerts,
    executiveReadings: buildTvExecutiveReadings(sectors, alerts, fillingAnalysis),
    fillingAnalysis,
  };
}

function renderTvFillingAnalysis(analysis) {
  const tone = analysis.coverage === null ? "neutral" : analysis.coverage >= 95 ? "success" : analysis.coverage >= 80 ? "warn" : "danger";
  const rows = analysis.departments.length
    ? analysis.departments
        .map(
          (item) => `
            <button type="button" class="tv-filling-row" data-filling-department="${escapeHtml(item.departmentKey)}">
              <div>
                <strong>${escapeHtml(item.department)}</strong>
                <span>${item.coverage === null ? "Sem registros previstos no período" : `${item.coverage}% preenchido · ${item.missingTotal} pendências`}</span>
              </div>
              <div>
                <small>Turno mais pendente</small>
                <strong>${item.schedulePending ? "A, B, C e D" : escapeHtml(item.topShift.label)}</strong>
              </div>
              <div>
                <small>Dia crítico</small>
                <strong>${item.schedulePending || !item.missingTotal ? "—" : escapeHtml(formatDateLabel(item.topDate.label))}</strong>
              </div>
            </button>
          `,
        )
        .join("")
    : `
        <article class="tv-filling-row tv-filling-complete">
          <div>
            <strong>Preenchimento completo no período</strong>
            <span>Todos os setores, turnos e indicadores previstos possuem registro.</span>
          </div>
        </article>
      `;

  return `
    <section class="tv-insight-card tv-filling-analysis">
      <div class="tv-card-heading">
        <p class="eyebrow light">Análise de preenchimento</p>
        <h3>Setores, turnos e dias sem registro</h3>
      </div>
      <div class="tv-filling-score ${tone}">
        <div>
          <span class="filling-period-line">${escapeHtml(analysis.periodLabel)} <b class="filling-pending-text">· ${formatNumber(analysis.missingTotal)} pendências</b></span>
          <strong>${analysis.coverage === null ? "—" : `${analysis.coverage}%`}</strong>
          <small>${formatNumber(analysis.completedTotal)} de ${formatNumber(analysis.expectedTotal)} registros previstos</small>
        </div>
        <button type="button" class="ghost-button pending-report-button" id="exportFillingReport">Gerar relatório de Pendências</button>
      </div>
      <div class="tv-filling-list">
        ${rows}
      </div>
      ${analysis.pendingSchedules ? '<p class="filling-note">Apuração parcial: os setores 12x36 aguardam a data de referência dos turnos e a regra semanal por turno ou setor.</p>' : ""}
    </section>
  `;
}

function updateTvClock() {
  const clock = qs("#tvClock");
  if (!clock) return;
  const time = new Date().toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  clock.innerHTML = `${renderTvIcon("clock")}<span>Atualizado ${time}</span>`;
}

function renderTv() {
  const { summary, sectors, alerts, executiveReadings, fillingAnalysis } = buildTvDashboardData();
  const orderedSectors = [...sectors].sort((left, right) => left.rank - right.rank);
  const summaryCards = [
    {
      title: "Total de Indicadores",
      value: summary.totalIndicators,
      tone: "neutral",
      icon: "clipboard",
    },
    {
      title: "Total na Meta",
      value: summary.onTarget,
      tone: "success",
      icon: "target",
    },
    {
      title: "Total em Atenção",
      value: summary.attention,
      tone: "warn",
      icon: "alert",
    },
    {
      title: "Total Críticos",
      value: summary.critical,
      tone: "danger",
      icon: "alert",
    },
  ];

  qs("#tvSummary").innerHTML = `
    <section class="tv-summary-section">
      <div class="tv-summary-grid">
        ${summaryCards.map(renderTvSummaryCard).join("")}
        ${renderTvHealthGauge(summary)}
      </div>
    </section>
  `;

  qs("#tvCards").innerHTML = `
    <section class="tv-main-layout">
      <div class="tv-sector-area">
        <div class="tv-section-title">
          <p class="eyebrow light">Desempenho por setor</p>
          <h3>Principais indicadores</h3>
        </div>
        <div class="tv-sector-grid">
          ${orderedSectors.map(renderTvSectorCard).join("")}
        </div>
      </div>
      ${renderTvPriorityAlertsTable(alerts)}
    </section>
    <section class="tv-insight-grid">
      ${renderTvExecutiveReadings(executiveReadings)}
      ${renderTvFillingAnalysis(fillingAnalysis)}
    </section>
  `;

  syncTvPriorityAlertsViewport();
  updateTvClock();
  qs("#exportFillingReport")?.addEventListener("click", () => exportFillingReport(true));
  document.querySelectorAll("[data-filling-department]").forEach((button) => {
    button.addEventListener("click", () => openFillingDetails(button.dataset.fillingDepartment));
  });
}

function getPendingReportDepartments(analysis, allDepartments = false) {
  if (!currentUser) return [];
  if (isManagement() && allDepartments) return analysis.departments;
  const key = isManagement() ? selectedDepartmentKey : currentUser.departmentKey;
  return analysis.departments.filter((department) => department.departmentKey === key);
}

let pendingReportExportActive = false;

async function exportFillingReport(allDepartments = false) {
  if (!currentUser || pendingReportExportActive) return;
  pendingReportExportActive = true;
  try {
    if (remotePersistenceActive()) {
      const refreshed = await refreshSupabaseStateFromRemote({ reason: "pending-report", showToast: true });
      if (!refreshed) return;
    }
    const analysis = getTvFillingAnalysis();
    const reportDepartments = getPendingReportDepartments(analysis, allDepartments);
    if (!reportDepartments.length) {
      showToast("Nenhum setor disponível para o relatório.", "warn");
      return;
    }
    const { createFillingWorkbook } = await import("./filling-report.js");
    const workbook = createFillingWorkbook(analysis, reportDepartments);
    const buffer = await workbook.xlsx.writeBuffer();
    const scope = reportDepartments.length === 1 ? reportDepartments[0].departmentKey : "todos-setores";
    downloadBlob(`pendencias-${scope}-${getExportFileStamp(new Date())}.xlsx`, buffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    showToast("Relatório de pendências gerado.");
  } catch (error) {
    console.error("Falha ao gerar relatório de pendências", error);
    showToast("Não foi possível gerar o relatório. Tente novamente.", "danger");
  } finally {
    pendingReportExportActive = false;
  }
}

function confirmDepartmentPendingReport() {
  if (!currentUser || qs("#pendingReportConfirmation")) return;
  const dialog = document.createElement("dialog");
  dialog.id = "pendingReportConfirmation";
  dialog.className = "filling-dialog pending-report-confirmation";
  dialog.setAttribute("aria-labelledby", "pendingReportQuestion");
  dialog.innerHTML = `<h2 id="pendingReportQuestion">Deseja gerar relatório com as pendências de Preenchimento em Excel?</h2>
    <div class="pending-report-actions"><button type="button" class="ghost-button" data-no autofocus>Não</button>
    <button type="button" class="primary-button" data-yes>Sim</button></div>`;
  dialog.querySelector("[data-no]").addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-yes]").addEventListener("click", () => {
    dialog.close();
    exportFillingReport(false);
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

async function openFillingDetails(departmentKey) {
  if (remotePersistenceActive()) {
    const refreshed = await refreshSupabaseStateFromRemote({ reason: "pending-details", showToast: true });
    if (!refreshed) return;
  }
  const analysis = getTvFillingAnalysis();
  const item = analysis.departments.find((department) => department.departmentKey === departmentKey);
  if (!item) return;
  qs("#fillingDetails")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "fillingDetails";
  dialog.className = "filling-dialog";
  dialog.setAttribute("aria-labelledby", "fillingDetailsTitle");
  const options = (values) => values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
  dialog.innerHTML = `
    <header><div><h2 id="fillingDetailsTitle">${escapeHtml(item.department)}</h2><p>${escapeHtml(analysis.periodLabel)}</p></div><button type="button" data-close aria-label="Fechar" title="Fechar">&times;</button></header>
    ${item.schedulePending ? '<p>Falta definir uma data trabalhada por cada equipe A, B, C e D para alternar trabalho e folga na escala 12x36. A cobrança semanal do Kanban também depende da definição por turno ou por setor.</p>' : ""}
    <div class="filling-filters">
      <label>Indicador<select data-filter="indicator"><option value="">Todos</option>${options([...new Set(item.missing.map((row) => row.indicator))])}</select></label>
      <label>Turno<select data-filter="shift"><option value="">Todos</option>${options([...new Set(item.missing.map((row) => row.shift))])}</select></label>
      <label>Frequência<select data-filter="frequency"><option value="">Todas</option><option>Diário</option><option>Semanal</option><option>Mensal</option></select></label>
      <label>De<input type="date" data-filter="from"></label><label>Até<input type="date" data-filter="to"></label>
    </div>
    <p data-count aria-live="polite"></p>
    <div class="filling-table"><table><thead><tr><th>Indicador</th><th>Dia / semana</th><th>Turno</th><th>Frequência</th></tr></thead><tbody></tbody></table></div>`;
  const renderRows = () => {
    const filters = Object.fromEntries([...dialog.querySelectorAll("[data-filter]")].map((input) => [input.dataset.filter, input.value]));
    const rows = item.missing.filter((row) =>
      (!filters.indicator || row.indicator === filters.indicator) &&
      (!filters.shift || row.shift === filters.shift) &&
      (!filters.frequency || row.frequency === filters.frequency) &&
      (!filters.from || row.date >= filters.from) && (!filters.to || row.date <= filters.to));
    dialog.querySelector("[data-count]").textContent = item.schedulePending ? "Apuração aguardando escala." : `${rows.length} pendências`;
    dialog.querySelector("tbody").innerHTML = rows.length ? rows.map((row) => {
      const periodLabel = row.frequency === "Semanal"
        ? "Semana de " + escapeHtml(formatDateLabel(row.periodKey))
        : row.frequency === "Mensal"
          ? "Mês de " + escapeHtml(new Date(row.periodKey + "T12:00:00").toLocaleDateString("pt-BR", { month: "long", year: "numeric" }))
          : escapeHtml(formatDateLabel(row.date));
      return `<tr><td>${escapeHtml(row.indicator)}</td><td>${periodLabel}</td><td>${escapeHtml(row.shift)}</td><td>${escapeHtml(row.frequency)}</td></tr>`;
    }).join("") : `<tr><td colspan="4">${item.schedulePending ? "Escala ainda não configurada." : "Nenhuma pendência para os filtros selecionados."}</td></tr>`;
  };
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.querySelectorAll("[data-filter]").forEach((input) => input.addEventListener("change", renderRows));
  document.body.append(dialog);
  renderRows();
  dialog.showModal();
}

function formatExportDateTime(date = new Date()) {
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getExportFileStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join("");
}

function renderExportTable(headers, rows) {
  const emptyRow = `<tr><td colspan="${headers.length}">Sem dados para o período selecionado.</td></tr>`;
  return `
    <table>
      <thead>
        <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${
          rows.length
            ? rows
                .map(
                  (row) => `
                    <tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>
                  `,
                )
                .join("")
            : emptyRow
        }
      </tbody>
    </table>
  `;
}

const launchReportFieldLabels = {
  dailyAccuracy: "Acuracidade diária Kaizen (%)",
  countedSkusDay: "SKUs contados",
  correctItems: "Itens corretos",
  inventoriedItems: "Itens inventariados",
  totalCountedItems: "Itens contados",
  accountingStock: "Estoque contábil",
  wmsStock: "Estoque WMS",
  divergentSkus: "SKUs divergentes",
  totalSkus: "Total de SKUs",
  totalItemsStock: "Itens em estoque",
  obsoleteItems: "Itens obsoletos",
  dailyReceipts: "Recebimentos do dia",
  plannedReceiptCapacity: "Capacidade planejada",
  onTimeSupplierDeliveries: "Entregas no prazo",
  scheduledSupplierDeliveries: "Entregas programadas",
  completedReceiptsOnTime: "Recebimentos no prazo",
  totalReceipts: "Total de recebimentos",
  releaseTotalHours: "Tempo total",
  releasedReceipts: "Recebimentos",
  readdressedMaterials: "Materiais reendereçados",
  totalStoredMaterials: "Materiais armazenados",
  missingItems: "Itens em falta",
  criticalItems: "Itens críticos",
  zeroStockMaintenanceItems: "Itens com estoque zerado",
  stockableMaintenanceItems: "Materiais estocáveis",
  itemsAboveMinimum: "Itens acima do mínimo",
  countedSkusPeriod: "SKUs contados",
  replenishmentSkus: "SKUs de reposição",
  treatedDivergencesOnTime: "Divergências tratadas",
  totalDivergences: "Total de divergências",
  slowMovingSkus: "SKUs acima de 90 dias",
  totalStockSkus: "SKUs no estoque",
  completedShiftActivities: "Atividades concluídas",
  dailyCountedSkus: "Contagens realizadas",
  collaboratorCount: "Colaboradores",
  initialStock: "Estoque inicial",
  entriesValue: "Entradas",
  outboundValue: "Saídas",
  receivedLoads: "Cargas recebidas",
  receiptHours: "Tempo de recebimento",
  receivedUnits: "Itens recebidos",
  damagedUnits: "Itens avariados",
  correctUnits: "Itens corretos",
  followUpLoads: "Cargas com follow-up em 1h",
  receivedPallets: "Volume recebido",
  palletCapacity: "Capacidade de posição",
  countedItems: "Itens contados",
  lossItems: "Perdas no estoque",
  adjustedValue: "Valor ajustado",
  totalStockValue: "Valor do estoque",
  wrongOps: "OPs com erro",
  requestedOps: "OPs solicitadas",
  expeditionErrorValue: "Sobras e faltas",
  loadedTrucks: "Carretas carregadas",
  loadingTotalMinutes: "Tempo de carregamento",
  chemSupplyOkOps: "OPs sem atraso/divergência",
  chemTotalOps: "Total de OPs",
  chemDeliveredOps: "OPs entregues",
  chemPlannedOps: "OPs previstas",
  chemReworkOps: "Retrabalhos/repesagens",
  chemSeparatedOps: "OPs separadas",
  chemKanbanOver7DaysOps: "OPs acima de 7 dias",
  chemKanbanTotalOps: "Total no Kanban",
  chemShiftDeliveredOps: "OPs entregues no turno",
  chemShiftTargetOps: "Meta do turno",
  movedItems: "Itens movimentados",
  movementErrors: "Erros de movimentação",
  damagedMovedItems: "Itens avariados",
  waitMinutes: "Tempo de espera",
};

const launchReportCurrencyFields = new Set([
  "accountingStock",
  "wmsStock",
  "initialStock",
  "entriesValue",
  "outboundValue",
  "adjustedValue",
  "totalStockValue",
  "expeditionErrorValue",
]);
const launchReportHourFields = new Set(["releaseTotalHours", "receiptHours"]);
const launchReportMinuteFields = new Set(["loadingTotalMinutes", "waitMinutes"]);

function formatLaunchReportInputValue(field, value) {
  if (!Number.isFinite(Number(value))) return String(value || "-");
  const formatted = formatNumber(Number(value));
  if (launchReportCurrencyFields.has(field)) return `R$ ${formatted}`;
  if (launchReportHourFields.has(field)) return `${formatted} h`;
  if (launchReportMinuteFields.has(field)) return `${formatted} min`;
  if (field === "receivedPallets" || field === "palletCapacity") return `${formatted} paletes`;
  return formatted;
}

function getManagementLaunchInputEntries(launch, departmentKey, numericValue) {
  const formulaType = getLaunchFormulaTypeForDepartment(departmentKey, launch.indicator);
  const definition = formulaType ? launchFormulaDefinitions[formulaType] : null;
  const payload = launch.formulaData && typeof launch.formulaData === "object" ? launch.formulaData : {};
  const fields = formulaType === "acuracidade_uso_consumo" && payload.dailyAccuracy === undefined
    ? ["correctItems", "totalCountedItems"]
    : (definition?.fields || []);
  const entries = fields
    .filter((field) => Number.isFinite(Number(payload[field])))
    .map((field) => ({
      field,
      label: launchReportFieldLabels[field] || field,
      value: Number(payload[field]),
    }));

  if (entries.length) return entries;
  return Number.isFinite(numericValue)
    ? [{ field: "reportedValue", label: "Valor informado", value: numericValue }]
    : [];
}

function summarizeManagementLaunchInputs(launches, departmentKey, indicator) {
  const totals = new Map();
  launches.forEach((launch) => {
    const numericValue = getLaunchNumericValue(launch, indicator);
    getManagementLaunchInputEntries(launch, departmentKey, numericValue).forEach((entry) => {
      if (entry.field === "dailyAccuracy") return;
      const current = totals.get(entry.field) || { ...entry, value: 0 };
      current.value += entry.value;
      totals.set(entry.field, current);
    });
  });
  return [...totals.values()];
}

function getManagementLaunchReportRows() {
  const bounds = getDateFilterBounds();
  if (!bounds) return [];
  const rows = [];

  operationalDepartmentKeys.forEach((departmentKey) => {
    const department = departments[departmentKey];
    const groupedRows = new Map();
    const indicatorOrder = new Map(
      department.indicators.map((indicator, index) => [normalizeTextKey(indicator.name), index]),
    );

    (department.launches || []).forEach((launch) => {
      const launchDate = toDateOrNull(launch.date);
      const indicator = getIndicatorByName(departmentKey, launch.indicator);
      if (!launchDate || !indicator || !isDateInsidePeriod(launchDate, bounds.startDate, bounds.endDate)) return;
      const monthKey = getMonthFilterValueFromDate(launchDate);
      const groupKey = `${normalizeTextKey(indicator.name)}|${monthKey}`;
      if (!groupedRows.has(groupKey)) groupedRows.set(groupKey, { indicator, monthKey, launches: [] });
      groupedRows.get(groupKey).launches.push(launch);
    });

    [...groupedRows.values()]
      .sort((left, right) => {
        const indicatorDifference =
          (indicatorOrder.get(normalizeTextKey(left.indicator.name)) ?? Number.MAX_SAFE_INTEGER) -
          (indicatorOrder.get(normalizeTextKey(right.indicator.name)) ?? Number.MAX_SAFE_INTEGER);
        return indicatorDifference || left.monthKey.localeCompare(right.monthKey);
      })
      .forEach(({ indicator, monthKey, launches }) => {
      launches
        .sort((left, right) => String(left.date).localeCompare(String(right.date)) || String(left.shift).localeCompare(String(right.shift), "pt-BR"))
        .forEach((launch) => {
          const numericValue = getLaunchNumericValue(launch, indicator);
          rows.push({
            type: "detail",
            departmentKey,
            department: department.label,
            indicator: indicator.name,
            date: formatDate(launch.date),
            shift: normalizeDepartmentShift(launch.shift, departmentKey),
            inputs: getManagementLaunchInputEntries(launch, departmentKey, numericValue),
            result: Number.isFinite(numericValue) ? formatMetric(indicator, numericValue) : String(launch.value || "Sem dados"),
          });
        });

      const values = launches
        .map((launch) => getLaunchNumericValue(launch, indicator))
        .filter((value) => Number.isFinite(value));
      const monthResult = values.length
        ? isSummedIndicator(indicator)
          ? values.reduce((total, value) => total + value, 0)
          : values.reduce((total, value) => total + value, 0) / values.length
        : null;
      rows.push({
        type: "summary",
        departmentKey,
        department: department.label,
        indicator: indicator.name,
        date: formatMonthFilterLabel(monthKey),
        shift: "Fechamento mensal",
        inputs: summarizeManagementLaunchInputs(launches, departmentKey, indicator),
        result: formatMetric(indicator, monthResult),
        target: formatMetric(indicator, indicator.target),
        status: getStatus(indicator, department, monthResult),
      });
    });
  });

  return rows;
}

function renderManagementLaunchTable(rows) {
  if (!rows.length) {
    return renderExportTable(["Indicador", "Data", "Turno", "Valores de entrada", "Resultado"], []);
  }
  const renderInputs = (inputs) => inputs?.length
    ? `<div class="launch-input-list">${inputs.map((entry) => `<span><b>${escapeHtml(entry.label)}:</b> ${escapeHtml(formatLaunchReportInputValue(entry.field, entry.value))}</span>`).join("")}</div>`
    : '<span class="muted">Sem entradas armazenadas</span>';
  const sections = operationalDepartmentKeys
    .map((departmentKey, index) => ({
      department: departments[departmentKey],
      tone: (index % 5) + 1,
      rows: rows.filter((row) => row.departmentKey === departmentKey),
    }))
    .filter((section) => section.rows.length);

  return `<div class="launch-report-sections">${sections.map((section) => `
    <section class="launch-department-section sector-${section.tone}">
      <table class="launch-report-table">
        <thead>
          <tr class="department-title"><th colspan="5">${escapeHtml(section.department.label)}</th></tr>
          <tr><th>Indicador</th><th>Data</th><th>Turno</th><th>Valores de entrada</th><th>Resultado</th></tr>
        </thead>
        <tbody>${section.rows.map((row) => `<tr class="${row.type === "summary" ? "monthly-result" : ""}">
          <td>${escapeHtml(row.indicator)}</td><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.shift)}</td>
          <td>${renderInputs(row.inputs)}</td><td><strong>${escapeHtml(row.result)}</strong></td>
        </tr>`).join("")}</tbody>
      </table>
    </section>
  `).join("")}</div>`;
}

function renderManagementExecutiveSummary(rows) {
  return `<div class="executive-summary-list">${rows.map(([label, title, description], index) => `
    <article class="executive-summary-card tone-${(index % 4) + 1}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(title)}</strong>
      <small>${escapeHtml(description)}</small>
    </article>
  `).join("")}</div>`;
}

function renderManagementMonthlyKanban(rows) {
  const groupedRows = new Map();
  rows.filter((row) => row.type === "summary").forEach((row) => {
    if (!groupedRows.has(row.department)) groupedRows.set(row.department, []);
    groupedRows.get(row.department).push(row);
  });

  if (!groupedRows.size) return '<p class="empty-state">Sem resultados mensais para o período selecionado.</p>';

  const orderedGroups = operationalDepartmentKeys
    .map((departmentKey) => {
      const department = departments[departmentKey];
      const indicatorOrder = new Map(department.indicators.map((indicator, index) => [normalizeTextKey(indicator.name), index]));
      const departmentRows = groupedRows.get(department.label) || [];
      departmentRows.sort((left, right) => {
        const orderDifference = (indicatorOrder.get(normalizeTextKey(left.indicator)) ?? Number.MAX_SAFE_INTEGER)
          - (indicatorOrder.get(normalizeTextKey(right.indicator)) ?? Number.MAX_SAFE_INTEGER);
        return orderDifference || String(left.date).localeCompare(String(right.date), "pt-BR");
      });
      return [department.label, departmentRows];
    })
    .filter(([, departmentRows]) => departmentRows.length);

  return `<div class="monthly-kanban">${orderedGroups.map(([department, departmentRows], index) => `
    <section class="kanban-sector sector-${(index % 5) + 1}">
      <h3>${escapeHtml(department)}</h3>
      <div class="kanban-indicators">${departmentRows.map((row) => `
        <article class="kanban-indicator status-${escapeHtml(row.status || "tracking")}">
          <span>${escapeHtml(row.indicator)}</span>
          <strong>${escapeHtml(row.result)}</strong>
          <small>${escapeHtml(row.date)} | Meta ${escapeHtml(row.target)}</small>
        </article>
      `).join("")}</div>
    </section>
  `).join("")}</div>`;
}

function getManagementExportRows(data) {
  const indicatorRows = data.sectors.flatMap((sector) => {
    const rows = sector.indicators.map((indicator) => [
      sector.rank,
      sector.name,
      indicator.name,
      indicator.accumulated,
      indicator.target,
      getStatusExecutiveLabel(indicator.status),
    ]);
    if (sector.productivity) {
      rows.push([
        sector.rank,
        sector.name,
        sector.productivity.name,
        sector.productivity.value,
        "Acompanhamento",
        "Acompanhamento",
      ]);
    }
    return rows;
  });

  const alertRows = data.alerts.map((alert, index) => [
    index + 1,
    alert.sector,
    alert.indicator,
    alert.accumulated,
    alert.target,
    getStatusExecutiveLabel(alert.status),
  ]);

  const fillingRows = data.fillingAnalysis.departments.map((item) => [
    item.department,
    item.coverage === null ? "Sem previsão" : `${item.coverage}%`,
    item.schedulePending ? "—" : item.completedTotal,
    item.schedulePending ? "—" : item.expectedTotal,
    item.schedulePending ? "—" : item.missingTotal,
    item.topShift.label,
    item.schedulePending || !item.missingTotal ? "—" : formatDateLabel(item.topDate.label),
  ]);

  const readingRows = data.executiveReadings.map((reading) => [
    reading.label,
    reading.title,
    reading.description,
  ]);

  return { indicatorRows, alertRows, fillingRows, readingRows };
}

function buildManagementExportHtml(data) {
  const { indicatorRows, alertRows, fillingRows, readingRows } = getManagementExportRows(data);
  const launchRows = getManagementLaunchReportRows();
  const summaryRows = [
    ["Total de Indicadores", data.summary.totalIndicators],
    ["Total na Meta", data.summary.onTarget],
    ["Total em Atenção", data.summary.attention],
    ["Total Críticos", data.summary.critical],
    ["Saúde Operacional Geral", data.summary.health === null ? "Sem dados" : `${data.summary.health}%`],
  ];

  return `<!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8" />
        <title>Painel de Gestão - ${escapeHtml(data.periodLabel)}</title>
        <style>
          body {
            margin: 24px;
            color: #101820;
            background: #ffffff;
            font-family: Arial, sans-serif;
          }
          .report-header { padding: 22px 24px; color: #fff; background: #0b2341; border-bottom: 6px solid #16b8a6; }
          .report-header h1 { margin: 0 0 6px; font-size: 30px; }
          .report-header p { margin: 0; color: #dbeafe; }
          h2 { margin: 24px 0 10px; padding-left: 10px; color: #0b2341; border-left: 5px solid #16b8a6; font-size: 18px; }
          p { margin: 0 0 18px; color: #4d5b6a; }
          .summary-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin: 18px 0 8px; }
          .summary-card { padding: 12px; color: #fff; background: #17456f; border-radius: 4px; }
          .summary-card:nth-child(2) { background: #087f68; }
          .summary-card:nth-child(3) { background: #b77900; }
          .summary-card:nth-child(4), .summary-card:nth-child(5) { background: #b73546; }
          .summary-card span { display: block; font-size: 9px; text-transform: uppercase; }
          .summary-card strong { display: block; margin-top: 4px; font-size: 22px; }
          .executive-summary-list { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
          .executive-summary-card { display: grid; gap: 3px; padding: 10px 12px; border: 1px solid #cfd8e3; border-left: 6px solid #17456f; background: #f8fafc; }
          .executive-summary-card.tone-1 { border-left-color: #0c9f82; }
          .executive-summary-card.tone-2 { border-left-color: #e14d5a; }
          .executive-summary-card.tone-3 { border-left-color: #e29a12; }
          .executive-summary-card.tone-4 { border-left-color: #7357d8; }
          .executive-summary-card span { color: #526275; font-size: 9px; text-transform: uppercase; }
          .executive-summary-card strong { color: #0b2341; font-size: 13px; }
          .executive-summary-card small { color: #526275; font-size: 9px; }
          .monthly-kanban { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 7px; align-items: start; }
          .kanban-sector { overflow: hidden; border: 1px solid #b8c8da; border-top: 5px solid #1d75bd; background: #eef4fa; }
          .kanban-sector.sector-2 { border-top-color: #0c9f82; }
          .kanban-sector.sector-3 { border-top-color: #e29a12; }
          .kanban-sector.sector-4 { border-top-color: #7357d8; }
          .kanban-sector.sector-5 { border-top-color: #e14d5a; }
          .kanban-sector h3 { min-height: 30px; margin: 0; padding: 8px; color: #fff; background: #0f2742; font-size: 11px; }
          .kanban-indicators { display: grid; gap: 5px; padding: 6px; }
          .kanban-indicator { display: grid; gap: 2px; padding: 6px; border-left: 4px solid #60758d; background: #fff; }
          .kanban-indicator.status-success { border-left-color: #0c9f82; }
          .kanban-indicator.status-warn { border-left-color: #e29a12; }
          .kanban-indicator.status-danger { border-left-color: #e14d5a; }
          .kanban-indicator span { min-height: 22px; color: #26384b; font-size: 8px; font-weight: 700; }
          .kanban-indicator strong { color: #0b2341; font-size: 13px; }
          .kanban-indicator small { color: #60758d; font-size: 7px; }
          .empty-state { padding: 14px; border: 1px solid #d8e0e9; background: #f8fafc; }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 18px;
            font-size: 11px;
          }
          th {
            color: #ffffff;
            background: #0f2742;
            text-align: left;
          }
          th,
          td {
            padding: 8px;
            border: 1px solid #cfd8e3;
            vertical-align: top;
          }
          tr:nth-child(even) td { background: #f5f7fb; }
          .launch-report-sections { display: grid; gap: 16px; }
          .launch-department-section { border-top: 5px solid #1d75bd; break-before: auto; }
          .launch-department-section.sector-2 { border-top-color: #0c9f82; }
          .launch-department-section.sector-3 { border-top-color: #e29a12; }
          .launch-department-section.sector-4 { border-top-color: #7357d8; }
          .launch-department-section.sector-5 { border-top-color: #e14d5a; }
          .launch-department-section table { margin-bottom: 0; }
          .launch-report-table thead { display: table-header-group; }
          .launch-report-table .department-title th { padding: 10px 11px; color: #fff; background: #0f2742; font-size: 14px; }
          .launch-report-table th:nth-child(1) { width: 27%; }
          .launch-report-table th:nth-child(2) { width: 11%; }
          .launch-report-table th:nth-child(3) { width: 11%; }
          .launch-report-table th:nth-child(4) { width: 38%; }
          .launch-report-table th:nth-child(5) { width: 13%; }
          .launch-input-list { display: flex; flex-wrap: wrap; gap: 3px 10px; }
          .launch-input-list span { display: inline-block; white-space: nowrap; }
          .launch-input-list b { color: #40556d; }
          .muted { color: #738196; font-style: italic; }
          .launch-report-table .monthly-result td { color: #083b35; background: #d9f3ed !important; border-top: 2px solid #16a085; font-weight: 700; }
          @media print {
            @page { size: landscape; margin: 10mm; }
            body { margin: 14mm; }
            .report-header { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
            .summary-card, .executive-summary-card, .kanban-sector, .kanban-sector h3, .kanban-indicator, th, .launch-report-table .monthly-result td { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
            h2 { break-after: avoid; }
            table { break-inside: auto; }
            tr { break-inside: avoid; }
            .executive-summary-card, .kanban-sector, .kanban-indicator { break-inside: avoid; }
          }
        </style>
      </head>
      <body>
        <header class="report-header"><h1>Panorama Operacional</h1>
          <p>Relatório gerencial | Período: ${escapeHtml(data.periodLabel)} | Gerado em ${escapeHtml(formatExportDateTime(data.generatedAt))}</p>
        </header>
        <div class="summary-grid">${summaryRows.map(([label, value]) => `<div class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>
        <h2>Resumo gerencial</h2>
        ${renderManagementExecutiveSummary(readingRows)}
        <h2>Resultados mensais por setor</h2>
        ${renderManagementMonthlyKanban(launchRows)}
        <h2>Lançamentos e resultados mensais</h2>
        ${renderManagementLaunchTable(launchRows)}
        <h2>Principais indicadores por setor</h2>
        ${renderExportTable(["Ordem", "Setor", "Indicador", "Acumulado", "Meta", "Status"], indicatorRows)}
        <h2>Alertas prioritários</h2>
        ${renderExportTable(["Ranking", "Setor", "Indicador", "Acumulado", "Meta", "Status"], alertRows)}
        <h2>Análise de preenchimento</h2>
        ${renderExportTable(["Setor", "Cobertura", "Realizados", "Previstos", "Pendências", "Turno mais pendente", "Dia crítico"], fillingRows)}
      </body>
    </html>`;
}

function downloadBlob(fileName, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

function exportManagementPdf() {
  const data = buildTvDashboardData();
  const popup = window.open("", "_blank", "width=1200,height=900");
  if (!popup) {
    showToast("Não foi possível abrir o PDF. Libere pop-ups para exportar.", "warn");
    return;
  }

  popup.document.open();
  popup.document.write(buildManagementExportHtml(data));
  popup.document.close();
  window.setTimeout(() => {
    popup.focus();
    popup.print();
  }, 250);
  showToast("PDF preparado para impressão.");
}

function exportManagementExcel() {
  const data = buildTvDashboardData();
  const stamp = getExportFileStamp(data.generatedAt);
  const periodSlug = normalizeTextKey(data.periodLabel).replace(/[^a-z0-9]+/g, "-") || "periodo";
  const fileName = `painel-gestao-${periodSlug}-${stamp}.xls`;
  downloadBlob(fileName, `\ufeff${buildManagementExportHtml(data)}`, "application/vnd.ms-excel;charset=utf-8");
  showToast("Excel gerado.");
}

function renderCurrentView() {
  if (currentView === "dashboard") {
    renderSummary();
    renderKpis();
    renderLineCharts();
    return;
  }
  if (currentView === "launches") {
    renderLaunches();
    renderLaunchTable();
    return;
  }
  if (currentView === "actions") {
    renderActions();
    return;
  }
  if (currentView === "treatments") {
    renderManagementTreatments();
    return;
  }
  if (currentView === "fiveS") {
    renderFiveS();
    return;
  }
  if (currentView === "tv") renderTv();
}

function renderAll() {
  if (!isManagement() && currentUser) {
    selectedDepartmentKey = currentUser.departmentKey;
  }
  renderNavigation();
  populateDepartmentSelect();
  renderUser();
  renderIndicatorOptions();
  syncLaunchShiftOptions();
  renderCurrentView();
}

function applyPeriodFilter(nextPeriod, options = {}) {
  if (!currentUser) return;

  const showFeedback = options.showFeedback !== false;
  const normalizedPeriod = Object.prototype.hasOwnProperty.call(periodWindows, nextPeriod) ? nextPeriod : "semana";

  currentPeriod = normalizedPeriod;

  if (currentPeriod === "mes") {
    ensureSelectedMonthFilter();
  }
  if (currentPeriod === "trimestre") {
    ensureSelectedQuarterFilter();
  }

  const periodSelect = qs("#periodSelect");
  if (periodSelect && periodSelect.value !== normalizedPeriod) {
    periodSelect.value = normalizedPeriod;
  }
  syncMonthFilterControl();

  renderAll();

  if (showFeedback && periodSelect) {
    showToast(`Período alterado para ${getActivePeriodLabel()}.`);
  }
}

function setSidebarOpen(nextOpen) {
  const sidebar = qs("#sidebar");
  const menuButton = qs("#menuButton");
  if (!sidebar || !menuButton) return;
  sidebar.classList.toggle("open", nextOpen);
  menuButton.setAttribute("aria-expanded", String(nextOpen));
  menuButton.setAttribute("aria-label", nextOpen ? "Fechar menu" : "Abrir menu");
}

function setView(view) {
  if (!currentUser) return;
  if (view === "analyses") view = "dashboard";
  if (!isManagement() && (view === "tv" || view === "treatments")) return;
  if (view === "fiveS") return;
  if (isManagement() && (view === "launches" || view === "actions")) view = "dashboard";

  const previousView = currentView;
  currentView = view;
  qsa("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === view);
  });
  qsa(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });

  const label = qs(`.nav-item[data-view="${view}"]`)?.textContent.trim() || "Painel Geral";
  qs("#viewTitle").textContent = label;
  renderNavigation();
  renderUser();
  setSidebarOpen(false);
  if (view !== previousView) renderCurrentView();
}

function showToast(message, tone = "") {
  const toast = qs("#toast");
  const normalizedTone =
    tone ||
    (String(message).startsWith("Falha") || String(message).startsWith("Não foi possível") ? "danger" : "success");

  toast.textContent = message;
  toast.classList.remove("show", "success", "warn", "danger");
  toast.classList.add(normalizedTone);
  window.clearTimeout(showToast.hideTimer);
  window.requestAnimationFrame(() => toast.classList.add("show"));
  const displayDuration = normalizedTone === "danger" ? 8000 : normalizedTone === "warn" ? 5000 : 2600;
  showToast.hideTimer = window.setTimeout(() => toast.classList.remove("show"), displayDuration);
}

function setDefaultDates() {
  const launchDateInput = qs('#launchForm input[name="date"]');
  if (launchDateInput && !launchDateInput.value) {
    launchDateInput.valueAsDate = new Date();
  }

  const actionRecordDateInput = qs('#actionForm input[name="recordDate"]');
  if (actionRecordDateInput && !actionRecordDateInput.value) {
    actionRecordDateInput.valueAsDate = new Date();
  }

  const ownerInput = qs('input[name="owner"]');
  if (currentUser && ownerInput && !ownerInput.value) {
    ownerInput.value = currentUser.label;
  }

  const fiveSAuditDateInput = qs("#fiveSAuditDate");
  if (fiveSAuditDateInput && !fiveSAuditDateInput.value) {
    fiveSAuditDateInput.value = fiveSAuditDate || getTodayInputDate();
  }
}

function setupLogin() {
  qs("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const sector = String(data.get("sector"));
    const rawPassword = String(data.get("password")).trim();
    const password = rawPassword.toUpperCase();
    const profile = accessProfiles.find((candidate) => candidate.key === sector);

    if (!profile || (!useSupabasePersistence && profile.password !== password)) {
      qs("#loginError").textContent = "Setor ou senha inválidos.";
      return;
    }

    if (useSupabasePersistence) {
      try {
        await signInSupabaseProfile(profile, password);
      } catch (error) {
        console.error("Falha no login Supabase.", error);
        qs("#loginError").textContent = "Setor ou senha inválidos no ambiente online.";
        return;
      }
    }

    currentUser = profile;
    selectedDepartmentKey = profile.departmentKey;
    currentPeriod = "semana";
    selectedMonthFilter = "";
    selectedQuarterFilter = "";
    qs("#loginError").textContent = "";
    qs("#loginScreen").classList.add("hidden");
    qs("#appShell").classList.remove("hidden");
    qs("#periodSelect").value = currentPeriod;
    ensureLaunchIds();
    ensureRecordMetadata();
    rememberBaselineRecords();
    restorePrototypeState();

    if (remotePersistenceActive()) {
      try {
        await loadSupabaseState();
        startSupabaseRealtimeSync();
      } catch (error) {
        console.error("Não foi possível carregar a base SQL.", error);
        signOutSupabaseProfile();
        currentUser = null;
        qs("#loginScreen").classList.remove("hidden");
        qs("#appShell").classList.add("hidden");
        qs("#loginError").textContent = "Não foi possível carregar a base SQL. Tente novamente.";
        return;
      }
    }

    resetColumnFilters();
    renderAll();
    resetLaunchFormState();
    resetActionFormState();
    setDefaultDates();
    setSidebarOpen(false);
    setView("dashboard");
    showToast(`Acesso liberado: ${profile.label}.`);
  });
}

function setupInteractions() {
  document.addEventListener(
    "click",
    (event) => {
      const viewButton = event.target.closest(".nav-item[data-view]");
      if (!viewButton) return;
      event.preventDefault();
      setView(viewButton.dataset.view);
    },
    true,
  );

  qsa(".nav-item").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  qs("#menuButton").addEventListener("click", () => {
    const sidebar = qs("#sidebar");
    if (!sidebar) return;
    setSidebarOpen(!sidebar.classList.contains("open"));
  });

  qs(".main").addEventListener("click", (event) => {
    if (!event.target.closest("#menuButton")) {
      setSidebarOpen(false);
    }
  });

  qs("#logoutButton").addEventListener("click", () => {
    signOutSupabaseProfile();
    currentUser = null;
    selectedDepartmentKey = "almoxarifado";
    currentPeriod = "semana";
    selectedMonthFilter = "";
    selectedQuarterFilter = "";
    resetLaunchFormState();
    resetColumnFilters();
    qs("#loginForm").reset();
    qs("#periodSelect").value = currentPeriod;
    qs("#appShell").classList.add("hidden");
    qs("#loginScreen").classList.remove("hidden");
    setSidebarOpen(false);
    setView("dashboard");
  });

  qs("#refreshButton").addEventListener("click", async () => {
    if (remotePersistenceActive()) {
      const refreshed = await refreshSupabaseStateFromRemote({ reason: "manual", showToast: true });
      if (!refreshed) {
        return;
      }
    }
    renderAll();
    showToast(currentView === "tv" ? "TV atualizada." : "Painel atualizado.");
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && remotePersistenceActive()) refreshSupabaseStateIncrementally();
  });
  window.addEventListener("focus", () => {
    if (remotePersistenceActive()) refreshSupabaseStateIncrementally();
  });
  window.addEventListener("online", () => {
    if (remotePersistenceActive()) refreshSupabaseStateIncrementally();
  });

  qs("#exportPdfButton")?.addEventListener("click", exportManagementPdf);
  qs("#departmentPendingReportButton")?.addEventListener("click", confirmDepartmentPendingReport);
  qs("#launchHistorySearch")?.addEventListener("input", () => {
    renderLaunches();
    qs("#activityList").scrollTop = 0;
  });

  const periodSelect = qs("#periodSelect");
  const onPeriodChange = (event) => {
    const nextPeriod = event.target.value;
    applyPeriodFilter(nextPeriod);
  };
  periodSelect.addEventListener("change", onPeriodChange);
  periodSelect.addEventListener("input", onPeriodChange);

  const monthFilter = qs("#monthFilter");
  const quarterFilter = qs("#quarterFilter");
  const yearFilter = qs("#yearFilter");
  const onMonthFilterChange = () => {
    if (!setSelectedMonthFilterFromControls()) return;

    currentPeriod = "mes";
    periodSelect.value = currentPeriod;
    syncMonthFilterControl();
    renderAll();
    showToast(`Mês alterado para ${formatMonthFilterLabel(selectedMonthFilter)}.`);
  };
  monthFilter?.addEventListener("change", onMonthFilterChange);
  const onQuarterFilterChange = () => {
    if (!setSelectedQuarterFilterFromControls()) return;

    currentPeriod = "trimestre";
    periodSelect.value = currentPeriod;
    syncMonthFilterControl();
    renderAll();
    showToast(`Trimestre alterado para ${formatQuarterFilterLabel(selectedQuarterFilter)}.`);
  };
  quarterFilter?.addEventListener("change", onQuarterFilterChange);
  yearFilter?.addEventListener("change", () => {
    if (currentPeriod === "trimestre") onQuarterFilterChange();
    else onMonthFilterChange();
  });

  qs("#departmentSelect").addEventListener("change", (event) => {
    if (!isManagement()) return;
    selectedDepartmentKey = event.target.value;
    resetColumnFilters();
    renderAll();
    setView("dashboard");
    showToast(`Visualizando ${currentDepartment().label}.`);
  });

  qs("#launchIndicator").addEventListener("change", () => {
    syncLaunchFormByIndicator();
  });

  qsa("#launchFormulaFields input").forEach((input) => {
    input.addEventListener("input", () => updateLaunchResultFromFormula());
  });

  qs("#launchCancelEdit").addEventListener("click", () => {
    qs("#launchForm").reset();
    setDefaultDates();
    resetLaunchFormState();
    syncLaunchFormByIndicator();
  });

  qs("#activityList").addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-launch-action]");
    if (!actionButton) return;
    const launchId = actionButton.dataset.launchId;
    const action = actionButton.dataset.launchAction;
    if (!launchId || !action) return;
    if (action === "edit") {
      startLaunchEdit(launchId);
      return;
    }
    if (action === "delete") {
      deleteLaunch(launchId);
    }
  });

  qsa("[data-launch-filter]").forEach((input) => {
    const applyFilter = (event) => {
      const field = event.target.dataset.launchFilter;
      if (!field) return;
      launchTableFilters[field] = event.target.value;
      renderLaunchTable();
    };
    input.addEventListener("input", applyFilter);
    input.addEventListener("change", applyFilter);
  });

  qs("#launchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isManagement()) return;

    updateLaunchResultFromFormula();
    const data = new FormData(event.currentTarget);
    const indicator = currentDepartment().indicators.find((item) => item.name === data.get("indicator"));
    const value = parseLocalizedNumber(data.get("value"));
    const formulaType = getLaunchFormulaType(String(data.get("indicator")));
    const formulaPayload = extractFormulaPayload(data, formulaType);
    const wasEditing = Boolean(editingLaunchId);
    const existingLaunch = wasEditing
      ? currentDepartment().launches.find((launch) => launch.id === editingLaunchId)
      : null;

    if (!Number.isFinite(value)) {
      showToast("Preencha os campos obrigatórios para calcular o resultado.");
      return;
    }

    const launchId = editingLaunchId || generateLaunchId();
    const historyEntry = buildHistoryEntry(String(data.get("date")), value, formulaType, formulaPayload, launchId);
    const launchRecord = {
      id: launchId,
      indicator: String(data.get("indicator")),
      value: indicator ? normalizeValue(value, indicator) : String(data.get("value")),
      numericValue: value,
      shift: normalizeDepartmentShift(data.get("shift")),
      date: String(data.get("date")),
      comment: String(data.get("comment")),
      formulaData: formulaPayload,
      createdBy: existingLaunch?.createdBy || vpcSupabaseSession?.user?.id || null,
      createdAt: existingLaunch?.createdAt || null,
    };
    const duplicateLaunch = findDuplicateLaunch(launchRecord, editingLaunchId);
    if (duplicateLaunch) {
      showToast(getDuplicateLaunchWarning(launchRecord), "warn");
      return;
    }

    const submitButton = qs("#launchSubmitButton");
    setSubmitButtonBusy(submitButton, true);
    let confirmedLaunch = launchRecord;
    try {
      const remoteDuplicate = await findSupabaseDuplicateLaunch(launchRecord, editingLaunchId, selectedDepartmentKey);
      if (remoteDuplicate) {
        showToast(getDuplicateLaunchWarning(launchRecord), "warn");
        setSubmitButtonBusy(submitButton, false);
        return;
      }
      const persistedLaunch = await persistSupabaseLaunch(launchRecord, selectedDepartmentKey);
      if (persistedLaunch) confirmedLaunch = { ...launchRecord, ...persistedLaunch };
    } catch (error) {
      console.error("Não foi possível salvar o lançamento no Supabase.", error);
      showToast(error?.message || "Falha ao salvar no banco de dados.", "danger");
      setSubmitButtonBusy(submitButton, false);
      return;
    }

    if (indicator && Number.isFinite(value)) {
      indicator.value = value;
      removeHistoryByLaunchId(launchId, currentDepartment());
      const history = getIndicatorHistory(indicator, currentDepartment());
      indicator.history = [...history, historyEntry];
      sortIndicatorHistory(indicator);
      applyLaunchFormulaDetails(indicator, formulaType, formulaPayload);
      applyAlmoxarifadoLaunchFormulaDetails(indicator, formulaType, formulaPayload);
      applyRecebimentoLaunchFormulaDetails(indicator, formulaType, formulaPayload);
      applyEstoqueLaunchFormulaDetails(indicator, formulaType, formulaPayload);
      applySecosLaunchFormulaDetails(indicator, formulaType, formulaPayload);
      applyQuimicasLaunchFormulaDetails(indicator, formulaType, formulaPayload);
    }

    const launchList = currentDepartment().launches;
    const existingIndex = launchList.findIndex((launch) => launch.id === launchId);
    if (existingIndex >= 0) {
      launchList[existingIndex] = confirmedLaunch;
    } else {
      launchList.unshift(confirmedLaunch);
    }

    const activePeriodBounds = getDateFilterBounds();
    const savedLaunchDate = toDateOrNull(confirmedLaunch.date);
    const revealSavedLaunch =
      savedLaunchDate &&
      activePeriodBounds &&
      !isDateInsidePeriod(savedLaunchDate, activePeriodBounds.startDate, activePeriodBounds.endDate);
    if (revealSavedLaunch) {
      selectedMonthFilter = confirmedLaunch.date.slice(0, 7);
      currentPeriod = "mes";
    }

    writePrototypeState();
    setSubmitButtonBusy(submitButton, false);
    event.currentTarget.reset();
    setDefaultDates();
    resetLaunchFormState();
    syncLaunchFormByIndicator();
    renderAll();
    setView("launches");
    const saveMessage = wasEditing
      ? "Resultado editado."
      : remotePersistenceActive()
        ? "Resultado incluído na base SQL."
        : "Resultado incluído.";
    showToast(
      revealSavedLaunch
        ? `${saveMessage} Exibindo ${formatMonthFilterLabel(selectedMonthFilter)} para mostrar o registro.`
        : saveMessage,
      "success",
    );
  });

  qs("#actionCancelEdit").addEventListener("click", () => {
    qs("#actionForm").reset();
    setDefaultDates();
    resetActionFormState();
  });

  qs("#actionList").addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-record-action]");
    if (!actionButton) return;
    const recordId = actionButton.dataset.recordId;
    const action = actionButton.dataset.recordAction;
    if (!recordId || !action) return;
    if (action === "edit") {
      startRecordEdit(recordId);
      return;
    }
    if (action === "delete") {
      deleteRecord(recordId);
    }
  });

  document.addEventListener("click", (event) => {
    const attachmentButton = event.target.closest("[data-attachment-record-id]");
    if (attachmentButton) {
      event.preventDefault();
      openAttachmentPreview(attachmentButton.dataset.attachmentRecordId);
      return;
    }

    const closeButton = event.target.closest("[data-attachment-close]");
    const previewBackdrop = event.target.closest("[data-attachment-preview]");
    if (closeButton || (previewBackdrop && event.target === previewBackdrop)) {
      closeAttachmentPreview();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAttachmentPreview();
  });
  
  qsa("#actionTableFilters [data-action-filter]").forEach((input) => {
    const applyFilter = (event) => {
      const field = event.target.dataset.actionFilter;
      if (!field) return;
      actionTableFilters[field] = event.target.value;
      renderActionTable();
    };
    input.addEventListener("input", applyFilter);
    input.addEventListener("change", applyFilter);
  });

  qsa("[data-action-col-filter]").forEach((input) => {
    const applyFilter = (event) => {
      const field = event.target.dataset.actionColFilter;
      if (!field) return;
      actionTableFilters[field] = event.target.value;
      renderActionTable();
    };
    input.addEventListener("input", applyFilter);
    input.addEventListener("change", applyFilter);
  });

  qsa("[data-management-action-col-filter]").forEach((input) => {
    const applyFilter = (event) => {
      const field = event.target.dataset.managementActionColFilter;
      if (!field) return;
      managementActionTableFilters[field] = event.target.value;
      renderManagementTreatments();
    };
    input.addEventListener("input", applyFilter);
    input.addEventListener("change", applyFilter);
  });

  const fiveSQuestionList = qs("#fiveSQuestionList");
  qs("#fiveSAuditDate").addEventListener("change", (event) => {
    fiveSAuditDate = event.target.value || getTodayInputDate();
    writePrototypeState();
    renderFiveS();
  });

  qs("#fiveSSaveAuditButton").addEventListener("click", () => {
    saveFiveSAuditRecord();
  });

  const updateFiveSFromEvent = (event) => {
    const fieldControl = event.target.closest("[data-five-s-field]");
    if (!fieldControl) return;
    updateFiveSEntry(fieldControl.dataset.fiveSId, fieldControl.dataset.fiveSField, fieldControl.value);
  };
  fiveSQuestionList.addEventListener("change", updateFiveSFromEvent);

  qs("#actionFilterClear").addEventListener("click", () => {
    actionTableFilters = { ...actionTableFilterDefaults };
    Object.entries(actionTableFilterDefaults).forEach(([key, defaultValue]) => {
      const input = qs(`[data-action-filter="${key}"]`);
      if (!input) return;
      input.value = defaultValue;
    });
    Object.entries(actionTableFilterDefaults).forEach(([key, defaultValue]) => {
      const input = qs(`[data-action-col-filter="${key}"]`);
      if (!input) return;
      input.value = defaultValue;
    });
    renderActionTable();
  });

  qs("#actionTableBody").addEventListener("change", (event) => {
    const statusSelect = event.target.closest("[data-record-status-id]");
    if (!statusSelect) return;
    const recordId = statusSelect.dataset.recordStatusId;
    if (!recordId) return;
    updateRecordStatus(recordId, statusSelect.value);
  });

  qs("#managementActionTableBody").addEventListener("change", (event) => {
    const statusSelect = event.target.closest("[data-management-record-status-id]");
    if (!statusSelect) return;
    const recordId = statusSelect.dataset.managementRecordStatusId;
    const departmentKey = statusSelect.dataset.managementRecordDepartment;
    if (!recordId || !departmentKey) return;
    updateRecordStatus(recordId, statusSelect.value, departmentKey);
  });

  qs("#actionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isManagement()) return;

    const data = new FormData(event.currentTarget);
    const file = data.get("file");

    const wasEditing = Boolean(editingRecordId);
    const type = String(data.get("type"));
    const existingRecord = wasEditing
      ? currentDepartment().records.find((record) => record.id === editingRecordId)
      : null;
    const status = normalizeRecordStatusLabel(data.get("status"));
    const recordId = editingRecordId || generateRecordId();
    const filePayload = await buildRecordFilePayload(recordId, file, existingRecord);
    const nextRecord = {
      id: recordId,
      type,
      indicator: String(data.get("indicator")),
      owner: String(data.get("owner")),
      dueDate: String(data.get("dueDate")),
      recordDate: String(data.get("recordDate")),
      status,
      description: String(data.get("description")),
      file: filePayload.file,
      createdBy: existingRecord?.createdBy || vpcSupabaseSession?.user?.id || null,
      createdAt: existingRecord?.createdAt || null,
    };

    const submitButton = qs("#actionSubmitButton");
    setSubmitButtonBusy(submitButton, true);
    let confirmedRecord = nextRecord;
    try {
      const persistedRecord = await persistSupabaseActionRecord(nextRecord, selectedDepartmentKey);
      if (persistedRecord) confirmedRecord = { ...nextRecord, ...persistedRecord };
    } catch (error) {
      console.error("Não foi possível salvar o registro no Supabase.", error);
      showToast(error?.message || "Falha ao salvar no banco de dados.", "danger");
      setSubmitButtonBusy(submitButton, false);
      return;
    }

    const recordList = currentDepartment().records;
    const existingIndex = recordList.findIndex((record) => record.id === recordId);
    if (existingIndex >= 0) {
      recordList[existingIndex] = confirmedRecord;
    } else {
      recordList.unshift(confirmedRecord);
    }

    writePrototypeState();
    setSubmitButtonBusy(submitButton, false);
    event.currentTarget.reset();
    setDefaultDates();
    resetActionFormState();
    renderAll();
    setView("actions");
    showToast(
      wasEditing
        ? "Registro editado."
        : remotePersistenceActive()
          ? "Registro incluído na base SQL."
          : "Registro incluído.",
    );
  });
}

function boot() {
  clearLegacyPrototypeState();
  populateLogin();
  setupLogin();
  setupInteractions();
  setDefaultDates();
}

window.addEventListener("resize", () => {
  if (!currentUser) return;
  if (currentView === "dashboard") renderLineCharts();
  if (currentView === "tv") syncTvPriorityAlertsViewport();
});

window.setInterval(() => {
  if (currentUser && currentView === "tv") updateTvClock();
}, 30000);

boot();
