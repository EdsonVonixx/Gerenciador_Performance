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
const supabaseRealtimeRefreshDelayMs = 350;
const supabasePollingFallbackMs = 15000;
let vpcSupabaseRealtimeChannel = null;
let vpcSupabaseRefreshTimer = null;
let vpcSupabasePollingTimer = null;
let vpcSupabaseSessionRefreshTimer = null;
let supabaseStateReloadInFlight = false;
let supabaseStateReloadQueued = false;

const actionExtraIndicatorName = "5S Operacional";
const actionExtraIndicatorDepartments = new Set(["almoxarifado", "estoque"]);

const accessProfiles = [
  {
    key: "almoxarifado",
    label: "Almoxarifado U&C",
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
    label: "Almoxarifado U&C",
    color: "#1d6b57",
    indicators: [
      { name: "Ruptura de Material de Estocáveis (Manutenção)", unit: "%", target: 5, goal: "lower", targetLabel: "Meta" },
      { name: "Acuracidade de Estoque (Itens)", unit: "%", target: 95, goal: "higher", targetLabel: "Meta" },
      { name: "Aderência ao Estoque Mínimo", unit: "%", target: 95, goal: "higher", targetLabel: "Meta" },
      { name: "Cumprimento do Plano de Inventário", unit: "%", target: 100, goal: "higher", targetLabel: "Meta" },
      { name: "Estoque Slow Mover (Maior que 90 dias)", unit: "%", target: 10, goal: "lower", targetLabel: "Meta" },
      { name: "Produtividade Individual (Uso & Consumo)", unit: "%", target: null, goal: "tracking", statusText: "Acompanhamento" },
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
      { name: "Produtividade Individual", unit: "%", target: null, goal: "tracking", statusText: "Acompanhamento" },
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
      { name: "Índice de Perdas por Ajuste no Picks Secos", unit: "%", target: 0.05, goal: "lower", targetLabel: "Meta" },
      { name: "Índice de Ruptura de Embalagens na Produção", unit: "OPs", target: 0, goal: "lower", targetLabel: "Meta" },
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
  success: "#36d39e",
  warn: "#f1c453",
  danger: "#ff7385",
  tracking: "#7ca4ff",
  neutral: "#8292aa",
};

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

let currentUser = null;
let selectedDepartmentKey = "almoxarifado";
let currentView = "dashboard";
let currentPeriod = "semana";
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

function scheduleSupabaseSessionRefresh() {
  clearSupabaseSessionRefreshTimer();
  if (!remotePersistenceActive() || !vpcSupabaseSession?.refresh_token) return;

  const expiresAtMs = Number(vpcSupabaseSession.expires_at)
    ? Number(vpcSupabaseSession.expires_at) * 1000
    : Date.now() + Number(vpcSupabaseSession.expires_in || 3600) * 1000;
  const refreshDelayMs = Math.max(60000, expiresAtMs - Date.now() - 120000);

  vpcSupabaseSessionRefreshTimer = window.setTimeout(async () => {
    try {
      const refreshedSession = await supabaseAuthRequest("token?grant_type=refresh_token", {
        method: "POST",
        body: JSON.stringify({
          refresh_token: vpcSupabaseSession.refresh_token,
        }),
      });
      vpcSupabaseSession = refreshedSession;
      updateSupabaseRealtimeAuth();
      scheduleSupabaseSessionRefresh();
    } catch (error) {
      console.warn("Não foi possível renovar a sessão Supabase.", error);
      scheduleSupabaseSessionRefresh();
    }
  }, refreshDelayMs);
}

function getSupabaseAuthEmail(profile) {
  return `${profile.key}@${vpcSupabaseConfig.authEmailSuffix}`;
}

async function supabaseAuthRequest(path, options = {}) {
  const response = await fetch(`${vpcSupabaseConfig.url}/auth/v1/${path}`, {
    ...options,
    headers: {
      apikey: vpcSupabaseConfig.anonKey,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

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

  const response = await fetch(requestUrl, {
    method,
    headers,
    body: body === null ? null : JSON.stringify(body),
  });

  const responseText = await response.text();
  const payload = responseText ? JSON.parse(responseText) : null;

  if (!response.ok) {
    throw new Error(payload?.message || payload?.hint || "Falha na comunicação com o Supabase.");
  }

  return payload;
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
    recebimento: {
      "tempo medio de liberacao do material": "Tempo Médio de Recebimento",
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
  const formulaType = getLaunchFormulaType(launch.indicator);
  const numericValue = getLaunchNumericValue(launch, indicator);

  return {
    id: launch.id,
    department_slug: departmentKey,
    indicator_name: indicator?.name || launch.indicator,
    record_date: launch.date,
    shift: normalizeLaunchShift(launch.shift),
    value: numericValue,
    unit: indicator?.unit || "",
    formula_type: formulaType,
    formula_data: launch.formulaData || {},
    comment: launch.comment || null,
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
    shift: normalizeLaunchShift(row.shift),
    date: row.record_date,
    comment: row.comment || "",
    formulaData: row.formula_data || {},
  };
}

function actionRecordToSupabaseRow(record, departmentKey = selectedDepartmentKey) {
  const indicator = getIndicatorByName(departmentKey, record.indicator);
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
    file_name: record.file || null,
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
    file: row.file_name || "",
  };
}

function fiveSAuditRecordToSupabaseRow(record, departmentKey = selectedDepartmentKey) {
  return {
    id: record.id,
    department_slug: departmentKey,
    audit_date: record.date,
    score: Number.isFinite(record.score) ? record.score : null,
    payload: {
      ...record,
      checklistEntries: clonePlain(fiveSChecklistEntries),
    },
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

  const [launchRows, actionRows, fiveSRows] = await Promise.all([
    supabaseRestRequest(
      "vpc_launches",
      { query: "?select=*&order=record_date.desc,created_at.desc" },
    ),
    supabaseRestRequest(
      "vpc_action_records",
      { query: "?select=*&order=record_date.desc,created_at.desc" },
    ),
    supabaseRestRequest(
      "vpc_five_s_audits",
      { query: "?select=*&order=audit_date.desc,created_at.desc&limit=12" },
    ),
  ]);

  operationalDepartmentKeys.forEach((departmentKey) => resetRemoteDepartmentState(departmentKey));

  (launchRows || []).forEach((row) => {
    const department = departments[row.department_slug];
    if (!department || !getIndicatorByName(row.department_slug, row.indicator_name)) return;
    department.launches.push(supabaseRowToLaunch(row));
  });

  (actionRows || []).forEach((row) => {
    const department = departments[row.department_slug];
    if (!department) return;
    department.records.push(supabaseRowToActionRecord(row));
  });

  operationalDepartmentKeys.forEach((departmentKey) => rebuildIndicatorsFromLaunches(departmentKey));
  fiveSAuditRecords = (fiveSRows || []).map((row) => supabaseRowToFiveSAuditRecord(row));
  ensureFiveSAuditRecordsMetadata();
  ensureLaunchIds();
  ensureRecordMetadata();
  syncIdCountersFromState();
  return true;
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

function stopSupabaseRealtimeSync() {
  if (vpcSupabaseRefreshTimer) {
    window.clearTimeout(vpcSupabaseRefreshTimer);
    vpcSupabaseRefreshTimer = null;
  }

  if (vpcSupabasePollingTimer) {
    window.clearInterval(vpcSupabasePollingTimer);
    vpcSupabasePollingTimer = null;
  }

  if (vpcSupabaseClient && vpcSupabaseRealtimeChannel) {
    vpcSupabaseClient.removeChannel(vpcSupabaseRealtimeChannel);
  }
  vpcSupabaseRealtimeChannel = null;
}

function startSupabaseRealtimeSync() {
  stopSupabaseRealtimeSync();
  if (!vpcSupabaseClient || !remotePersistenceActive()) return;

  updateSupabaseRealtimeAuth();
  let channel = vpcSupabaseClient.channel(`vpc-operational-sync-${currentUser?.key || "user"}`);
  supabaseRealtimeTables.forEach((table) => {
    channel = channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table,
      },
      () => scheduleSupabaseRealtimeRefresh(`realtime:${table}`),
    );
  });

  vpcSupabaseRealtimeChannel = channel.subscribe((status, error) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.warn("Canal Realtime indisponível, mantendo polling reserva.", error);
    }
  });

  vpcSupabasePollingTimer = window.setInterval(() => {
    refreshSupabaseStateFromRemote({ reason: "polling" });
  }, supabasePollingFallbackMs);
}

async function persistSupabaseLaunch(launch, departmentKey = selectedDepartmentKey) {
  if (!remotePersistenceActive()) return false;
  await supabaseRestRequest("vpc_launches?on_conflict=id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: launchToSupabaseRow(launch, departmentKey),
  });
  return true;
}

async function deleteSupabaseLaunch(launchId) {
  if (!remotePersistenceActive()) return false;
  await supabaseRestRequest("vpc_launches", {
    method: "DELETE",
    query: `?id=eq.${encodeSupabaseFilterValue(launchId)}`,
    prefer: "return=minimal",
  });
  return true;
}

async function persistSupabaseActionRecord(record, departmentKey = selectedDepartmentKey) {
  if (!remotePersistenceActive()) return false;
  await supabaseRestRequest("vpc_action_records?on_conflict=id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: actionRecordToSupabaseRow(record, departmentKey),
  });
  return true;
}

async function patchSupabaseActionRecord(recordId, patch) {
  if (!remotePersistenceActive()) return false;
  await supabaseRestRequest("vpc_action_records", {
    method: "PATCH",
    query: `?id=eq.${encodeSupabaseFilterValue(recordId)}`,
    prefer: "return=minimal",
    body: patch,
  });
  return true;
}

async function deleteSupabaseActionRecord(recordId) {
  if (!remotePersistenceActive()) return false;
  await supabaseRestRequest("vpc_action_records", {
    method: "DELETE",
    query: `?id=eq.${encodeSupabaseFilterValue(recordId)}`,
    prefer: "return=minimal",
  });
  return true;
}

async function persistSupabaseFiveSAuditRecord(record, departmentKey = selectedDepartmentKey) {
  if (!remotePersistenceActive()) return false;
  await supabaseRestRequest("vpc_five_s_audits?on_conflict=department_slug,audit_date", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: fiveSAuditRecordToSupabaseRow(record, departmentKey),
  });
  return true;
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

function getSelectedOptionLabel(selector, fallback) {
  const select = qs(selector);
  return select?.options[select.selectedIndex]?.text || fallback;
}

function getActivePeriodLabel() {
  const periodLabel = getSelectedOptionLabel("#periodSelect", "Período");
  return periodLabel;
}

function getDateFilterBounds(values = []) {
  const referenceDate = maxDateFromValues(values);
  if (!referenceDate) return null;
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
    return history.slice(-Math.min(history.length, getPeriodWindow()));
  }

  return history.filter((item) => {
    const itemDate = toDateOrNull(item.date);
    if (!itemDate) return false;
    return isDateInsidePeriod(itemDate, bounds.startDate, bounds.endDate);
  });
}

function getIndicatorAverageValue(indicator, department = currentDepartment()) {
  const filteredHistory = getFilteredHistory(indicator, department);
  if (filteredHistory.length === 0) {
    return indicator.value !== null && indicator.value !== undefined && Number.isFinite(Number(indicator.value))
      ? Number(indicator.value)
      : null;
  }
  const total = filteredHistory.reduce((acc, item) => acc + Number(item.value), 0);
  return total / filteredHistory.length;
}

function getIndicatorAccumulatedValue(indicator, department = currentDepartment()) {
  return getIndicatorAverageValue(indicator, department);
}

function getStatus(indicator, department = currentDepartment(), valueOverride = null) {
  const currentValue =
    typeof valueOverride === "number"
      ? valueOverride
      : getIndicatorAverageValue(indicator, department);

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

function formatMetric(indicator, valueOverride = null) {
  const currentValue =
    typeof valueOverride === "number" ? valueOverride : getIndicatorAverageValue(indicator);
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
        ["Horas totais", `${formatNumber(sumField(rows, "releaseTotalHours"))} h`],
        ["Total de recebimentos", formatNumber(sumField(rows, "releasedReceipts"))],
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
        ["Total de SKUs", formatNumber(sumField(rows, "totalSkus"))],
      ];
    }
  }

  if (indicatorKey.includes("indice") && indicatorKey.includes("divergencias") && indicatorKey.includes("tratadas")) {
    const rows = rowsWithFields(["treatedDivergencesOnTime", "totalDivergences"]);
    if (rows.length > 0) {
      return [
        ["Divergências tratadas", formatNumber(sumField(rows, "treatedDivergencesOnTime"))],
        ["Total de divergências", formatNumber(sumField(rows, "totalDivergences"))],
      ];
    }
  }

  if (indicatorKey.includes("estoque") && indicatorKey.includes("slow") && indicatorKey.includes("mover")) {
    const rows = rowsWithFields(["slowMovingSkus", "totalStockSkus"]);
    if (rows.length > 0) {
      return [
        ["SKUs > 90 dias", formatNumber(sumField(rows, "slowMovingSkus"))],
        ["Total de SKUs", formatNumber(sumField(rows, "totalStockSkus"))],
      ];
    }
  }

  if (indicatorKey.includes("produtividade") && indicatorKey.includes("contagens")) {
    const rows = rowsWithFields(["dailyCountedSkus", "collaboratorCount"]);
    if (rows.length > 0) {
      return [
        ["Contagens realizadas", formatNumber(sumField(rows, "dailyCountedSkus"))],
        ["Colaboradores", formatNumber(sumField(rows, "collaboratorCount"))],
      ];
    }
  }

  if (indicatorKey.includes("perdas") && indicatorKey.includes("picks")) {
    const rows = rowsWithFields(["adjustedValue", "totalStockValue"]);
    if (rows.length > 0) {
      return [
        ["Valor ajustado", `R$ ${formatNumber(sumField(rows, "adjustedValue"))}`],
        ["Valor do estoque", `R$ ${formatNumber(sumField(rows, "totalStockValue"))}`],
      ];
    }
  }

  if (indicatorKey.includes("ruptura") && indicatorKey.includes("embalagens")) {
    const rows = rowsWithFields(["impactedOps"]);
    if (rows.length > 0) {
      return [["OPs impactadas", formatNumber(sumField(rows, "impactedOps"))]];
    }
  }

  if (indicatorKey.includes("ops") && indicatorKey.includes("erradas")) {
    const rows = rowsWithFields(["wrongOps", "requestedOps"]);
    if (rows.length > 0) {
      return [
        ["OPs erradas", formatNumber(sumField(rows, "wrongOps"))],
        ["OPs solicitadas", formatNumber(sumField(rows, "requestedOps"))],
      ];
    }
  }

  if (indicatorKey.includes("erros") && indicatorKey.includes("movimentacao")) {
    const rows = rowsWithFields(["movementErrors", "movedItems"]);
    if (rows.length > 0) {
      return [
        ["Erros de movimentação", formatNumber(sumField(rows, "movementErrors"))],
        ["Itens movimentados", formatNumber(sumField(rows, "movedItems"))],
      ];
    }
  }

  if (indicatorKey.includes("erros") && indicatorKey.includes("expedicao")) {
    const rows = rowsWithFields(["expeditionErrorValue"]);
    if (rows.length > 0) {
      return [["Sobras e faltas", `R$ ${formatNumber(sumField(rows, "expeditionErrorValue"))}`]];
    }
  }

  if (indicatorKey.includes("tempo") && indicatorKey.includes("carregamento") && indicatorKey.includes("carretas")) {
    const rows = rowsWithFields(["loadedTrucks", "loadingTotalMinutes"]);
    if (rows.length > 0) {
      return [
        ["Carretas carregadas", formatNumber(sumField(rows, "loadedTrucks"))],
        ["Tempo total", `${formatNumber(sumField(rows, "loadingTotalMinutes"))} min`],
      ];
    }
  }

  if (selectedDepartmentKey === "secos" && indicatorKey.includes("produtividade") && indicatorKey.includes("individual")) {
    const rows = rowsWithFields(["completedShiftActivities", "collaboratorCount"]);
    if (rows.length > 0) {
      return [
        ["Atividades concluídas", formatNumber(sumField(rows, "completedShiftActivities"))],
        ["Colaboradores", formatNumber(sumField(rows, "collaboratorCount"))],
      ];
    }
  }

  if (selectedDepartmentKey === "quimicas" && indicatorKey.includes("confiabilidade") && indicatorKey.includes("abastecimento")) {
    const rows = rowsWithFields(["chemSupplyOkOps", "chemTotalOps"]);
    if (rows.length > 0) {
      return [
        ["OPs sem atraso/divergência", formatNumber(sumField(rows, "chemSupplyOkOps"))],
        ["Total de OPs", formatNumber(sumField(rows, "chemTotalOps"))],
      ];
    }
  }

  if (selectedDepartmentKey === "quimicas" && indicatorKey.includes("eficiencia") && indicatorKey.includes("atendimento")) {
    const rows = rowsWithFields(["chemDeliveredOps", "chemPlannedOps"]);
    if (rows.length > 0) {
      return [
        ["OPs entregues", formatNumber(sumField(rows, "chemDeliveredOps"))],
        ["OPs previstas", formatNumber(sumField(rows, "chemPlannedOps"))],
      ];
    }
  }

  if (selectedDepartmentKey === "quimicas" && indicatorKey.includes("retrabalho") && indicatorKey.includes("separacao")) {
    const rows = rowsWithFields(["chemReworkOps", "chemSeparatedOps"]);
    if (rows.length > 0) {
      return [
        ["Retrabalhos/repesagens", formatNumber(sumField(rows, "chemReworkOps"))],
        ["OPs separadas", formatNumber(sumField(rows, "chemSeparatedOps"))],
      ];
    }
  }

  if (selectedDepartmentKey === "quimicas" && indicatorKey.includes("giro") && indicatorKey.includes("kanban")) {
    const rows = rowsWithFields(["chemKanbanOver7DaysOps", "chemKanbanTotalOps"]);
    if (rows.length > 0) {
      return [
        ["OPs > 7 dias", formatNumber(sumField(rows, "chemKanbanOver7DaysOps"))],
        ["Total no Kanban", formatNumber(sumField(rows, "chemKanbanTotalOps"))],
      ];
    }
  }

  if (selectedDepartmentKey === "quimicas" && indicatorKey.includes("produtividade") && indicatorKey.includes("ops") && indicatorKey.includes("separadas")) {
    const rows = rowsWithFields(["chemShiftDeliveredOps", "chemShiftTargetOps"]);
    if (rows.length > 0) {
      return [
        ["OPs entregues no turno", formatNumber(sumField(rows, "chemShiftDeliveredOps"))],
        ["Meta do turno", formatNumber(sumField(rows, "chemShiftTargetOps"))],
      ];
    }
  }

  if (selectedDepartmentKey === "quimicas" && indicatorKey.includes("produtividade") && indicatorKey.includes("individual")) {
    const rows = rowsWithFields(["completedShiftActivities", "collaboratorCount"]);
    if (rows.length > 0) {
      return [
        ["Atividades concluídas", formatNumber(sumField(rows, "completedShiftActivities"))],
        ["Colaboradores", formatNumber(sumField(rows, "collaboratorCount"))],
      ];
    }
  }

  if (indicatorKey.includes("ruptura") && indicatorKey.includes("estocaveis")) {
    const rows = rowsWithFields(["zeroStockMaintenanceItems", "stockableMaintenanceItems"]);
    if (rows.length > 0) {
      return [
        ["Itens zerados", formatNumber(sumField(rows, "zeroStockMaintenanceItems"))],
        ["Materiais estocáveis", formatNumber(sumField(rows, "stockableMaintenanceItems"))],
      ];
    }
  }

  if (indicatorKey.includes("acuracidade") && indicatorKey.includes("estoque") && indicatorKey.includes("itens")) {
    const rows = rowsWithFields(["correctItems", "totalCountedItems"]);
    if (rows.length > 0) {
      return [
        ["Itens corretos", formatNumber(sumField(rows, "correctItems"))],
        ["Itens contados", formatNumber(sumField(rows, "totalCountedItems"))],
      ];
    }
  }

  if (indicatorKey.includes("aderencia") && indicatorKey.includes("estoque") && indicatorKey.includes("minimo")) {
    const rows = rowsWithFields(["itemsAboveMinimum", "stockableMaintenanceItems"]);
    if (rows.length > 0) {
      return [
        ["Itens acima do mínimo", formatNumber(sumField(rows, "itemsAboveMinimum"))],
        ["Materiais estocáveis", formatNumber(sumField(rows, "stockableMaintenanceItems"))],
      ];
    }
  }

  if (indicatorKey.includes("cumprimento") && indicatorKey.includes("plano") && indicatorKey.includes("inventario")) {
    const rows = rowsWithFields(["countedSkusPeriod", "replenishmentSkus"]);
    if (rows.length > 0) {
      return [
        ["SKUs contados", formatNumber(sumField(rows, "countedSkusPeriod"))],
        ["SKUs reposição", formatNumber(sumField(rows, "replenishmentSkus"))],
      ];
    }
  }

  if (indicatorKey.includes("estoque") && indicatorKey.includes("slow") && indicatorKey.includes("mover")) {
    const rows = rowsWithFields(["slowMovingSkus", "replenishmentSkus"]);
    if (rows.length > 0) {
      return [
        ["SKUs > 90 dias", formatNumber(sumField(rows, "slowMovingSkus"))],
        ["SKUs reposição", formatNumber(sumField(rows, "replenishmentSkus"))],
      ];
    }
  }

  if (indicatorKey.includes("produtividade") && indicatorKey.includes("individual")) {
    const usageRows = rowsWithFields(["completedShiftActivities", "collaboratorCount"]);
    if (usageRows.length > 0) {
      return [
        ["Atividades concluídas no turno", formatNumber(sumField(usageRows, "completedShiftActivities"))],
        ["Colaboradores", formatNumber(sumField(usageRows, "collaboratorCount"))],
      ];
    }

    const rows = rowsWithFields(["completedActivities", "totalAttendances"]);
    if (rows.length > 0) {
      const collaborators = new Set(rows.map((item) => String(item.collaboratorName || "").trim()).filter(Boolean));
      return [
        ["Atendimentos", formatNumber(sumField(rows, "totalAttendances"))],
        ["Colaboradores", formatNumber(collaborators.size)],
      ];
    }
  }

  const hasAcuracidadeCounts =
    indicator.name === "Acuracidade" &&
    history.length > 0 &&
    history.every((item) => Number.isFinite(Number(item.correctItems)) && Number.isFinite(Number(item.inventoriedItems)));

  if (hasAcuracidadeCounts) {
    const sums = history.reduce(
      (acc, item) => {
        acc.correct += Number(item.correctItems);
        acc.inventoried += Number(item.inventoriedItems);
        return acc;
      },
      { correct: 0, inventoried: 0 },
    );
    return [
      ["Itens corretos", formatNumber(sums.correct)],
      ["Itens inventariados", formatNumber(sums.inventoried)],
    ];
  }

  const hasRupturaCounts =
    indicator.name === "Ruptura" &&
    history.length > 0 &&
    history.every((item) => Number.isFinite(Number(item.missingItems)) && Number.isFinite(Number(item.criticalItems)));

  if (hasRupturaCounts) {
    const sums = history.reduce(
      (acc, item) => {
        acc.missing += Number(item.missingItems);
        acc.critical += Number(item.criticalItems);
        return acc;
      },
      { missing: 0, critical: 0 },
    );

    return [
      ["Itens em falta", formatNumber(sums.missing)],
      ["Itens críticos", formatNumber(sums.critical)],
    ];
  }

  if (indicatorKey === "tempo de recebimento" || indicatorKey === "sla de armazenagem") {
    const rowsWithLoads = history.filter((item) => Number.isFinite(Number(item.receivedLoads)));
    if (rowsWithLoads.length > 0) {
      const totalLoads = rowsWithLoads.reduce((sum, item) => sum + Number(item.receivedLoads), 0);
      return [["Carretas recebidas", formatNumber(totalLoads)]];
    }
  }

  if (indicatorKey === "avarias no recebimento") {
    const rowsWithDamage = history.filter((item) => Number.isFinite(Number(item.damagedUnits)));
    if (rowsWithDamage.length > 0) {
      const totalDamaged = rowsWithDamage.reduce((sum, item) => sum + Number(item.damagedUnits), 0);
      return [["Itens avariados", formatNumber(totalDamaged)]];
    }
  }

  if (indicatorKey === "acuracia de conferencia") {
    const rowsWithAcuraciaInputs = history.filter(
      (item) => Number.isFinite(Number(item.receivedUnits)) && Number.isFinite(Number(item.correctUnits)),
    );
    if (rowsWithAcuraciaInputs.length > 0) {
      const totals = rowsWithAcuraciaInputs.reduce(
        (acc, item) => {
          acc.received += Number(item.receivedUnits);
          acc.correct += Number(item.correctUnits);
          return acc;
        },
        { received: 0, correct: 0 },
      );
      return [
        ["Itens recebidos", formatNumber(totals.received / rowsWithAcuraciaInputs.length)],
        ["Itens corretos", formatNumber(totals.correct / rowsWithAcuraciaInputs.length)],
      ];
    }
  }

  if (indicatorKey === "giro de docas") {
    const rowsWithPallets = history.filter((item) => Number.isFinite(Number(item.receivedPallets)));
    if (rowsWithPallets.length > 0) {
      const totalPallets = rowsWithPallets.reduce((sum, item) => sum + Number(item.receivedPallets), 0);
      return [["Volume paletes recebidos", formatNumber(totalPallets)]];
    }
  }

  if (indicatorKey === "acuracidade do estoque") {
    const rowsWithInventoried = history.filter((item) => Number.isFinite(Number(item.inventoriedItems)));
    if (rowsWithInventoried.length > 0) {
      const totalInventoried = rowsWithInventoried.reduce((sum, item) => sum + Number(item.inventoriedItems), 0);
      return [["SKUs inventariados", formatNumber(totalInventoried)]];
    }
  }

  if (indicatorKey === "contabil x wms" || indicatorKey === "divergencia contabil x wms") {
    const rowsWithStocks = history.filter(
      (item) => Number.isFinite(Number(item.accountingStock)) && Number.isFinite(Number(item.wmsStock)),
    );
    if (rowsWithStocks.length > 0) {
      const sums = rowsWithStocks.reduce(
        (acc, item) => {
          acc.accounting += Number(item.accountingStock);
          acc.wms += Number(item.wmsStock);
          return acc;
        },
        { accounting: 0, wms: 0 },
      );
      return [
        ["SKU WMS", formatNumber(sums.wms / rowsWithStocks.length)],
        ["SKU Contábil", formatNumber(sums.accounting / rowsWithStocks.length)],
      ];
    }
  }

  if (indicatorKey === "material obsoleto") {
    const rowsWithObsolete = history.filter((item) => Number.isFinite(Number(item.obsoleteItems)));
    if (rowsWithObsolete.length > 0) {
      const averageObsolete =
        rowsWithObsolete.reduce((sum, item) => sum + Number(item.obsoleteItems), 0) / rowsWithObsolete.length;
      return [["Itens obsoletos", formatNumber(averageObsolete)]];
    }
  }

  if (indicatorKey === "produtividade de contagens") {
    const rowsWithCounted = history.filter((item) => Number.isFinite(Number(item.countedItems)));
    if (rowsWithCounted.length > 0) {
      const totalCounted = rowsWithCounted.reduce((sum, item) => sum + Number(item.countedItems), 0);
      return [["SKUs inventariados", formatNumber(totalCounted)]];
    }
  }

  if (indicatorKey === "perdas de inventario") {
    const rowsWithLoss = history.filter((item) => Number.isFinite(Number(item.lossItems)));
    if (rowsWithLoss.length > 0) {
      const totalLoss = rowsWithLoss.reduce((sum, item) => sum + Number(item.lossItems), 0);
      return [["Perda de estoque", formatNumber(totalLoss)]];
    }
  }

  if (!Array.isArray(indicator.details)) return [];
  return indicator.details.filter(([label]) => !/^(desvio|diferenca|diferença)/i.test(label.trim()));
}

function formatTarget(indicator) {
  if (indicator.targetDisplay) {
    return indicator.targetDisplay;
  }
  if (indicator.goal === "tracking" || indicator.target === null || indicator.target === undefined) {
    return "Acompanhamento";
  }
  const prefix = indicator.targetLabel || (indicator.goal === "higher" ? "Meta" : "Limite");
  if (indicator.unit === "R$") {
    return `${prefix} R$ ${formatNumber(indicator.target)}`;
  }
  return `${prefix} ${formatNumber(indicator.target)}${indicator.unit === "%" ? "%" : ` ${indicator.unit}`}`;
}

function formatTargetValue(indicator) {
  if (indicator.targetValueDisplay) {
    return indicator.targetValueDisplay;
  }
  if (indicator.goal === "tracking" || indicator.target === null || indicator.target === undefined) {
    return "Acompanhamento";
  }
  if (indicator.unit === "R$") {
    return `R$ ${formatNumber(indicator.target)}`;
  }
  return `${formatNumber(indicator.target)}${indicator.unit === "%" ? "%" : ` ${indicator.unit}`}`;
}

function getGoalDirectionLabel(indicator) {
  if (indicator.goal === "tracking" || indicator.target === null || indicator.target === undefined) return "Monitorar";
  return indicator.goal === "higher" ? "Maior" : "Menor";
}

function formatChartValue(indicator, value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "Sem dados";
  if (indicator.unit === "R$") return `R$ ${formatNumber(value)}`;
  if (shouldDisplayWithoutDecimalsInChart(indicator)) {
    return `${formatIntegerDisplay(value)}${indicator.unit === "%" ? "%" : ` ${indicator.unit}`}`;
  }
  return `${formatNumber(value)}${indicator.unit === "%" ? "%" : ` ${indicator.unit}`}`;
}

function normalizeValue(inputValue, indicator) {
  const value = Number(inputValue);
  if (indicator.unit === "R$") return `R$ ${formatNumber(value)}`;
  return `${formatNumber(value)}${indicator.unit === "%" ? "%" : ` ${indicator.unit}`}`;
}

function formatDate(dateString) {
  if (!dateString) return "";
  const [year, month, day] = dateString.split("-");
  return `${day}/${month}/${year}`;
}

function formatTimeLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function toDateOrNull(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function maxDateFromValues(values) {
  let max = null;
  values.forEach((value) => {
    const date = toDateOrNull(value);
    if (!date) return;
    if (!max || date > max) max = date;
  });
  return max;
}

function datePeriodStart(referenceDate, windowDays) {
  const start = new Date(referenceDate);
  start.setDate(start.getDate() - (windowDays - 1));
  return start;
}

function isDateInsidePeriod(date, start, end) {
  return date && date >= start && date <= end;
}

function generateLaunchId() {
  const id = window.crypto?.randomUUID ? `launch-${window.crypto.randomUUID()}` : `launch-${launchIdCounter}`;
  launchIdCounter += 1;
  return id;
}

function generateRecordId() {
  const id = window.crypto?.randomUUID ? `record-${window.crypto.randomUUID()}` : `record-${recordIdCounter}`;
  recordIdCounter += 1;
  return id;
}

function ensureLaunchIds() {
  operationalDepartmentKeys.forEach((departmentKey) => {
    const department = departments[departmentKey];
    department.launches = department.launches.map((launch) => ({
      ...launch,
      id: launch.id || generateLaunchId(),
      shift: normalizeLaunchShift(launch.shift),
    }));
  });
}

function ensureRecordMetadata() {
  operationalDepartmentKeys.forEach((departmentKey) => {
    const department = departments[departmentKey];
    department.records = department.records.map((record) => {
      const recordDate = record.recordDate || record.date || record.dueDate || getTodayInputDate();
      const status = normalizeRecordStatusLabel(record.status);
      return {
        ...record,
        id: record.id || generateRecordId(),
        recordDate,
        status,
      };
    });
  });
}

function syncIdCountersFromState() {
  const maxIdNumber = (items, prefix) =>
    items.reduce((maxValue, item) => {
      const match = String(item.id || "").match(new RegExp(`^${prefix}-(\\d+)$`));
      return match ? Math.max(maxValue, Number(match[1])) : maxValue;
    }, 0);

  const allLaunches = operationalDepartmentKeys.flatMap((key) => departments[key].launches || []);
  const allRecords = operationalDepartmentKeys.flatMap((key) => departments[key].records || []);
  launchIdCounter = Math.max(launchIdCounter, maxIdNumber(allLaunches, "launch") + 1);
  recordIdCounter = Math.max(recordIdCounter, maxIdNumber(allRecords, "record") + 1);
}

function rememberBaselineRecords() {
  operationalDepartmentKeys.forEach((departmentKey) => {
    if (baselineRecordsByDepartment[departmentKey]) return;
    baselineRecordsByDepartment[departmentKey] = clonePlain(departments[departmentKey].records || []);
  });
}

function getRecordMergeKey(record) {
  return [
    normalizeTextKey(record?.type),
    normalizeTextKey(record?.indicator),
    normalizeTextKey(record?.owner),
    String(record?.dueDate || ""),
    normalizeTextKey(record?.description),
  ].join("|");
}

function mergeRecordsWithBaseline(departmentKey, savedRecords) {
  const merged = clonePlain(baselineRecordsByDepartment[departmentKey] || []);
  const findMatchIndex = (record) =>
    merged.findIndex(
      (item) => (record.id && item.id === record.id) || getRecordMergeKey(item) === getRecordMergeKey(record),
    );

  savedRecords.forEach((record) => {
    const matchIndex = findMatchIndex(record);
    if (matchIndex >= 0) {
      merged[matchIndex] = { ...merged[matchIndex], ...clonePlain(record) };
      return;
    }
    merged.unshift(clonePlain(record));
  });

  return merged;
}

function restorePrototypeState() {
  const savedState = readPrototypeState();
  if (Array.isArray(savedState?.fiveSChecklistEntries)) {
    fiveSChecklistEntries = repairStoredText(clonePlain(savedState.fiveSChecklistEntries));
  }
  ensureFiveSMetadata();

  if (typeof savedState?.fiveSAuditDate === "string") {
    fiveSAuditDate = savedState.fiveSAuditDate;
  }
  if (Array.isArray(savedState?.fiveSAuditRecords)) {
    fiveSAuditRecords = repairStoredText(clonePlain(savedState.fiveSAuditRecords));
  }
  ensureFiveSAuditRecordsMetadata();

  if (!savedState?.departments) return;

  operationalDepartmentKeys.forEach((departmentKey) => {
    const department = departments[departmentKey];
    const savedDepartment = savedState.departments[departmentKey];
    if (!department || !savedDepartment) return;

    if (Array.isArray(savedDepartment.launches)) {
      const validIndicators = new Set((department.indicators || []).map((indicator) => normalizeTextKey(indicator.name)));
      department.launches = repairStoredText(clonePlain(savedDepartment.launches)).filter((launch) =>
        validIndicators.has(normalizeTextKey(launch.indicator)),
      );
    }

    if (Array.isArray(savedDepartment.records)) {
      department.records = mergeRecordsWithBaseline(departmentKey, repairStoredText(savedDepartment.records));
    }

    if (Array.isArray(savedDepartment.indicators)) {
      const savedIndicators = new Map(
        savedDepartment.indicators.map((indicator) => [normalizeTextKey(indicator.name), indicator]),
      );

      department.indicators = department.indicators.map((indicator) => {
        const savedIndicator = savedIndicators.get(normalizeTextKey(indicator.name));
        if (!savedIndicator) return indicator;

        const nextIndicator = {
          ...indicator,
          value: Number.isFinite(Number(savedIndicator.value)) ? Number(savedIndicator.value) : indicator.value,
          history: Array.isArray(savedIndicator.history) ? repairStoredText(clonePlain(savedIndicator.history)) : indicator.history,
          details: Array.isArray(savedIndicator.details) ? repairStoredText(clonePlain(savedIndicator.details)) : indicator.details,
        };
        sortIndicatorHistory(nextIndicator);
        return nextIndicator;
      });
    }
  });

  ensureLaunchIds();
  ensureRecordMetadata();
  syncIdCountersFromState();
}

function getFilteredLaunches(department = currentDepartment()) {
  if (!Array.isArray(department.launches) || department.launches.length === 0) return [];

  const bounds = getDateFilterBounds(department.launches.map((launch) => launch.date));
  if (!bounds) return department.launches;

  return department.launches
    .filter((launch) => {
      const launchDate = toDateOrNull(launch.date);
      if (!launchDate) return true;
      return isDateInsidePeriod(launchDate, bounds.startDate, bounds.endDate);
    })
    .sort((left, right) => {
      const leftDate = toDateOrNull(left.date);
      const rightDate = toDateOrNull(right.date);
      if (leftDate && rightDate) return rightDate - leftDate;
      if (rightDate) return 1;
      if (leftDate) return -1;
      return 0;
    });
}

function getRecordDate(record) {
  return record.recordDate || record.date || record.dueDate || "";
}

function getFilteredRecords(department = currentDepartment()) {
  if (!Array.isArray(department.records) || department.records.length === 0) return [];

  const bounds = getDateFilterBounds(department.records.map((record) => getRecordDate(record)));
  if (!bounds) return department.records;

  return department.records
    .filter((record) => {
      const recordDate = toDateOrNull(getRecordDate(record));
      if (!recordDate) return true;
      return isDateInsidePeriod(recordDate, bounds.startDate, bounds.endDate);
    })
    .sort((left, right) => {
      const leftDate = toDateOrNull(getRecordDate(left));
      const rightDate = toDateOrNull(getRecordDate(right));
      if (leftDate && rightDate) return rightDate - leftDate;
      if (rightDate) return 1;
      if (leftDate) return -1;
      return 0;
    });
}

function getLaunchNumericValue(launch, indicator = null) {
  if (Number.isFinite(launch.numericValue)) return Number(launch.numericValue);
  const parsed = parseLocalizedNumber(launch.value);
  if (Number.isFinite(parsed)) return parsed;
  if (indicator && Number.isFinite(indicator.value)) return Number(indicator.value);
  return NaN;
}

function normalizeTextKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueIndicatorNames(names) {
  const seen = new Set();
  return names.filter((name) => {
    const key = normalizeTextKey(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeLaunchShift(shiftValue) {
  const shiftKey = normalizeTextKey(shiftValue);
  if (shiftKey === "turno a") return "Turno A";
  if (shiftKey === "turno b") return "Turno B";
  if (shiftKey === "turno c") return "Turno C";
  if (shiftKey === "turno d") return "Turno D";
  return "Comercial";
}

function normalizeRecordStatusLabel(statusValue) {
  const statusKey = normalizeTextKey(statusValue);
  if (statusKey === "concluido" || statusKey === "concluida") return "Concluída";
  return "Em andamento";
}

function isRecordConcluded(record) {
  return normalizeRecordStatusLabel(record?.status) === "Concluída";
}

function textMatchesFilter(value, filterValue) {
  if (!filterValue) return true;
  return normalizeTextKey(value).includes(normalizeTextKey(filterValue));
}

function resetColumnFilters() {
  launchTableFilters = { ...launchTableFilterDefaults };
  actionTableFilters = { ...actionTableFilterDefaults };
  managementActionTableFilters = { ...managementActionTableFilterDefaults };

  Object.entries(launchTableFilterDefaults).forEach(([key, defaultValue]) => {
    const input = qs(`[data-launch-filter="${key}"]`);
    if (input) input.value = defaultValue;
  });

  Object.entries(actionTableFilterDefaults).forEach(([key, defaultValue]) => {
    const input = qs(`[data-action-filter="${key}"]`);
    if (input) input.value = defaultValue;
  });

  Object.entries(actionTableFilterDefaults).forEach(([key, defaultValue]) => {
    const input = qs(`[data-action-col-filter="${key}"]`);
    if (input) input.value = defaultValue;
  });

  Object.entries(managementActionTableFilterDefaults).forEach(([key, defaultValue]) => {
    const input = qs(`[data-management-action-col-filter="${key}"]`);
    if (input) input.value = defaultValue;
  });
}

function parseLocalizedNumber(rawValue) {
  const text = String(rawValue ?? "")
    .replace(/[R$\s%]/g, "")
    .trim();
  if (!text) return NaN;

  let normalized = text;
  if (text.includes(",") && text.includes(".")) {
    normalized = text.replace(/\./g, "").replace(",", ".");
  } else if (text.includes(",")) {
    normalized = text.replace(",", ".");
  } else if (text.includes(".")) {
    const parts = text.split(".");
    const isThousandPattern = parts.length > 1 && parts.slice(1).every((part) => part.length === 3);
    if (isThousandPattern) {
      normalized = text.replace(/\./g, "");
    }
  }

  return Number(normalized);
}

function getLaunchFormulaType(indicatorName) {
  const key = normalizeTextKey(indicatorName);
  if (selectedDepartmentKey === "recebimento") {
    if (key.includes("capacidade") && key.includes("recebimento")) {
      return "recebimento_capacidade_diaria";
    }
    if (key.includes("otif") && key.includes("recebimento")) {
      return "recebimento_otif_fornecedores";
    }
    if (key.includes("eficiencia") && key.includes("recebimento")) {
      return "recebimento_eficiencia";
    }
    if (
      key.includes("tempo") &&
      ((key.includes("recebimento") && selectedDepartmentKey === "recebimento") ||
        (key.includes("liberacao") && key.includes("material")))
    ) {
      return "recebimento_tempo_liberacao";
    }
    if (key.includes("erros") && key.includes("armazenagem") && key.includes("movimentacao")) {
      return "recebimento_erros_armazenagem";
    }
    if (key.includes("produtividade") && key.includes("individual")) {
      return "recebimento_produtividade_individual";
    }
  }
  if (selectedDepartmentKey === "estoque") {
    if (key.includes("acuracidade") && key.includes("estoque") && key.includes("sku")) {
      return "estoque_acuracidade_sku";
    }
    if (key.includes("divergencia") && key.includes("contabil") && key.includes("wms")) {
      return "estoque_divergencia_wms_sku";
    }
    if (key.includes("cumprimento") && key.includes("plano") && key.includes("inventario")) {
      return "estoque_cumprimento_plano_inventario";
    }
    if (key.includes("indice") && key.includes("divergencias") && key.includes("tratadas")) {
      return "estoque_divergencias_tratadas";
    }
    if (key.includes("slow") && key.includes("mover")) {
      return "estoque_slow_mover";
    }
    if (key.includes("produtividade") && key.includes("contagens")) {
      return "estoque_produtividade_individual_contagens";
    }
  }
  if (selectedDepartmentKey === "secos") {
    if (key.includes("perdas") && key.includes("picks")) {
      return "secos_perdas_picks";
    }
    if (key.includes("ruptura") && key.includes("embalagens")) {
      return "secos_ruptura_embalagens";
    }
    if (key.includes("ops") && key.includes("erradas")) {
      return "secos_ops_atendidas_erradas";
    }
    if (key.includes("erros") && key.includes("movimentacao")) {
      return "secos_erros_movimentacao";
    }
    if (key.includes("erros") && key.includes("expedicao")) {
      return "secos_erros_expedicao_fabrica";
    }
    if (key.includes("tempo") && key.includes("carregamento") && key.includes("carretas")) {
      return "secos_tempo_carregamento_carretas";
    }
    if (key.includes("produtividade") && key.includes("individual")) {
      return "secos_produtividade_individual";
    }
  }
  if (selectedDepartmentKey === "quimicas") {
    if (key.includes("confiabilidade") && key.includes("abastecimento")) {
      return "quimica_confiabilidade_abastecimento";
    }
    if (key.includes("eficiencia") && key.includes("atendimento")) {
      return "quimica_eficiencia_atendimento_ops";
    }
    if (key.includes("retrabalho") && key.includes("separacao")) {
      return "quimica_retrabalho_separacao";
    }
    if (key.includes("giro") && key.includes("kanban")) {
      return "quimica_giro_kanban";
    }
    if (key.includes("produtividade") && key.includes("ops") && key.includes("separadas")) {
      return "quimica_produtividade_ops_separadas";
    }
    if (key.includes("produtividade") && key.includes("individual")) {
      return "quimica_produtividade_individual";
    }
  }
  if (key.includes("ruptura") && key.includes("estocave")) return "ruptura_estocaveis";
  if (key.includes("acuracidade") && key.includes("estoque") && key.includes("itens")) return "acuracidade_uso_consumo";
  if (key.includes("aderencia") && key.includes("estoque") && key.includes("minimo")) return "aderencia_estoque_minimo";
  if (key.includes("cumprimento") && key.includes("plano") && key.includes("inventario")) {
    return "cumprimento_plano_inventario";
  }
  if (key.includes("slow") && key.includes("mover")) return "slow_mover";
  if (key.includes("produtividade") && key.includes("individual")) return "produtividade_individual";
  if (key.includes("acur") && key.includes("estoq")) return "acuracidade";
  if (key.includes("contabil") && key.includes("wms")) return "divergencia_wms";
  if (key.includes("material") && key.includes("obsole")) return "obsolescencia";
  if (key.includes("perdas") && key.includes("inventar")) return "perdas_inventario";
  if (key.includes("produtiv") && key.includes("contag")) return "produtividade_contagens";
  if (key.includes("inventario") && key.includes("prazo")) return "produtividade_contagens";
  if (key.includes("moviment") && key.includes("colabor")) return "movimentacao_colaborador";
  if (key.includes("erros") && key.includes("moviment")) return "erros_movimentacao";
  if (key.includes("avari") && key.includes("moviment")) return "avarias_movimentacao";
  if (key.includes("tempo") && key.includes("espera") && key.includes("carreg")) return "espera_carregamento";
  if (key.includes("tempo") && key.includes("medio") && key.includes("carreg")) return "tempo_carregamento";
  if (key.includes("produtiv") && key.includes("seco")) return "movimentacao_colaborador";
  if (key.includes("erros") && key.includes("separ")) return "erros_movimentacao";
  if (key.includes("ocupacao") && key.includes("area")) return "avarias_movimentacao";
  if (key.includes("atraso") && key.includes("intern")) return "espera_carregamento";
  if (key.includes("pedidos") && key.includes("separ")) return "tempo_carregamento";
  if (key.includes("tempo") && key.includes("receb")) return "tempo_recebimento";
  if (key.includes("avari") && key.includes("receb")) return "avarias_recebimento";
  if (key.includes("acur") && key.includes("confer")) return "acuracia_recebimento";
  if (key.includes("sla") && (key.includes("armazen") || key.includes("receb"))) return "sla_recebimento";
  if (key.includes("giro") && (key.includes("doca") || key.includes("receb"))) return "giro_recebimento";
  if (key === "tempo de recebimento") return "tempo_recebimento";
  if (key === "avarias no recebimento") return "avarias_recebimento";
  if (key === "acuracia de conferencia" || key === "acuracia de recebimento") return "acuracia_recebimento";
  if (key === "sla de armazenagem" || key === "sla no recebimento") return "sla_recebimento";
  if (key === "giro de docas" || key === "giro no recebimento") return "giro_recebimento";
  if (key === "acuracidade") return "acuracidade";
  if (key === "divergencia contabil x wms") return "divergencia_wms";
  if (key === "obsolescencia") return "obsolescencia";
  if (key === "ruptura") return "ruptura";
  if (key === "giro diario") return "giro_diario";
  if (key === "movimentacao por colaborador") return "movimentacao_colaborador";
  if (key === "taxa de erros de movimentacao") return "erros_movimentacao";
  if (key === "taxa de avarias de movimentacao") return "avarias_movimentacao";
  if (key === "tempo de espera de carregamento") return "espera_carregamento";
  if (key === "tempo medio de carregamento") return "tempo_carregamento";
  return null;
}

const launchFormulaDefinitions = {
  acuracidade: {
    title: "Cálculo de Acuracidade",
    hint: "Acuracidade = (Itens corretos / Itens inventariados) x 100.",
    fields: ["correctItems", "inventoriedItems"],
    allowNegative: false,
  },
  divergencia_wms: {
    title: "Cálculo de Divergência Contábil x WMS",
    hint: "Divergência (%) = ((Estoque contábil - Estoque WMS) / Estoque WMS) x 100.",
    fields: ["accountingStock", "wmsStock"],
    allowNegative: true,
  },
  obsolescencia: {
    title: "Cálculo de Obsolescência",
    hint: "Obsolescência (%) = (Itens obsoletos / Total de itens em estoque) x 100.",
    fields: ["totalItemsStock", "obsoleteItems"],
    allowNegative: false,
  },
};

launchFormulaDefinitions.divergencia_wms.hint =
  "Divergência (%) = ((Estoque contábil - Estoque WMS) / Estoque contábil) x 100.";

launchFormulaDefinitions.ruptura = {
  title: "Cálculo de Ruptura",
  hint: "Ruptura (%) = (Itens em falta / Itens críticos) x 100.",
  fields: ["missingItems", "criticalItems"],
  allowNegative: false,
};

launchFormulaDefinitions.giro_diario = {
  title: "Cálculo de Giro Diário",
  hint: "Giro Diário (%) = (Saídas / Estoque médio) x 100.",
  fields: ["initialStock", "entriesValue", "outboundValue"],
  allowNegative: false,
};

launchFormulaDefinitions.recebimento_capacidade_diaria = {
  title: "Cálculo de Capacidade de Recebimento Diário",
  hint: "Capacidade (%) = (Recebimentos do dia / Capacidade planejada de recebimento) x 100.",
  fields: ["dailyReceipts", "plannedReceiptCapacity"],
  allowNegative: false,
};

launchFormulaDefinitions.recebimento_otif_fornecedores = {
  title: "Cálculo de OTIF de Recebimento de Fornecedores x Follow Up",
  hint: "OTIF (%) = (Entregas recebidas no prazo / Entregas programadas) x 100.",
  fields: ["onTimeSupplierDeliveries", "scheduledSupplierDeliveries"],
  allowNegative: false,
};

launchFormulaDefinitions.recebimento_eficiencia = {
  title: "Cálculo de Eficiência de Recebimento",
  hint: "Eficiência (%) = (Recebimentos concluídos dentro do prazo / Total de recebimentos) x 100.",
  fields: ["completedReceiptsOnTime", "totalReceipts"],
  allowNegative: false,
};

launchFormulaDefinitions.recebimento_tempo_liberacao = {
  title: "Cálculo de Tempo Médio de Recebimento",
  hint: "Tempo médio (min) = (Soma do tempo de liberação / Total de recebimentos) x 100.",
  fields: ["releaseTotalHours", "releasedReceipts"],
  allowNegative: false,
  resultSuffix: " min",
};

launchFormulaDefinitions.recebimento_erros_armazenagem = {
  title: "Cálculo de Erros de Armazenagem e Movimentação",
  hint: "Erros (%) = (Materiais reendereçados sem planejamento / Total de materiais armazenados) x 100.",
  fields: ["readdressedMaterials", "totalStoredMaterials"],
  allowNegative: false,
};

launchFormulaDefinitions.recebimento_produtividade_individual = {
  title: "Cálculo de Produtividade Individual",
  hint: "Produtividade (%) = (Atividades concluídas no turno / Total de colaboradores) x 100.",
  fields: ["completedShiftActivities", "collaboratorCount"],
  allowNegative: false,
};

launchFormulaDefinitions.ruptura_estocaveis = {
  title: "Cálculo de Ruptura de Material de Estocáveis",
  hint: "Ruptura (%) = (Itens de manutenção com estoque zerado / Materiais estocáveis de manutenção) x 100.",
  fields: ["zeroStockMaintenanceItems", "stockableMaintenanceItems"],
  allowNegative: false,
};

launchFormulaDefinitions.acuracidade_uso_consumo = {
  title: "Cálculo de Acuracidade de Estoque (Itens)",
  hint: "Acuracidade (%) = (Quantidade de itens corretos / Total de itens contados) x 100.",
  fields: ["correctItems", "totalCountedItems"],
  allowNegative: false,
};

launchFormulaDefinitions.estoque_acuracidade_sku = {
  title: "Cálculo de Acuracidade de Estoque (SKU)",
  hint: "Acuracidade (%) = (Quantidade de itens corretos / Total de itens contados) x 100.",
  fields: ["correctItems", "totalCountedItems"],
  allowNegative: false,
};

launchFormulaDefinitions.estoque_divergencia_wms_sku = {
  title: "Cálculo de Divergência Contábil x WMS (SKU)",
  hint: "Divergência (%) = (SKUs com divergência contábil x WMS / Total de SKUs) x 100.",
  fields: ["divergentSkus", "totalSkus"],
  allowNegative: false,
};

launchFormulaDefinitions.aderencia_estoque_minimo = {
  title: "Cálculo de Aderência ao Estoque Mínimo",
  hint: "Aderência (%) = (Itens acima do estoque mínimo / Total de itens estocáveis de manutenção) x 100.",
  fields: ["itemsAboveMinimum", "stockableMaintenanceItems"],
  allowNegative: false,
};

launchFormulaDefinitions.cumprimento_plano_inventario = {
  title: "Cálculo de Cumprimento do Plano de Inventário",
  hint: "Cumprimento (%) = (SKUs contados no período / Total de SKUs no estoque de reposição) x 100.",
  fields: ["countedSkusPeriod", "replenishmentSkus"],
  allowNegative: false,
};

launchFormulaDefinitions.estoque_cumprimento_plano_inventario = {
  title: "Cálculo de Cumprimento do Plano de Inventário",
  hint: "Cumprimento (%) = (SKUs contados no período / Total de SKUs no estoque de reposição) x 100.",
  fields: ["countedSkusPeriod", "replenishmentSkus"],
  allowNegative: false,
};

launchFormulaDefinitions.estoque_divergencias_tratadas = {
  title: "Cálculo do Índice de Divergências Tratadas",
  hint: "Índice (%) = (Divergências tratadas dentro do prazo / Total de divergências) x 100.",
  fields: ["treatedDivergencesOnTime", "totalDivergences"],
  allowNegative: false,
};

launchFormulaDefinitions.slow_mover = {
  title: "Cálculo de Estoque Slow Mover",
  hint: "Slow mover (%) = (SKUs há mais de 90 dias / Total de SKUs no estoque de reposição) x 100.",
  fields: ["slowMovingSkus", "replenishmentSkus"],
  allowNegative: false,
};

launchFormulaDefinitions.estoque_slow_mover = {
  title: "Cálculo de Estoque Slow Mover",
  hint: "Slow mover (%) = (SKUs há mais de 90 dias / Total de SKUs no estoque) x 100.",
  fields: ["slowMovingSkus", "totalStockSkus"],
  allowNegative: false,
};

launchFormulaDefinitions.produtividade_individual = {
  title: "Cálculo de Produtividade Individual (Uso & Consumo)",
  hint: "Produtividade (%) = (Atividades concluídas no turno / Total de colaboradores) x 100.",
  fields: ["completedShiftActivities", "collaboratorCount"],
  allowNegative: false,
};

launchFormulaDefinitions.estoque_produtividade_individual_contagens = {
  title: "Cálculo de Produtividade de Contagens",
  hint: "Produtividade de contagens = Contagens realizadas / Total de colaboradores.",
  fields: ["dailyCountedSkus", "collaboratorCount"],
  allowNegative: false,
  resultSuffix: " SKU/dia",
};

launchFormulaDefinitions.tempo_recebimento = {
  title: "Cálculo de Tempo de Recebimento",
  hint: "Tempo médio (min) = (Tempo total de recebimento em horas / Cargas recebidas) x 60.",
  fields: ["receivedLoads", "receiptHours"],
  allowNegative: false,
  resultSuffix: " min",
};

launchFormulaDefinitions.avarias_recebimento = {
  title: "Cálculo de Avarias no Recebimento",
  hint: "Avarias (%) = (Itens avariados / Itens recebidos) x 100.",
  fields: ["receivedUnits", "damagedUnits"],
  allowNegative: false,
};

launchFormulaDefinitions.acuracia_recebimento = {
  title: "Cálculo de Acurácia de Conferência",
  hint: "Acurácia (%) = (Itens corretos / Itens recebidos) x 100.",
  fields: ["receivedUnits", "correctUnits"],
  allowNegative: false,
};

launchFormulaDefinitions.sla_recebimento = {
  title: "Cálculo de SLA de Armazenagem",
  hint: "SLA (%) = (Cargas com follow-up em 1h / Cargas recebidas) x 100.",
  fields: ["receivedLoads", "followUpLoads"],
  allowNegative: false,
};

launchFormulaDefinitions.giro_recebimento = {
  title: "Cálculo de Giro de Docas",
  hint: "Giro (%) = (Volume recebido em paletes / Capacidade de posição) x 100.",
  fields: ["receivedPallets", "palletCapacity"],
  allowNegative: false,
};

launchFormulaDefinitions.produtividade_contagens = {
  title: "Cálculo de Produtividade de Contagens",
  hint: "Itens por colaborador = (Total de itens contados / Número de colaboradores).",
  fields: ["countedItems", "collaboratorCount"],
  allowNegative: false,
  resultSuffix: " itens/colab",
};

launchFormulaDefinitions.perdas_inventario = {
  title: "Cálculo de Perdas de Inventário",
  hint: "Perdas (%) = (Perdas no estoque / Itens inventariados) x 100.",
  fields: ["lossItems", "inventoriedItems"],
  allowNegative: false,
};

launchFormulaDefinitions.secos_perdas_picks = {
  title: "Cálculo de Índice de Perdas por Ajuste no Picks Secos",
  hint: "Índice de perdas (%) = (Valor total ajustado / Valor total do estoque) x 100.",
  fields: ["adjustedValue", "totalStockValue"],
  allowNegative: false,
};

launchFormulaDefinitions.secos_ruptura_embalagens = {
  title: "Cálculo de Índice de Ruptura de Embalagens na Produção",
  hint: "Ruptura = quantidade de OPs impactadas no período.",
  fields: ["impactedOps"],
  allowNegative: false,
  resultSuffix: " OPs",
};

launchFormulaDefinitions.secos_ops_atendidas_erradas = {
  title: "Cálculo de Índice de OPs Atendidas Erradas",
  hint: "Índice (%) = (OPs atendidas erradas / Total de OPs solicitadas) x 100.",
  fields: ["wrongOps", "requestedOps"],
  allowNegative: false,
};

launchFormulaDefinitions.secos_erros_movimentacao = {
  title: "Cálculo de Índice de Erros de Movimentação",
  hint: "Erros (%) = (Quantidade de erros de movimentação / Itens movimentados) x 100.",
  fields: ["movementErrors", "movedItems"],
  allowNegative: false,
};

launchFormulaDefinitions.secos_erros_expedicao_fabrica = {
  title: "Cálculo de Erros Expedição Fábrica",
  hint: "Erro de expedição = somatória em R$ de sobras e faltas expedidas.",
  fields: ["expeditionErrorValue"],
  allowNegative: false,
  resultSuffix: "",
};

launchFormulaDefinitions.secos_tempo_carregamento_carretas = {
  title: "Cálculo de Tempo Médio Carregamento Carretas",
  hint: "Tempo médio (min) = Tempo total de carregamento / Quantidade de carretas carregadas.",
  fields: ["loadedTrucks", "loadingTotalMinutes"],
  allowNegative: false,
  resultSuffix: " min",
};

launchFormulaDefinitions.secos_produtividade_individual = {
  title: "Cálculo de Produtividade Individual",
  hint: "Produtividade = Atividades concluídas / Total de colaboradores.",
  fields: ["completedShiftActivities", "collaboratorCount"],
  allowNegative: false,
  resultSuffix: " atividades/colab",
};

launchFormulaDefinitions.quimica_confiabilidade_abastecimento = {
  title: "Cálculo de Confiabilidade do Abastecimento da Produção",
  hint: "Confiabilidade (%) = (OPs abastecidas sem atraso/divergência / Total de OPs) x 100.",
  fields: ["chemSupplyOkOps", "chemTotalOps"],
  allowNegative: false,
};

launchFormulaDefinitions.quimica_eficiencia_atendimento_ops = {
  title: "Cálculo de Eficiência no Atendimento das OPs",
  hint: "Eficiência (%) = (OPs entregues / Total de OPs previstas) x 100.",
  fields: ["chemDeliveredOps", "chemPlannedOps"],
  allowNegative: false,
};

launchFormulaDefinitions.quimica_retrabalho_separacao = {
  title: "Cálculo de Índice de Retrabalho de Separação",
  hint: "Retrabalho (%) = (Retrabalhos ou repesagens / Total de OPs separadas) x 100.",
  fields: ["chemReworkOps", "chemSeparatedOps"],
  allowNegative: false,
};

launchFormulaDefinitions.quimica_giro_kanban = {
  title: "Cálculo de Taxa de Giro do Kanban",
  hint: "Giro do Kanban (%) = (OPs acima de 7 dias no Kanban / Total de OPs no Kanban) x 100.",
  fields: ["chemKanbanOver7DaysOps", "chemKanbanTotalOps"],
  allowNegative: false,
};

launchFormulaDefinitions.quimica_produtividade_ops_separadas = {
  title: "Cálculo de Produtividade de OPs Separadas",
  hint: "Produtividade (%) = (OPs entregues no turno / Meta de entrega do turno) x 100.",
  fields: ["chemShiftDeliveredOps", "chemShiftTargetOps"],
  allowNegative: false,
};

launchFormulaDefinitions.quimica_produtividade_individual = {
  title: "Cálculo de Produtividade Individual",
  hint: "Produtividade = Atividades concluídas / Total de colaboradores.",
  fields: ["completedShiftActivities", "collaboratorCount"],
  allowNegative: false,
  resultSuffix: " atividades/colab",
};

launchFormulaDefinitions.movimentacao_colaborador = {
  title: "Cálculo de Movimentação por Colaborador",
  hint: "Movimentação por colaborador = (Itens movimentados / Número de colaboradores).",
  fields: ["movedItems", "collaboratorCount"],
  allowNegative: false,
  resultSuffix: " itens/colab",
};

launchFormulaDefinitions.erros_movimentacao = {
  title: "Cálculo de Taxa de Erros de Movimentação",
  hint: "Erros (%) = (Quantidade de erros / Itens movimentados) x 100.",
  fields: ["movedItems", "movementErrors"],
  allowNegative: false,
};

launchFormulaDefinitions.avarias_movimentacao = {
  title: "Cálculo de Taxa de Avarias de Movimentação",
  hint: "Avarias (%) = (Itens avariados / Itens movimentados) x 100.",
  fields: ["movedItems", "damagedMovedItems"],
  allowNegative: false,
};

launchFormulaDefinitions.espera_carregamento = {
  title: "Cálculo de Tempo de Espera de Carregamento",
  hint: "Tempo de espera (min) = tempo total de espera informado no dia.",
  fields: ["waitMinutes"],
  allowNegative: false,
  resultSuffix: " min",
};

launchFormulaDefinitions.tempo_carregamento = {
  title: "Cálculo de Tempo Médio de Carregamento",
  hint: "Tempo médio (min) = (Tempo total de carregamento / Quantidade de carretas carregadas).",
  fields: ["loadedTrucks", "loadingTotalMinutes"],
  allowNegative: false,
  resultSuffix: " min",
};

function getLaunchFormulaFieldValue(fieldName) {
  const input = qs(`#launchForm [name="${fieldName}"]`);
  return parseLocalizedNumber(input?.value);
}

function computeLaunchFormulaValue(formulaType) {
  if (formulaType === "acuracidade") {
    const correctItems = getLaunchFormulaFieldValue("correctItems");
    const inventoriedItems = getLaunchFormulaFieldValue("inventoriedItems");
    if (!Number.isFinite(correctItems) || !Number.isFinite(inventoriedItems) || inventoriedItems <= 0) return NaN;
    return (correctItems / inventoriedItems) * 100;
  }

  if (formulaType === "divergencia_wms") {
    const accountingStock = getLaunchFormulaFieldValue("accountingStock");
    const wmsStock = getLaunchFormulaFieldValue("wmsStock");
    if (!Number.isFinite(accountingStock) || !Number.isFinite(wmsStock) || accountingStock <= 0) return NaN;
    return ((accountingStock - wmsStock) / accountingStock) * 100;
  }

  if (formulaType === "obsolescencia") {
    const totalItemsStock = getLaunchFormulaFieldValue("totalItemsStock");
    const obsoleteItems = getLaunchFormulaFieldValue("obsoleteItems");
    if (!Number.isFinite(totalItemsStock) || !Number.isFinite(obsoleteItems) || totalItemsStock <= 0) return NaN;
    return (obsoleteItems / totalItemsStock) * 100;
  }

  if (formulaType === "ruptura") {
    const missingItems = getLaunchFormulaFieldValue("missingItems");
    const criticalItems = getLaunchFormulaFieldValue("criticalItems");
    if (!Number.isFinite(missingItems) || !Number.isFinite(criticalItems) || criticalItems <= 0) return NaN;
    return (missingItems / criticalItems) * 100;
  }

  if (formulaType === "giro_diario") {
    const initialStock = getLaunchFormulaFieldValue("initialStock");
    const entriesValue = getLaunchFormulaFieldValue("entriesValue");
    const outboundValue = getLaunchFormulaFieldValue("outboundValue");
    if (!Number.isFinite(initialStock) || !Number.isFinite(entriesValue) || !Number.isFinite(outboundValue)) return NaN;
    const finalStock = initialStock + entriesValue - outboundValue;
    const averageStock = (initialStock + finalStock) / 2;
    if (!Number.isFinite(averageStock) || averageStock <= 0) return NaN;
    return (outboundValue / averageStock) * 100;
  }

  if (formulaType === "recebimento_capacidade_diaria") {
    const dailyReceipts = getLaunchFormulaFieldValue("dailyReceipts");
    const plannedReceiptCapacity = getLaunchFormulaFieldValue("plannedReceiptCapacity");
    if (!Number.isFinite(dailyReceipts) || !Number.isFinite(plannedReceiptCapacity) || plannedReceiptCapacity <= 0) return NaN;
    return (dailyReceipts / plannedReceiptCapacity) * 100;
  }

  if (formulaType === "recebimento_otif_fornecedores") {
    const onTimeSupplierDeliveries = getLaunchFormulaFieldValue("onTimeSupplierDeliveries");
    const scheduledSupplierDeliveries = getLaunchFormulaFieldValue("scheduledSupplierDeliveries");
    if (
      !Number.isFinite(onTimeSupplierDeliveries) ||
      !Number.isFinite(scheduledSupplierDeliveries) ||
      scheduledSupplierDeliveries <= 0
    ) {
      return NaN;
    }
    return (onTimeSupplierDeliveries / scheduledSupplierDeliveries) * 100;
  }

  if (formulaType === "recebimento_eficiencia") {
    const completedReceiptsOnTime = getLaunchFormulaFieldValue("completedReceiptsOnTime");
    const totalReceipts = getLaunchFormulaFieldValue("totalReceipts");
    if (!Number.isFinite(completedReceiptsOnTime) || !Number.isFinite(totalReceipts) || totalReceipts <= 0) return NaN;
    return (completedReceiptsOnTime / totalReceipts) * 100;
  }

  if (formulaType === "recebimento_tempo_liberacao") {
    const releaseTotalHours = getLaunchFormulaFieldValue("releaseTotalHours");
    const releasedReceipts = getLaunchFormulaFieldValue("releasedReceipts");
    if (!Number.isFinite(releaseTotalHours) || !Number.isFinite(releasedReceipts) || releasedReceipts <= 0) return NaN;
    return (releaseTotalHours / releasedReceipts) * 100;
  }

  if (formulaType === "recebimento_erros_armazenagem") {
    const readdressedMaterials = getLaunchFormulaFieldValue("readdressedMaterials");
    const totalStoredMaterials = getLaunchFormulaFieldValue("totalStoredMaterials");
    if (!Number.isFinite(readdressedMaterials) || !Number.isFinite(totalStoredMaterials) || totalStoredMaterials <= 0) {
      return NaN;
    }
    return (readdressedMaterials / totalStoredMaterials) * 100;
  }

  if (formulaType === "recebimento_produtividade_individual") {
    const completedShiftActivities = getLaunchFormulaFieldValue("completedShiftActivities");
    const collaboratorCount = getLaunchFormulaFieldValue("collaboratorCount");
    if (!Number.isFinite(completedShiftActivities) || !Number.isFinite(collaboratorCount) || collaboratorCount <= 0) {
      return NaN;
    }
    return (completedShiftActivities / collaboratorCount) * 100;
  }

  if (formulaType === "ruptura_estocaveis") {
    const zeroStockMaintenanceItems = getLaunchFormulaFieldValue("zeroStockMaintenanceItems");
    const stockableMaintenanceItems = getLaunchFormulaFieldValue("stockableMaintenanceItems");
    if (
      !Number.isFinite(zeroStockMaintenanceItems) ||
      !Number.isFinite(stockableMaintenanceItems) ||
      stockableMaintenanceItems <= 0
    ) {
      return NaN;
    }
    return (zeroStockMaintenanceItems / stockableMaintenanceItems) * 100;
  }

  if (formulaType === "acuracidade_uso_consumo") {
    const correctItems = getLaunchFormulaFieldValue("correctItems");
    const totalCountedItems = getLaunchFormulaFieldValue("totalCountedItems");
    if (!Number.isFinite(correctItems) || !Number.isFinite(totalCountedItems) || totalCountedItems <= 0) return NaN;
    return (correctItems / totalCountedItems) * 100;
  }

  if (formulaType === "estoque_acuracidade_sku") {
    const correctItems = getLaunchFormulaFieldValue("correctItems");
    const totalCountedItems = getLaunchFormulaFieldValue("totalCountedItems");
    if (!Number.isFinite(correctItems) || !Number.isFinite(totalCountedItems) || totalCountedItems <= 0) return NaN;
    return (correctItems / totalCountedItems) * 100;
  }

  if (formulaType === "estoque_divergencia_wms_sku") {
    const divergentSkus = getLaunchFormulaFieldValue("divergentSkus");
    const totalSkus = getLaunchFormulaFieldValue("totalSkus");
    if (!Number.isFinite(divergentSkus) || !Number.isFinite(totalSkus) || totalSkus <= 0) return NaN;
    return (divergentSkus / totalSkus) * 100;
  }

  if (formulaType === "aderencia_estoque_minimo") {
    const itemsAboveMinimum = getLaunchFormulaFieldValue("itemsAboveMinimum");
    const stockableMaintenanceItems = getLaunchFormulaFieldValue("stockableMaintenanceItems");
    if (!Number.isFinite(itemsAboveMinimum) || !Number.isFinite(stockableMaintenanceItems) || stockableMaintenanceItems <= 0) {
      return NaN;
    }
    return (itemsAboveMinimum / stockableMaintenanceItems) * 100;
  }

  if (formulaType === "cumprimento_plano_inventario") {
    const countedSkusPeriod = getLaunchFormulaFieldValue("countedSkusPeriod");
    const replenishmentSkus = getLaunchFormulaFieldValue("replenishmentSkus");
    if (!Number.isFinite(countedSkusPeriod) || !Number.isFinite(replenishmentSkus) || replenishmentSkus <= 0) return NaN;
    return (countedSkusPeriod / replenishmentSkus) * 100;
  }

  if (formulaType === "estoque_cumprimento_plano_inventario") {
    const countedSkusPeriod = getLaunchFormulaFieldValue("countedSkusPeriod");
    const replenishmentSkus = getLaunchFormulaFieldValue("replenishmentSkus");
    if (!Number.isFinite(countedSkusPeriod) || !Number.isFinite(replenishmentSkus) || replenishmentSkus <= 0) return NaN;
    return (countedSkusPeriod / replenishmentSkus) * 100;
  }

  if (formulaType === "estoque_divergencias_tratadas") {
    const treatedDivergencesOnTime = getLaunchFormulaFieldValue("treatedDivergencesOnTime");
    const totalDivergences = getLaunchFormulaFieldValue("totalDivergences");
    if (!Number.isFinite(treatedDivergencesOnTime) || !Number.isFinite(totalDivergences) || totalDivergences <= 0) {
      return NaN;
    }
    return (treatedDivergencesOnTime / totalDivergences) * 100;
  }

  if (formulaType === "slow_mover") {
    const slowMovingSkus = getLaunchFormulaFieldValue("slowMovingSkus");
    const replenishmentSkus = getLaunchFormulaFieldValue("replenishmentSkus");
    if (!Number.isFinite(slowMovingSkus) || !Number.isFinite(replenishmentSkus) || replenishmentSkus <= 0) return NaN;
    return (slowMovingSkus / replenishmentSkus) * 100;
  }

  if (formulaType === "estoque_slow_mover") {
    const slowMovingSkus = getLaunchFormulaFieldValue("slowMovingSkus");
    const totalStockSkus = getLaunchFormulaFieldValue("totalStockSkus");
    if (!Number.isFinite(slowMovingSkus) || !Number.isFinite(totalStockSkus) || totalStockSkus <= 0) return NaN;
    return (slowMovingSkus / totalStockSkus) * 100;
  }

  if (formulaType === "produtividade_individual") {
    const completedShiftActivities = getLaunchFormulaFieldValue("completedShiftActivities");
    const collaboratorCount = getLaunchFormulaFieldValue("collaboratorCount");
    if (!Number.isFinite(completedShiftActivities) || !Number.isFinite(collaboratorCount) || collaboratorCount <= 0) {
      return NaN;
    }
    return (completedShiftActivities / collaboratorCount) * 100;
  }

  if (formulaType === "estoque_produtividade_individual_contagens") {
    const dailyCountedSkus = getLaunchFormulaFieldValue("dailyCountedSkus");
    const collaboratorCount = getLaunchFormulaFieldValue("collaboratorCount");
    if (!Number.isFinite(dailyCountedSkus) || !Number.isFinite(collaboratorCount) || collaboratorCount <= 0) return NaN;
    return dailyCountedSkus / collaboratorCount;
  }

  if (formulaType === "tempo_recebimento") {
    const receivedLoads = getLaunchFormulaFieldValue("receivedLoads");
    const receiptHours = getLaunchFormulaFieldValue("receiptHours");
    if (!Number.isFinite(receivedLoads) || !Number.isFinite(receiptHours) || receivedLoads <= 0) return NaN;
    return (receiptHours / receivedLoads) * 60;
  }

  if (formulaType === "avarias_recebimento") {
    const receivedUnits = getLaunchFormulaFieldValue("receivedUnits");
    const damagedUnits = getLaunchFormulaFieldValue("damagedUnits");
    if (!Number.isFinite(receivedUnits) || !Number.isFinite(damagedUnits) || receivedUnits <= 0) return NaN;
    return (damagedUnits / receivedUnits) * 100;
  }

  if (formulaType === "acuracia_recebimento") {
    const receivedUnits = getLaunchFormulaFieldValue("receivedUnits");
    const correctUnits = getLaunchFormulaFieldValue("correctUnits");
    if (!Number.isFinite(receivedUnits) || !Number.isFinite(correctUnits) || receivedUnits <= 0) return NaN;
    return (correctUnits / receivedUnits) * 100;
  }

  if (formulaType === "sla_recebimento") {
    const receivedLoads = getLaunchFormulaFieldValue("receivedLoads");
    const followUpLoads = getLaunchFormulaFieldValue("followUpLoads");
    if (!Number.isFinite(receivedLoads) || !Number.isFinite(followUpLoads) || receivedLoads <= 0) return NaN;
    return (followUpLoads / receivedLoads) * 100;
  }

  if (formulaType === "giro_recebimento") {
    const receivedPallets = getLaunchFormulaFieldValue("receivedPallets");
    const palletCapacity = getLaunchFormulaFieldValue("palletCapacity");
    if (!Number.isFinite(receivedPallets) || !Number.isFinite(palletCapacity) || palletCapacity <= 0) return NaN;
    return (receivedPallets / palletCapacity) * 100;
  }

  if (formulaType === "produtividade_contagens") {
    const countedItems = getLaunchFormulaFieldValue("countedItems");
    const collaboratorCount = getLaunchFormulaFieldValue("collaboratorCount");
    if (!Number.isFinite(countedItems) || !Number.isFinite(collaboratorCount) || collaboratorCount <= 0) return NaN;
    return countedItems / collaboratorCount;
  }

  if (formulaType === "perdas_inventario") {
    const lossItems = getLaunchFormulaFieldValue("lossItems");
    const inventoriedItems = getLaunchFormulaFieldValue("inventoriedItems");
    if (!Number.isFinite(lossItems) || !Number.isFinite(inventoriedItems) || inventoriedItems <= 0) return NaN;
    return (lossItems / inventoriedItems) * 100;
  }

  if (formulaType === "secos_perdas_picks") {
    const adjustedValue = getLaunchFormulaFieldValue("adjustedValue");
    const totalStockValue = getLaunchFormulaFieldValue("totalStockValue");
    if (!Number.isFinite(adjustedValue) || !Number.isFinite(totalStockValue) || totalStockValue <= 0) return NaN;
    return (adjustedValue / totalStockValue) * 100;
  }

  if (formulaType === "secos_ruptura_embalagens") {
    const impactedOps = getLaunchFormulaFieldValue("impactedOps");
    if (!Number.isFinite(impactedOps)) return NaN;
    return impactedOps;
  }

  if (formulaType === "secos_ops_atendidas_erradas") {
    const wrongOps = getLaunchFormulaFieldValue("wrongOps");
    const requestedOps = getLaunchFormulaFieldValue("requestedOps");
    if (!Number.isFinite(wrongOps) || !Number.isFinite(requestedOps) || requestedOps <= 0) return NaN;
    return (wrongOps / requestedOps) * 100;
  }

  if (formulaType === "secos_erros_movimentacao") {
    const movementErrors = getLaunchFormulaFieldValue("movementErrors");
    const movedItems = getLaunchFormulaFieldValue("movedItems");
    if (!Number.isFinite(movementErrors) || !Number.isFinite(movedItems) || movedItems <= 0) return NaN;
    return (movementErrors / movedItems) * 100;
  }

  if (formulaType === "secos_erros_expedicao_fabrica") {
    const expeditionErrorValue = getLaunchFormulaFieldValue("expeditionErrorValue");
    if (!Number.isFinite(expeditionErrorValue)) return NaN;
    return expeditionErrorValue;
  }

  if (formulaType === "secos_tempo_carregamento_carretas") {
    const loadedTrucks = getLaunchFormulaFieldValue("loadedTrucks");
    const loadingTotalMinutes = getLaunchFormulaFieldValue("loadingTotalMinutes");
    if (!Number.isFinite(loadedTrucks) || !Number.isFinite(loadingTotalMinutes) || loadedTrucks <= 0) return NaN;
    return loadingTotalMinutes / loadedTrucks;
  }

  if (formulaType === "secos_produtividade_individual") {
    const completedShiftActivities = getLaunchFormulaFieldValue("completedShiftActivities");
    const collaboratorCount = getLaunchFormulaFieldValue("collaboratorCount");
    if (!Number.isFinite(completedShiftActivities) || !Number.isFinite(collaboratorCount) || collaboratorCount <= 0) return NaN;
    return completedShiftActivities / collaboratorCount;
  }

  if (formulaType === "quimica_confiabilidade_abastecimento") {
    const chemSupplyOkOps = getLaunchFormulaFieldValue("chemSupplyOkOps");
    const chemTotalOps = getLaunchFormulaFieldValue("chemTotalOps");
    if (!Number.isFinite(chemSupplyOkOps) || !Number.isFinite(chemTotalOps) || chemTotalOps <= 0) return NaN;
    return (chemSupplyOkOps / chemTotalOps) * 100;
  }

  if (formulaType === "quimica_eficiencia_atendimento_ops") {
    const chemDeliveredOps = getLaunchFormulaFieldValue("chemDeliveredOps");
    const chemPlannedOps = getLaunchFormulaFieldValue("chemPlannedOps");
    if (!Number.isFinite(chemDeliveredOps) || !Number.isFinite(chemPlannedOps) || chemPlannedOps <= 0) return NaN;
    return (chemDeliveredOps / chemPlannedOps) * 100;
  }

  if (formulaType === "quimica_retrabalho_separacao") {
    const chemReworkOps = getLaunchFormulaFieldValue("chemReworkOps");
    const chemSeparatedOps = getLaunchFormulaFieldValue("chemSeparatedOps");
    if (!Number.isFinite(chemReworkOps) || !Number.isFinite(chemSeparatedOps) || chemSeparatedOps <= 0) return NaN;
    return (chemReworkOps / chemSeparatedOps) * 100;
  }

  if (formulaType === "quimica_giro_kanban") {
    const chemKanbanOver7DaysOps = getLaunchFormulaFieldValue("chemKanbanOver7DaysOps");
    const chemKanbanTotalOps = getLaunchFormulaFieldValue("chemKanbanTotalOps");
    if (!Number.isFinite(chemKanbanOver7DaysOps) || !Number.isFinite(chemKanbanTotalOps) || chemKanbanTotalOps <= 0) return NaN;
    return (chemKanbanOver7DaysOps / chemKanbanTotalOps) * 100;
  }

  if (formulaType === "quimica_produtividade_ops_separadas") {
    const chemShiftDeliveredOps = getLaunchFormulaFieldValue("chemShiftDeliveredOps");
    const chemShiftTargetOps = getLaunchFormulaFieldValue("chemShiftTargetOps");
    if (!Number.isFinite(chemShiftDeliveredOps) || !Number.isFinite(chemShiftTargetOps) || chemShiftTargetOps <= 0) return NaN;
    return (chemShiftDeliveredOps / chemShiftTargetOps) * 100;
  }

  if (formulaType === "quimica_produtividade_individual") {
    const completedShiftActivities = getLaunchFormulaFieldValue("completedShiftActivities");
    const collaboratorCount = getLaunchFormulaFieldValue("collaboratorCount");
    if (!Number.isFinite(completedShiftActivities) || !Number.isFinite(collaboratorCount) || collaboratorCount <= 0) return NaN;
    return completedShiftActivities / collaboratorCount;
  }

  if (formulaType === "movimentacao_colaborador") {
    const movedItems = getLaunchFormulaFieldValue("movedItems");
    const collaboratorCount = getLaunchFormulaFieldValue("collaboratorCount");
    if (!Number.isFinite(movedItems) || !Number.isFinite(collaboratorCount) || collaboratorCount <= 0) return NaN;
    return movedItems / collaboratorCount;
  }

  if (formulaType === "erros_movimentacao") {
    const movedItems = getLaunchFormulaFieldValue("movedItems");
    const movementErrors = getLaunchFormulaFieldValue("movementErrors");
    if (!Number.isFinite(movedItems) || !Number.isFinite(movementErrors) || movedItems <= 0) return NaN;
    return (movementErrors / movedItems) * 100;
  }

  if (formulaType === "avarias_movimentacao") {
    const movedItems = getLaunchFormulaFieldValue("movedItems");
    const damagedMovedItems = getLaunchFormulaFieldValue("damagedMovedItems");
    if (!Number.isFinite(movedItems) || !Number.isFinite(damagedMovedItems) || movedItems <= 0) return NaN;
    return (damagedMovedItems / movedItems) * 100;
  }

  if (formulaType === "espera_carregamento") {
    const waitMinutes = getLaunchFormulaFieldValue("waitMinutes");
    if (!Number.isFinite(waitMinutes)) return NaN;
    return waitMinutes;
  }

  if (formulaType === "tempo_carregamento") {
    const loadedTrucks = getLaunchFormulaFieldValue("loadedTrucks");
    const loadingTotalMinutes = getLaunchFormulaFieldValue("loadingTotalMinutes");
    if (!Number.isFinite(loadedTrucks) || !Number.isFinite(loadingTotalMinutes) || loadedTrucks <= 0) return NaN;
    return loadingTotalMinutes / loadedTrucks;
  }

  return NaN;
}

function updateLaunchResultFromFormula() {
  const indicatorName = qs("#launchIndicator")?.value || "";
  const formulaType = getLaunchFormulaType(indicatorName);
  const valueInput = qs('#launchForm [name="value"]');
  const hintElement = qs("#launchFormulaHint");
  if (!valueInput || !hintElement) return;

  if (!formulaType || !launchFormulaDefinitions[formulaType]) {
    hintElement.textContent = "";
    return;
  }

  const definition = launchFormulaDefinitions[formulaType];
  const computedValue = computeLaunchFormulaValue(formulaType);
  const resultSuffix = definition.resultSuffix || "%";
  const indicator = currentDepartment().indicators.find((item) => item.name === indicatorName);
  if (Number.isFinite(computedValue)) {
    valueInput.value = computedValue.toFixed(2);
    if (formulaType === "giro_diario") {
      const initialStock = getLaunchFormulaFieldValue("initialStock");
      const entriesValue = getLaunchFormulaFieldValue("entriesValue");
      const outboundValue = getLaunchFormulaFieldValue("outboundValue");
      const finalStock = initialStock + entriesValue - outboundValue;
      const averageStock = (initialStock + finalStock) / 2;
      hintElement.textContent = `${definition.hint} Estoque final: R$ ${formatNumber(finalStock)} | Estoque médio: R$ ${formatNumber(averageStock)} | Resultado calculado: ${formatNumber(computedValue)}%.`;
      return;
    }
    if (indicator?.unit === "R$") {
      hintElement.textContent = `${definition.hint} Resultado calculado: R$ ${formatNumber(computedValue)}.`;
      return;
    }
    hintElement.textContent = `${definition.hint} Resultado calculado: ${formatNumber(computedValue)}${resultSuffix}.`;
    return;
  }

  valueInput.value = "";
  hintElement.textContent = definition.hint;
}

function syncLaunchFormByIndicator() {
  const indicatorName = qs("#launchIndicator")?.value || "";
  const formulaType = getLaunchFormulaType(indicatorName);
  const definition = formulaType ? launchFormulaDefinitions[formulaType] : null;
  const formulaFields = qs("#launchFormulaFields");
  const titleElement = qs("#launchFormulaTitle");
  const hintElement = qs("#launchFormulaHint");
  const valueInput = qs('#launchForm [name="value"]');
  if (!formulaFields || !titleElement || !hintElement || !valueInput) return;

  const allFieldNames = [
    "correctItems",
    "inventoriedItems",
    "totalCountedItems",
    "accountingStock",
    "wmsStock",
    "totalItemsStock",
    "obsoleteItems",
    "dailyReceipts",
    "plannedReceiptCapacity",
    "onTimeSupplierDeliveries",
    "scheduledSupplierDeliveries",
    "completedReceiptsOnTime",
    "totalReceipts",
    "releaseTotalHours",
    "releasedReceipts",
    "readdressedMaterials",
    "totalStoredMaterials",
    "divergentSkus",
    "totalSkus",
    "missingItems",
    "criticalItems",
    "zeroStockMaintenanceItems",
    "stockableMaintenanceItems",
    "itemsAboveMinimum",
    "countedSkusPeriod",
    "replenishmentSkus",
    "treatedDivergencesOnTime",
    "totalDivergences",
    "slowMovingSkus",
    "totalStockSkus",
    "collaboratorName",
    "completedActivities",
    "totalAttendances",
    "completedShiftActivities",
    "dailyCountedSkus",
    "adjustedValue",
    "totalStockValue",
    "impactedOps",
    "wrongOps",
    "requestedOps",
    "expeditionErrorValue",
    "chemSupplyOkOps",
    "chemTotalOps",
    "chemDeliveredOps",
    "chemPlannedOps",
    "chemReworkOps",
    "chemSeparatedOps",
    "chemKanbanOver7DaysOps",
    "chemKanbanTotalOps",
    "chemShiftDeliveredOps",
    "chemShiftTargetOps",
    "initialStock",
    "entriesValue",
    "outboundValue",
    "receivedLoads",
    "receiptHours",
    "receivedUnits",
    "damagedUnits",
    "correctUnits",
    "followUpLoads",
    "receivedPallets",
    "palletCapacity",
    "countedItems",
    "collaboratorCount",
    "lossItems",
    "movedItems",
    "movementErrors",
    "damagedMovedItems",
    "waitMinutes",
    "loadedTrucks",
    "loadingTotalMinutes",
  ];

  if (!definition) {
    formulaFields.classList.add("hidden");
    allFieldNames.forEach((fieldName) => {
      const wrapper = qs(`#launchFormulaFields [data-field="${fieldName}"]`);
      const input = qs(`#launchFormulaFields [name="${fieldName}"]`);
      if (wrapper) wrapper.classList.add("hidden");
      if (input) input.required = false;
    });
    valueInput.readOnly = false;
    valueInput.placeholder = "Ex.: 97.5";
    valueInput.min = "0";
    valueInput.step = "0.01";
    hintElement.textContent = "";
    return;
  }

  formulaFields.classList.remove("hidden");
  titleElement.textContent = definition.title;

  allFieldNames.forEach((fieldName) => {
    const wrapper = qs(`#launchFormulaFields [data-field="${fieldName}"]`);
    const input = qs(`#launchFormulaFields [name="${fieldName}"]`);
    const isActive = definition.fields.includes(fieldName);

    if (wrapper) wrapper.classList.toggle("hidden", !isActive);
    if (input) {
      input.required = isActive;
      if (!isActive) input.value = "";
    }
  });

  valueInput.readOnly = true;
  valueInput.placeholder = "Calculado automaticamente";
  valueInput.step = "0.01";
  valueInput.min = definition.allowNegative ? "-9999999" : "0";
  updateLaunchResultFromFormula();
}

function populateLogin() {
  qs("#loginSector").innerHTML = accessProfiles
    .map((profile) => `<option value="${escapeAttribute(profile.key)}">${escapeHtml(profile.label)}</option>`)
    .join("");
}

function populateDepartmentSelect() {
  qs("#departmentSelect").innerHTML = operationalDepartmentKeys
    .map((key) => `<option value="${escapeAttribute(key)}">${escapeHtml(departments[key].label)}</option>`)
    .join("");
  qs("#departmentSelect").value = selectedDepartmentKey;
}

function renderNavigation() {
  const appShell = qs("#appShell");
  if (appShell) {
    appShell.classList.toggle("treatments-mode", currentView === "treatments");
    appShell.dataset.activeView = currentView;
  }
  const consolidatedManagementViews = ["tv", "treatments", "analyses"];
  qsa(".management-only").forEach((item) => item.classList.toggle("hidden", !isManagement()));
  qsa(".operational-only").forEach((item) => item.classList.toggle("hidden", isManagement()));
  qsa(".chemical-only").forEach((item) => item.classList.add("hidden"));
  const topbarActions = qs(".topbar-actions");
  if (topbarActions) {
    const hideTopbarActions = currentView === "treatments" || currentView === "fiveS";
    topbarActions.classList.toggle("hidden", hideTopbarActions);
    topbarActions.style.display = hideTopbarActions ? "none" : "";
    topbarActions.hidden = hideTopbarActions;
  }
  const departmentSelectWrap = qs("#departmentSelectWrap");
  if (departmentSelectWrap) {
    departmentSelectWrap.classList.toggle("hidden", !isManagement() || consolidatedManagementViews.includes(currentView));
  }
  const departmentSelect = qs("#departmentSelect");
  if (departmentSelect) {
    departmentSelect.disabled = !isManagement() || consolidatedManagementViews.includes(currentView);
  }
}

function renderUser() {
  const dept = currentDepartment();
  const avatar = qs("#userInitials");
  if (avatar) {
    const avatarKey = profileAvatarIcons[currentUser.key] ? currentUser.key : "default";
    avatar.className = `avatar avatar-${avatarKey}`;
    avatar.innerHTML = profileAvatarIcons[avatarKey];
    avatar.setAttribute("aria-label", `Perfil ${currentUser.label}`);
  }
  qs("#userName").textContent = currentUser.label;
  qs("#topDepartment").textContent =
    isManagement() && (currentView === "tv" || currentView === "treatments" || currentView === "analyses")
      ? "Gestão | Todos os departamentos"
      : isManagement()
        ? `Gestão | Visualizando ${dept.label}`
        : dept.label;
  qs("#launchDepartment").textContent = dept.label;
  qs("#actionDepartment").textContent = dept.label;
}

function renderIndicatorOptions() {
  const departmentIndicatorNames = currentDepartment().indicators.map((indicator) => indicator.name);
  const launchSelect = qs("#launchIndicator");
  const actionSelect = qs("#actionIndicator");
  const currentLaunchIndicator = launchSelect?.value || "";
  const currentActionIndicator = actionSelect?.value || "";
  const launchOptions = departmentIndicatorNames
    .map((name) => `<option>${escapeHtml(name)}</option>`)
    .join("");
  const actionIndicatorNames =
    actionExtraIndicatorDepartments.has(selectedDepartmentKey)
      ? [...departmentIndicatorNames, actionExtraIndicatorName]
      : departmentIndicatorNames;
  const actionOptions = uniqueIndicatorNames(actionIndicatorNames)
    .map((name) => `<option>${escapeHtml(name)}</option>`)
    .join("");

  if (launchSelect) {
    launchSelect.innerHTML = launchOptions;
    if (departmentIndicatorNames.includes(currentLaunchIndicator)) {
      launchSelect.value = currentLaunchIndicator;
    }
  }

  if (actionSelect) {
    actionSelect.innerHTML = actionOptions;
    if (actionIndicatorNames.includes(currentActionIndicator)) {
      actionSelect.value = currentActionIndicator;
    }
  }

  syncLaunchFormByIndicator();
}

function resetLaunchFormState() {
  editingLaunchId = null;
  const submitButton = qs("#launchSubmitButton");
  const cancelButton = qs("#launchCancelEdit");
  if (submitButton) submitButton.textContent = "Salvar resultado";
  if (cancelButton) cancelButton.classList.add("hidden");
}

function resetActionFormState() {
  editingRecordId = null;
  const submitButton = qs("#actionSubmitButton");
  const cancelButton = qs("#actionCancelEdit");
  if (submitButton) submitButton.textContent = "Registrar";
  if (cancelButton) cancelButton.classList.add("hidden");
}

function renderSummary() {
  const department = currentDepartment();
  const counts = statusCounts(department.indicators, department);
  qs("#departmentSummary").innerHTML = `
    <div class="status-card"><span class="status-dot ok"></span>${counts.success} dentro da meta</div>
    <div class="status-card"><span class="status-dot warn"></span>${counts.warn} em atenção</div>
    <div class="status-card"><span class="status-dot danger"></span>${counts.danger} críticos</div>
  `;
}

function renderKpis() {
  const department = currentDepartment();
  qs("#departmentKpis").innerHTML = department.indicators
    .map((indicator) => {
      const cardValue = getIndicatorAverageValue(indicator, department);
      const status = getStatus(indicator, department, cardValue);
      const details = getCardDetails(indicator);
      const isTrackingIndicator = indicator.goal === "tracking";
      return `
        <article class="kpi-card">
          <header>
            <h3>${escapeHtml(indicator.name)}</h3>
            <span class="pill ${status}">${escapeHtml(indicatorStatusLabel(indicator, department))}</span>
          </header>
          <strong class="kpi-value">${formatMetric(indicator, cardValue)}</strong>
          ${
            isTrackingIndicator
              ? ""
              : `<div class="kpi-meta">
                  <span>${formatTarget(indicator)}</span>
                  <strong>${getGoalDirectionLabel(indicator)}</strong>
                </div>`
          }
          ${
            details.length
              ? `<div class="kpi-details">${details
                  .map(([label, value]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(value)}</span>`)
                  .join("")}</div>`
              : ""
          }
        </article>
      `;
    })
    .join("");
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawLineChart(canvas, history, lineColor, indicator, options = {}) {
  if (!canvas || history.length === 0) return { points: [] };
  const hoverIndex = Number.isInteger(options.hoverIndex) ? options.hoverIndex : null;

  const rect = canvas.getBoundingClientRect();
  const width = Math.max(220, Math.round(rect.width || 560));
  const height = Math.max(180, Math.round(rect.height || 220));
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const renderWidth = Math.round(width * dpr);
  const renderHeight = Math.round(height * dpr);

  if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
    canvas.width = renderWidth;
    canvas.height = renderHeight;
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const padding = { top: 24, right: 16, bottom: 30, left: 42 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = history.map((item) => Number(item.value));
  const rawMax = Math.max(...values);
  const rawMin = Math.min(...values);
  const rawRange = rawMax - rawMin;
  const dynamicPadding = rawRange === 0 ? Math.max(Math.abs(rawMax) * 0.08, 1) : rawRange * 0.14;
  const chartMin = rawMin - dynamicPadding;
  const chartMax = rawMax + dynamicPadding;
  const domainRange = chartMax - chartMin || 1;
  const xStep = history.length > 1 ? plotWidth / (history.length - 1) : 0;
  const yFor = (value) => padding.top + ((chartMax - Number(value)) / domainRange) * plotHeight;
  const points = history.map((item, index) => ({
    x: padding.left + xStep * index,
    y: yFor(item.value),
  }));

  ctx.fillStyle = "#111826";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#273248";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  const gradient = ctx.createLinearGradient(0, padding.top, width, height);
  gradient.addColorStop(0, "#88a8ff");
  gradient.addColorStop(1, lineColor);

  ctx.beginPath();
  points.forEach((point, index) => {
    const { x, y } = point;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();

  points.forEach((point, index) => {
    const { x, y } = point;
    const pointRadius = hoverIndex === index ? 5 : 3.8;
    ctx.fillStyle = "#111826";
    ctx.beginPath();
    ctx.arc(x, y, pointRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  const pointCount = history.length;
  const dateLabelEvery = pointCount <= 8 ? 1 : pointCount <= 16 ? 2 : Math.ceil(pointCount / 8);
  const valueLabelIndexes = new Set();

  if (pointCount <= 9) {
    for (let i = 0; i < pointCount; i += 1) valueLabelIndexes.add(i);
  } else if (pointCount <= 20) {
    const valueStep = Math.ceil(pointCount / 5);
    for (let i = 0; i < pointCount; i += valueStep) valueLabelIndexes.add(i);
    valueLabelIndexes.add(pointCount - 1);
  } else {
    valueLabelIndexes.add(0);
    valueLabelIndexes.add(Math.floor((pointCount - 1) / 2));
    valueLabelIndexes.add(pointCount - 1);
  }

  ctx.font = "700 10px Roboto, Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  history.forEach((item, index) => {
    const { x } = points[index];
    const isVisibleDate = index % dateLabelEvery === 0 || index === pointCount - 1;
    if (!isVisibleDate) return;

    const dateText = formatShortDate(item.date);
    ctx.fillStyle = "#95a4bd";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(dateText, x, height - 8);
  });

  valueLabelIndexes.forEach((pointIndex) => {
    const point = points[pointIndex];
    const item = history[pointIndex];
    if (!point || !item) return;

    const valueText = formatChartValue(indicator, item.value);
    ctx.font = "700 9.5px Roboto, Inter, system-ui, sans-serif";
    const textWidth = ctx.measureText(valueText).width;
    const tagWidth = textWidth + 10;
    const tagHeight = 16;
    const tagX = Math.min(
      Math.max(point.x - tagWidth / 2, padding.left),
      width - padding.right - tagWidth,
    );
    const preferredY = point.y - 22;
    const tagY = preferredY <= padding.top + 2 ? point.y + 8 : preferredY;

    drawRoundedRect(ctx, tagX, tagY, tagWidth, tagHeight, 6);
    ctx.fillStyle = "rgba(17, 24, 38, 0.94)";
    ctx.fill();
    ctx.strokeStyle = "#33445f";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#e9effb";
    ctx.textBaseline = "middle";
    ctx.fillText(valueText, tagX + tagWidth / 2, tagY + tagHeight / 2 + 0.2);
  });

  if (hoverIndex !== null && points[hoverIndex]) {
    const point = points[hoverIndex];
    const item = history[hoverIndex];

    ctx.strokeStyle = "rgba(149, 171, 211, 0.34)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(point.x, padding.top);
    ctx.lineTo(point.x, height - padding.bottom + 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const dateText = formatDate(item.date);
    const valueText = formatChartValue(indicator, item.value);
    const tooltipText = `${dateText} | ${valueText}`;
    ctx.font = "700 10px Roboto, Inter, system-ui, sans-serif";
    const textWidth = ctx.measureText(tooltipText).width;
    const tooltipWidth = textWidth + 14;
    const tooltipHeight = 20;
    const tooltipX = Math.min(
      Math.max(point.x - tooltipWidth / 2, padding.left),
      width - padding.right - tooltipWidth,
    );
    const tooltipY = Math.max(padding.top + 4, point.y - 30);

    drawRoundedRect(ctx, tooltipX, tooltipY, tooltipWidth, tooltipHeight, 6);
    ctx.fillStyle = "rgba(17, 24, 38, 0.97)";
    ctx.fill();
    ctx.strokeStyle = "#33445f";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#edf3ff";
    ctx.textBaseline = "middle";
    ctx.fillText(tooltipText, tooltipX + tooltipWidth / 2, tooltipY + tooltipHeight / 2 + 0.2);
  }

  return { points };
}

function renderLineCharts() {
  const department = currentDepartment();
  const target = qs("#lineCharts");
  if (!target) return;

  const indicatorCards = department.indicators
    .map((indicator, index) => {
      const history = getFilteredHistory(indicator, department);
      const accumulatedValue = getIndicatorAccumulatedValue(indicator, department);
      const isTrackingIndicator = indicator.goal === "tracking";
      return `
        <article class="line-card">
          <header>
            <h3>${escapeHtml(indicator.name)}</h3>
            <span class="pill ${getStatus(indicator, department, accumulatedValue)}">${escapeHtml(indicatorStatusLabel(
        indicator,
        department,
      ))}</span>
          </header>
          <div class="line-values">
            <span class="line-value"><b>Acumulado</b>${formatMetric(indicator, accumulatedValue)}</span>
            ${
              isTrackingIndicator
                ? ""
                : `<span class="line-value"><b>Meta</b>${formatTargetValue(indicator)}</span>`
            }
          </div>
          ${
            history.length > 0
              ? `<canvas class="line-canvas" id="lineChart-${index}" width="560" height="220" aria-label="Gráfico ${escapeAttribute(indicator.name)}"></canvas>`
              : `<div class="line-empty-state">Sem registros no período selecionado.</div>`
          }
        </article>
      `;
    })
    .join("");

  target.innerHTML = indicatorCards;

  department.indicators.forEach((indicator, index) => {
    const history = getFilteredHistory(indicator, department);
    const status = getStatus(indicator, department);
    const canvas = qs(`#lineChart-${index}`);
    if (!canvas || history.length === 0) return;
    let drawState = drawLineChart(canvas, history, statusColor[status], indicator);
    let hoverIndex = null;

    const redraw = () => {
      drawState = drawLineChart(canvas, history, statusColor[status], indicator, { hoverIndex });
    };

    const handlePointerMove = (event) => {
      if (!drawState.points.length) return;
      const rect = canvas.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      let nearestIndex = null;
      let nearestDistance = Infinity;

      drawState.points.forEach((point, pointIndex) => {
        const distance = Math.hypot(pointerX - point.x, pointerY - point.y);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = pointIndex;
        }
      });

      const nextHoverIndex = nearestDistance <= 16 ? nearestIndex : null;
      if (nextHoverIndex === hoverIndex) return;

      hoverIndex = nextHoverIndex;
      canvas.style.cursor = hoverIndex === null ? "default" : "pointer";
      redraw();
    };

    canvas.addEventListener("mousemove", handlePointerMove);
    canvas.addEventListener("mouseleave", () => {
      if (hoverIndex === null) return;
      hoverIndex = null;
      canvas.style.cursor = "default";
      redraw();
    });
  });

  qs("#periodBadge").textContent = getActivePeriodLabel();
}

function renderLaunches() {
  const launches = getFilteredLaunches(currentDepartment());
  const listElement = qs("#activityList");
  qs("#launchCounter").textContent = String(launches.length);

  if (launches.length === 0) {
    listElement.innerHTML = `
      <article class="record-card">
        <p>Sem lançamentos para o período selecionado.</p>
      </article>
    `;
    return;
  }

  listElement.innerHTML = launches
    .map((launch) => {
      const comment = String(launch.comment || "").trim();
      return `
        <article class="record-card launch-history-item">
          <div class="launch-history-main">
            <div class="launch-history-info">
              <strong>${escapeHtml(launch.indicator)}</strong>
              <span class="launch-history-meta">${formatDate(launch.date)} · ${escapeHtml(launch.shift)}</span>
              ${comment ? `<p class="launch-history-comment">${escapeHtml(comment)}</p>` : ""}
            </div>
            <div class="record-head-actions launch-history-actions">
              <span class="pill neutral">${escapeHtml(launch.value)}</span>
              <button class="mini-action" data-launch-action="edit" data-launch-id="${escapeAttribute(launch.id)}" type="button">Editar</button>
              <button class="mini-action danger" data-launch-action="delete" data-launch-id="${escapeAttribute(launch.id)}" type="button">Excluir</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderLaunchTable() {
  const department = currentDepartment();
  const launches = getFilteredLaunches(department);
  const tableBody = qs("#launchTableBody");
  if (!tableBody) return;

  const periodLabel = getActivePeriodLabel();
  qs("#launchTablePeriod").textContent = periodLabel;

  const syncSelectFilter = (selector, values, formatLabel = (value) => value) => {
    const input = qs(selector);
    if (!input) return;
    const filterKey = input.dataset.launchFilter;
    const nextOptions = values
      .map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(formatLabel(value))}</option>`)
      .join("");
    input.innerHTML = `<option value="">Todos</option>${nextOptions}`;
    input.value = launchTableFilters[filterKey] || "";
    if (input.value !== (launchTableFilters[filterKey] || "")) {
      launchTableFilters[filterKey] = input.value;
    }
  };

  const dates = Array.from(new Set(launches.map((launch) => launch.date).filter(Boolean))).sort((a, b) => {
    const leftDate = toDateOrNull(a);
    const rightDate = toDateOrNull(b);
    if (!leftDate || !rightDate) return 0;
    return rightDate - leftDate;
  });
  const indicators = Array.from(new Set(launches.map((launch) => launch.indicator).filter(Boolean)));
  const values = Array.from(new Set(launches.map((launch) => launch.value).filter(Boolean)));
  const shifts = Array.from(new Set(launches.map((launch) => launch.shift).filter(Boolean)));

  syncSelectFilter("#launchFilterDate", dates, (value) => formatDate(value));
  syncSelectFilter("#launchFilterIndicator", indicators);
  syncSelectFilter("#launchFilterValue", values);
  syncSelectFilter("#launchFilterShift", shifts);

  const launchRows = launches.map((launch) => {
    const indicator = department.indicators.find((item) => item.name === launch.indicator);
    const numericValue = indicator ? getLaunchNumericValue(launch, indicator) : NaN;
    const status = indicator && Number.isFinite(numericValue) ? getStatus(indicator, department, numericValue) : "warn";
    return {
      launch,
      indicator,
      status,
      commentText: launch.comment || "",
    };
  });

  const filteredRows = launchRows.filter((row) => {
    if (launchTableFilters.date && row.launch.date !== launchTableFilters.date) return false;
    if (launchTableFilters.shift && row.launch.shift !== launchTableFilters.shift) return false;
    if (launchTableFilters.status && row.status !== launchTableFilters.status) return false;
    if (launchTableFilters.indicator && row.launch.indicator !== launchTableFilters.indicator) return false;
    if (launchTableFilters.value && row.launch.value !== launchTableFilters.value) return false;
    if (!textMatchesFilter(row.commentText, launchTableFilters.comment)) return false;
    return true;
  });

  const indicatorsInPeriod = new Set(filteredRows.map((row) => row.launch.indicator)).size;
  const lastDate = maxDateFromValues(filteredRows.map((row) => row.launch.date));
  const lastUpdate = lastDate ? new Intl.DateTimeFormat("pt-BR").format(lastDate) : "-";
  const warningCount = filteredRows.reduce((count, row) => (row.status === "danger" ? count + 1 : count), 0);

  qs("#launchTableSummary").innerHTML = `
    <div class="status-card"><span class="status-dot ok"></span>${filteredRows.length} lançamentos no período</div>
    <div class="status-card"><span class="status-dot warn"></span>${indicatorsInPeriod} indicadores atualizados</div>
    <div class="status-card"><span class="status-dot danger"></span>${warningCount} fora da meta</div>
    <div class="status-card"><span class="status-dot ok"></span>Última atualização: ${lastUpdate}</div>
  `;

  if (filteredRows.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-row">Sem lançamentos para os filtros selecionados.</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = filteredRows
    .map(({ launch, indicator, status }) => {
      return `
        <tr>
          <td>${formatDate(launch.date)}</td>
          <td>${escapeHtml(launch.indicator)}</td>
          <td>${escapeHtml(launch.value)}</td>
          <td>${escapeHtml(launch.shift)}</td>
          <td><span class="pill ${status}">${indicator ? statusLabel[status] : "-"}</span></td>
          <td>${escapeHtml(launch.comment || "-")}</td>
        </tr>
      `;
    })
    .join("");
}

function sortIndicatorHistory(indicator) {
  if (!Array.isArray(indicator.history)) return;
  indicator.history = [...indicator.history].sort((left, right) => {
    const leftDate = toDateOrNull(left.date);
    const rightDate = toDateOrNull(right.date);
    if (!leftDate || !rightDate) return 0;
    return leftDate - rightDate;
  });
  indicator.trend = indicator.history.map((item) => Number(item.value));
}

function removeHistoryByLaunchId(launchId, department = currentDepartment()) {
  department.indicators.forEach((indicator) => {
    if (!Array.isArray(indicator.history)) return;
    const nextHistory = indicator.history.filter((entry) => entry.launchId !== launchId);
    if (nextHistory.length === indicator.history.length) return;
    indicator.history = nextHistory;
    indicator.trend = indicator.history.map((item) => Number(item.value));
  });
}

function applyLaunchFormulaDetails(indicator, formulaType, payload) {
  if (!indicator || !payload) return;

  if (formulaType === "divergencia_wms") {
    if (!Number.isFinite(payload.accountingStock) || !Number.isFinite(payload.wmsStock)) return;
    const difference = payload.accountingStock - payload.wmsStock;
    indicator.details = [
      ["Estoque contábil", formatNumber(payload.accountingStock)],
      ["Estoque WMS", formatNumber(payload.wmsStock)],
      ["Diferença", formatNumber(difference)],
    ];
  }

  if (formulaType === "obsolescencia") {
    if (!Number.isFinite(payload.totalItemsStock) || !Number.isFinite(payload.obsoleteItems)) return;
    indicator.details = [
      ["Itens no estoque", formatNumber(payload.totalItemsStock)],
      ["Itens obsoletos", formatNumber(payload.obsoleteItems)],
    ];
  }

  if (formulaType === "ruptura") {
    if (!Number.isFinite(payload.missingItems) || !Number.isFinite(payload.criticalItems)) return;
    indicator.details = [
      ["Itens em falta", formatNumber(payload.missingItems)],
      ["Itens críticos", formatNumber(payload.criticalItems)],
    ];
  }

  if (formulaType === "giro_diario") {
    if (!Number.isFinite(payload.averageStock) || !Number.isFinite(payload.outboundValue)) return;
    indicator.details = [
      ["Estoque médio", `R$ ${formatNumber(payload.averageStock)}`],
      ["Saídas", `R$ ${formatNumber(payload.outboundValue)}`],
    ];
  }
}

function applyAlmoxarifadoLaunchFormulaDetails(indicator, formulaType, payload) {
  if (selectedDepartmentKey !== "almoxarifado") return;
  if (!indicator || !payload) return;

  if (formulaType === "ruptura_estocaveis") {
    if (!Number.isFinite(payload.zeroStockMaintenanceItems) || !Number.isFinite(payload.stockableMaintenanceItems)) return;
    indicator.details = [
      ["Itens zerados", formatNumber(payload.zeroStockMaintenanceItems)],
      ["Materiais estocáveis", formatNumber(payload.stockableMaintenanceItems)],
    ];
  }

  if (formulaType === "acuracidade_uso_consumo") {
    if (!Number.isFinite(payload.correctItems) || !Number.isFinite(payload.totalCountedItems)) return;
    indicator.details = [
      ["Itens corretos", formatNumber(payload.correctItems)],
      ["Itens contados", formatNumber(payload.totalCountedItems)],
    ];
  }

  if (formulaType === "aderencia_estoque_minimo") {
    if (!Number.isFinite(payload.itemsAboveMinimum) || !Number.isFinite(payload.stockableMaintenanceItems)) return;
    indicator.details = [
      ["Itens acima do mínimo", formatNumber(payload.itemsAboveMinimum)],
      ["Materiais estocáveis", formatNumber(payload.stockableMaintenanceItems)],
    ];
  }

  if (formulaType === "cumprimento_plano_inventario") {
    if (!Number.isFinite(payload.countedSkusPeriod) || !Number.isFinite(payload.replenishmentSkus)) return;
    indicator.details = [
      ["SKUs contados", formatNumber(payload.countedSkusPeriod)],
      ["SKUs reposição", formatNumber(payload.replenishmentSkus)],
    ];
  }

  if (formulaType === "slow_mover") {
    if (!Number.isFinite(payload.slowMovingSkus) || !Number.isFinite(payload.replenishmentSkus)) return;
    indicator.details = [
      ["SKUs > 90 dias", formatNumber(payload.slowMovingSkus)],
      ["SKUs reposição", formatNumber(payload.replenishmentSkus)],
    ];
  }

  if (formulaType === "produtividade_individual") {
    if (!Number.isFinite(payload.completedShiftActivities) || !Number.isFinite(payload.collaboratorCount)) return;
    indicator.details = [
      ["Atividades concluídas no turno", formatNumber(payload.completedShiftActivities)],
      ["Colaboradores", formatNumber(payload.collaboratorCount)],
    ];
  }
}

function applyRecebimentoLaunchFormulaDetails(indicator, formulaType, payload) {
  if (!indicator || !payload) return;

  if (formulaType === "recebimento_capacidade_diaria") {
    if (!Number.isFinite(payload.dailyReceipts) || !Number.isFinite(payload.plannedReceiptCapacity)) return;
    indicator.details = [
      ["Recebimentos", formatNumber(payload.dailyReceipts)],
      ["Capacidade planejada", formatNumber(payload.plannedReceiptCapacity)],
    ];
  }

  if (formulaType === "recebimento_otif_fornecedores") {
    if (!Number.isFinite(payload.onTimeSupplierDeliveries) || !Number.isFinite(payload.scheduledSupplierDeliveries)) return;
    indicator.details = [
      ["Entregas no prazo", formatNumber(payload.onTimeSupplierDeliveries)],
      ["Entregas programadas", formatNumber(payload.scheduledSupplierDeliveries)],
    ];
  }

  if (formulaType === "recebimento_eficiencia") {
    if (!Number.isFinite(payload.completedReceiptsOnTime) || !Number.isFinite(payload.totalReceipts)) return;
    indicator.details = [
      ["Recebimentos no prazo", formatNumber(payload.completedReceiptsOnTime)],
      ["Total de recebimentos", formatNumber(payload.totalReceipts)],
    ];
  }

  if (formulaType === "recebimento_tempo_liberacao") {
    if (!Number.isFinite(payload.releaseTotalHours) || !Number.isFinite(payload.releasedReceipts)) return;
    indicator.details = [
      ["Horas totais", `${formatNumber(payload.releaseTotalHours)} h`],
      ["Total de recebimentos", formatNumber(payload.releasedReceipts)],
    ];
  }

  if (formulaType === "recebimento_erros_armazenagem") {
    if (!Number.isFinite(payload.readdressedMaterials) || !Number.isFinite(payload.totalStoredMaterials)) return;
    indicator.details = [
      ["Materiais reendereçados", formatNumber(payload.readdressedMaterials)],
      ["Materiais armazenados", formatNumber(payload.totalStoredMaterials)],
    ];
  }

  if (formulaType === "recebimento_produtividade_individual") {
    if (!Number.isFinite(payload.completedShiftActivities) || !Number.isFinite(payload.collaboratorCount)) return;
    indicator.details = [
      ["Atividades concluídas no turno", formatNumber(payload.completedShiftActivities)],
      ["Colaboradores", formatNumber(payload.collaboratorCount)],
    ];
  }

  if (formulaType === "tempo_recebimento") {
    if (!Number.isFinite(payload.receivedLoads) || !Number.isFinite(payload.receiptHours)) return;
    indicator.details = [
      ["Cargas recebidas", formatNumber(payload.receivedLoads)],
      ["Horas no recebimento", formatNumber(payload.receiptHours)],
    ];
  }

  if (formulaType === "avarias_recebimento") {
    if (!Number.isFinite(payload.receivedUnits) || !Number.isFinite(payload.damagedUnits)) return;
    indicator.details = [
      ["Itens recebidos", formatNumber(payload.receivedUnits)],
      ["Itens avariados", formatNumber(payload.damagedUnits)],
    ];
  }

  if (formulaType === "acuracia_recebimento") {
    if (!Number.isFinite(payload.receivedUnits) || !Number.isFinite(payload.correctUnits)) return;
    indicator.details = [
      ["Itens recebidos", formatNumber(payload.receivedUnits)],
      ["Itens corretos", formatNumber(payload.correctUnits)],
    ];
  }

  if (formulaType === "sla_recebimento") {
    if (!Number.isFinite(payload.receivedLoads) || !Number.isFinite(payload.followUpLoads)) return;
    indicator.details = [
      ["Cargas recebidas", formatNumber(payload.receivedLoads)],
      ["Follow-up em 1h", formatNumber(payload.followUpLoads)],
    ];
  }

  if (formulaType === "giro_recebimento") {
    if (!Number.isFinite(payload.receivedPallets) || !Number.isFinite(payload.palletCapacity)) return;
    indicator.details = [
      ["Volume recebido", formatNumber(payload.receivedPallets)],
      ["Capacidade de posição", formatNumber(payload.palletCapacity)],
    ];
  }
}

function applyEstoqueLaunchFormulaDetails(indicator, formulaType, payload) {
  if (selectedDepartmentKey !== "estoque") return;
  if (!indicator || !payload) return;

  if (formulaType === "estoque_acuracidade_sku") {
    if (!Number.isFinite(payload.correctItems) || !Number.isFinite(payload.totalCountedItems)) return;
    indicator.details = [
      ["Itens corretos", formatNumber(payload.correctItems)],
      ["Itens contados", formatNumber(payload.totalCountedItems)],
    ];
  }

  if (formulaType === "estoque_divergencia_wms_sku") {
    if (!Number.isFinite(payload.divergentSkus) || !Number.isFinite(payload.totalSkus)) return;
    indicator.details = [
      ["SKUs divergentes", formatNumber(payload.divergentSkus)],
      ["Total de SKUs", formatNumber(payload.totalSkus)],
    ];
  }

  if (formulaType === "estoque_cumprimento_plano_inventario") {
    if (!Number.isFinite(payload.countedSkusPeriod) || !Number.isFinite(payload.replenishmentSkus)) return;
    indicator.details = [
      ["SKUs contados", formatNumber(payload.countedSkusPeriod)],
      ["SKUs reposição", formatNumber(payload.replenishmentSkus)],
    ];
  }

  if (formulaType === "estoque_divergencias_tratadas") {
    if (!Number.isFinite(payload.treatedDivergencesOnTime) || !Number.isFinite(payload.totalDivergences)) return;
    indicator.details = [
      ["Divergências tratadas", formatNumber(payload.treatedDivergencesOnTime)],
      ["Total de divergências", formatNumber(payload.totalDivergences)],
    ];
  }

  if (formulaType === "estoque_slow_mover") {
    if (!Number.isFinite(payload.slowMovingSkus) || !Number.isFinite(payload.totalStockSkus)) return;
    indicator.details = [
      ["SKUs > 90 dias", formatNumber(payload.slowMovingSkus)],
      ["Total de SKUs", formatNumber(payload.totalStockSkus)],
    ];
  }

  if (formulaType === "estoque_produtividade_individual_contagens") {
    if (!Number.isFinite(payload.dailyCountedSkus) || !Number.isFinite(payload.collaboratorCount)) return;
    indicator.details = [
      ["Contagens realizadas", formatNumber(payload.dailyCountedSkus)],
      ["Colaboradores", formatNumber(payload.collaboratorCount)],
    ];
  }

  if (formulaType === "acuracidade") {
    if (!Number.isFinite(payload.correctItems) || !Number.isFinite(payload.inventoriedItems)) return;
    indicator.details = [
      ["Itens corretos", formatNumber(payload.correctItems)],
      ["SKUs inventariados", formatNumber(payload.inventoriedItems)],
    ];
  }

  if (formulaType === "perdas_inventario") {
    if (!Number.isFinite(payload.lossItems) || !Number.isFinite(payload.inventoriedItems)) return;
    indicator.details = [
      ["Perdas no estoque", formatNumber(payload.lossItems)],
      ["Itens inventariados", formatNumber(payload.inventoriedItems)],
    ];
  }

  if (formulaType === "produtividade_contagens") {
    if (!Number.isFinite(payload.countedItems) || !Number.isFinite(payload.collaboratorCount)) return;
    indicator.details = [
      ["Itens contados", formatNumber(payload.countedItems)],
      ["Colaboradores", formatNumber(payload.collaboratorCount)],
    ];
  }
}

function applySecosLaunchFormulaDetails(indicator, formulaType, payload) {
  if (selectedDepartmentKey !== "secos") return;
  if (!indicator || !payload) return;

  if (formulaType === "secos_perdas_picks") {
    if (!Number.isFinite(payload.adjustedValue) || !Number.isFinite(payload.totalStockValue)) return;
    indicator.details = [
      ["Valor ajustado", `R$ ${formatNumber(payload.adjustedValue)}`],
      ["Valor do estoque", `R$ ${formatNumber(payload.totalStockValue)}`],
    ];
  }

  if (formulaType === "secos_ruptura_embalagens") {
    if (!Number.isFinite(payload.impactedOps)) return;
    indicator.details = [["OPs impactadas", formatNumber(payload.impactedOps)]];
  }

  if (formulaType === "secos_ops_atendidas_erradas") {
    if (!Number.isFinite(payload.wrongOps) || !Number.isFinite(payload.requestedOps)) return;
    indicator.details = [
      ["OPs erradas", formatNumber(payload.wrongOps)],
      ["OPs solicitadas", formatNumber(payload.requestedOps)],
    ];
  }

  if (formulaType === "secos_erros_movimentacao") {
    if (!Number.isFinite(payload.movementErrors) || !Number.isFinite(payload.movedItems)) return;
    indicator.details = [
      ["Erros de movimentação", formatNumber(payload.movementErrors)],
      ["Itens movimentados", formatNumber(payload.movedItems)],
    ];
  }

  if (formulaType === "secos_erros_expedicao_fabrica") {
    if (!Number.isFinite(payload.expeditionErrorValue)) return;
    indicator.details = [["Sobras e faltas", `R$ ${formatNumber(payload.expeditionErrorValue)}`]];
  }

  if (formulaType === "secos_tempo_carregamento_carretas") {
    if (!Number.isFinite(payload.loadedTrucks) || !Number.isFinite(payload.loadingTotalMinutes)) return;
    indicator.details = [
      ["Carretas carregadas", formatNumber(payload.loadedTrucks)],
      ["Tempo total", `${formatNumber(payload.loadingTotalMinutes)} min`],
    ];
  }

  if (formulaType === "secos_produtividade_individual") {
    if (!Number.isFinite(payload.completedShiftActivities) || !Number.isFinite(payload.collaboratorCount)) return;
    indicator.details = [
      ["Atividades concluídas", formatNumber(payload.completedShiftActivities)],
      ["Colaboradores", formatNumber(payload.collaboratorCount)],
    ];
  }

  if (formulaType === "movimentacao_colaborador") {
    if (!Number.isFinite(payload.movedItems) || !Number.isFinite(payload.collaboratorCount)) return;
    indicator.details = [
      ["Itens movimentados", formatNumber(payload.movedItems)],
      ["Colaboradores", formatNumber(payload.collaboratorCount)],
    ];
  }

  if (formulaType === "erros_movimentacao") {
    if (!Number.isFinite(payload.movedItems) || !Number.isFinite(payload.movementErrors)) return;
    indicator.details = [
      ["Itens movimentados", formatNumber(payload.movedItems)],
      ["Erros de movimentação", formatNumber(payload.movementErrors)],
    ];
  }

  if (formulaType === "avarias_movimentacao") {
    if (!Number.isFinite(payload.movedItems) || !Number.isFinite(payload.damagedMovedItems)) return;
    indicator.details = [
      ["Itens movimentados", formatNumber(payload.movedItems)],
      ["Itens avariados", formatNumber(payload.damagedMovedItems)],
    ];
  }

  if (formulaType === "espera_carregamento") {
    if (!Number.isFinite(payload.waitMinutes)) return;
    indicator.details = [["Tempo de espera", `${formatNumber(payload.waitMinutes)} min`]];
  }

  if (formulaType === "tempo_carregamento") {
    if (!Number.isFinite(payload.loadedTrucks) || !Number.isFinite(payload.loadingTotalMinutes)) return;
    indicator.details = [
      ["Carretas carregadas", formatNumber(payload.loadedTrucks)],
      ["Tempo total", `${formatNumber(payload.loadingTotalMinutes)} min`],
    ];
  }
}

function applyQuimicasLaunchFormulaDetails(indicator, formulaType, payload) {
  if (selectedDepartmentKey !== "quimicas") return;
  if (!indicator || !payload) return;

  if (formulaType === "quimica_confiabilidade_abastecimento") {
    if (!Number.isFinite(payload.chemSupplyOkOps) || !Number.isFinite(payload.chemTotalOps)) return;
    indicator.details = [
      ["OPs sem atraso/divergência", formatNumber(payload.chemSupplyOkOps)],
      ["Total de OPs", formatNumber(payload.chemTotalOps)],
    ];
  }

  if (formulaType === "quimica_eficiencia_atendimento_ops") {
    if (!Number.isFinite(payload.chemDeliveredOps) || !Number.isFinite(payload.chemPlannedOps)) return;
    indicator.details = [
      ["OPs entregues", formatNumber(payload.chemDeliveredOps)],
      ["OPs previstas", formatNumber(payload.chemPlannedOps)],
    ];
  }

  if (formulaType === "quimica_retrabalho_separacao") {
    if (!Number.isFinite(payload.chemReworkOps) || !Number.isFinite(payload.chemSeparatedOps)) return;
    indicator.details = [
      ["Retrabalhos/repesagens", formatNumber(payload.chemReworkOps)],
      ["OPs separadas", formatNumber(payload.chemSeparatedOps)],
    ];
  }

  if (formulaType === "quimica_giro_kanban") {
    if (!Number.isFinite(payload.chemKanbanOver7DaysOps) || !Number.isFinite(payload.chemKanbanTotalOps)) return;
    indicator.details = [
      ["OPs > 7 dias", formatNumber(payload.chemKanbanOver7DaysOps)],
      ["Total no Kanban", formatNumber(payload.chemKanbanTotalOps)],
    ];
  }

  if (formulaType === "quimica_produtividade_ops_separadas") {
    if (!Number.isFinite(payload.chemShiftDeliveredOps) || !Number.isFinite(payload.chemShiftTargetOps)) return;
    indicator.details = [
      ["OPs entregues no turno", formatNumber(payload.chemShiftDeliveredOps)],
      ["Meta do turno", formatNumber(payload.chemShiftTargetOps)],
    ];
  }

  if (formulaType === "quimica_produtividade_individual") {
    if (!Number.isFinite(payload.completedShiftActivities) || !Number.isFinite(payload.collaboratorCount)) return;
    indicator.details = [
      ["Atividades concluídas", formatNumber(payload.completedShiftActivities)],
      ["Colaboradores", formatNumber(payload.collaboratorCount)],
    ];
  }
}

function extractFormulaPayload(formData, formulaType) {
  if (!formulaType) return null;

  if (formulaType === "acuracidade") {
    return {
      correctItems: parseLocalizedNumber(formData.get("correctItems")),
      inventoriedItems: parseLocalizedNumber(formData.get("inventoriedItems")),
    };
  }
  if (formulaType === "divergencia_wms") {
    return {
      accountingStock: parseLocalizedNumber(formData.get("accountingStock")),
      wmsStock: parseLocalizedNumber(formData.get("wmsStock")),
    };
  }
  if (formulaType === "obsolescencia") {
    return {
      totalItemsStock: parseLocalizedNumber(formData.get("totalItemsStock")),
      obsoleteItems: parseLocalizedNumber(formData.get("obsoleteItems")),
    };
  }
  if (formulaType === "ruptura") {
    return {
      missingItems: parseLocalizedNumber(formData.get("missingItems")),
      criticalItems: parseLocalizedNumber(formData.get("criticalItems")),
    };
  }
  if (formulaType === "giro_diario") {
    const initialStock = parseLocalizedNumber(formData.get("initialStock"));
    const entriesValue = parseLocalizedNumber(formData.get("entriesValue"));
    const outboundValue = parseLocalizedNumber(formData.get("outboundValue"));
    const finalStock = initialStock + entriesValue - outboundValue;
    const averageStock = (initialStock + finalStock) / 2;
    return {
      initialStock,
      entriesValue,
      outboundValue,
      finalStock,
      averageStock,
    };
  }
  if (formulaType === "recebimento_capacidade_diaria") {
    return {
      dailyReceipts: parseLocalizedNumber(formData.get("dailyReceipts")),
      plannedReceiptCapacity: parseLocalizedNumber(formData.get("plannedReceiptCapacity")),
    };
  }
  if (formulaType === "recebimento_otif_fornecedores") {
    return {
      onTimeSupplierDeliveries: parseLocalizedNumber(formData.get("onTimeSupplierDeliveries")),
      scheduledSupplierDeliveries: parseLocalizedNumber(formData.get("scheduledSupplierDeliveries")),
    };
  }
  if (formulaType === "recebimento_eficiencia") {
    return {
      completedReceiptsOnTime: parseLocalizedNumber(formData.get("completedReceiptsOnTime")),
      totalReceipts: parseLocalizedNumber(formData.get("totalReceipts")),
    };
  }
  if (formulaType === "recebimento_tempo_liberacao") {
    return {
      releaseTotalHours: parseLocalizedNumber(formData.get("releaseTotalHours")),
      releasedReceipts: parseLocalizedNumber(formData.get("releasedReceipts")),
    };
  }
  if (formulaType === "recebimento_erros_armazenagem") {
    return {
      readdressedMaterials: parseLocalizedNumber(formData.get("readdressedMaterials")),
      totalStoredMaterials: parseLocalizedNumber(formData.get("totalStoredMaterials")),
    };
  }
  if (formulaType === "recebimento_produtividade_individual") {
    return {
      completedShiftActivities: parseLocalizedNumber(formData.get("completedShiftActivities")),
      collaboratorCount: parseLocalizedNumber(formData.get("collaboratorCount")),
    };
  }
  if (formulaType === "ruptura_estocaveis") {
    return {
      zeroStockMaintenanceItems: parseLocalizedNumber(formData.get("zeroStockMaintenanceItems")),
      stockableMaintenanceItems: parseLocalizedNumber(formData.get("stockableMaintenanceItems")),
    };
  }
  if (formulaType === "acuracidade_uso_consumo") {
    return {
      correctItems: parseLocalizedNumber(formData.get("correctItems")),
      totalCountedItems: parseLocalizedNumber(formData.get("totalCountedItems")),
    };
  }
  if (formulaType === "estoque_acuracidade_sku") {
    return {
      correctItems: parseLocalizedNumber(formData.get("correctItems")),
      totalCountedItems: parseLocalizedNumber(formData.get("totalCountedItems")),
    };
  }
  if (formulaType === "estoque_divergencia_wms_sku") {
    return {
      divergentSkus: parseLocalizedNumber(formData.get("divergentSkus")),
      totalSkus: parseLocalizedNumber(formData.get("totalSkus")),
    };
  }
  if (formulaType === "aderencia_estoque_minimo") {
    return {
      itemsAboveMinimum: parseLocalizedNumber(formData.get("itemsAboveMinimum")),
      stockableMaintenanceItems: parseLocalizedNumber(formData.get("stockableMaintenanceItems")),
    };
  }
  if (formulaType === "cumprimento_plano_inventario") {
    return {
      countedSkusPeriod: parseLocalizedNumber(formData.get("countedSkusPeriod")),
      replenishmentSkus: parseLocalizedNumber(formData.get("replenishmentSkus")),
    };
  }
  if (formulaType === "estoque_cumprimento_plano_inventario") {
    return {
      countedSkusPeriod: parseLocalizedNumber(formData.get("countedSkusPeriod")),
      replenishmentSkus: parseLocalizedNumber(formData.get("replenishmentSkus")),
    };
  }
  if (formulaType === "estoque_divergencias_tratadas") {
    return {
      treatedDivergencesOnTime: parseLocalizedNumber(formData.get("treatedDivergencesOnTime")),
      totalDivergences: parseLocalizedNumber(formData.get("totalDivergences")),
    };
  }
  if (formulaType === "slow_mover") {
    return {
      slowMovingSkus: parseLocalizedNumber(formData.get("slowMovingSkus")),
      replenishmentSkus: parseLocalizedNumber(formData.get("replenishmentSkus")),
    };
  }
  if (formulaType === "estoque_slow_mover") {
    return {
      slowMovingSkus: parseLocalizedNumber(formData.get("slowMovingSkus")),
      totalStockSkus: parseLocalizedNumber(formData.get("totalStockSkus")),
    };
  }
  if (formulaType === "produtividade_individual") {
    return {
      completedShiftActivities: parseLocalizedNumber(formData.get("completedShiftActivities")),
      collaboratorCount: parseLocalizedNumber(formData.get("collaboratorCount")),
    };
  }
  if (formulaType === "estoque_produtividade_individual_contagens") {
    return {
      dailyCountedSkus: parseLocalizedNumber(formData.get("dailyCountedSkus")),
      collaboratorCount: parseLocalizedNumber(formData.get("collaboratorCount")),
    };
  }
  if (formulaType === "tempo_recebimento") {
    return {
      receivedLoads: parseLocalizedNumber(formData.get("receivedLoads")),
      receiptHours: parseLocalizedNumber(formData.get("receiptHours")),
    };
  }
  if (formulaType === "avarias_recebimento") {
    return {
      receivedUnits: parseLocalizedNumber(formData.get("receivedUnits")),
      damagedUnits: parseLocalizedNumber(formData.get("damagedUnits")),
    };
  }
  if (formulaType === "acuracia_recebimento") {
    return {
      receivedUnits: parseLocalizedNumber(formData.get("receivedUnits")),
      correctUnits: parseLocalizedNumber(formData.get("correctUnits")),
    };
  }
  if (formulaType === "sla_recebimento") {
    return {
      receivedLoads: parseLocalizedNumber(formData.get("receivedLoads")),
      followUpLoads: parseLocalizedNumber(formData.get("followUpLoads")),
    };
  }
  if (formulaType === "giro_recebimento") {
    return {
      receivedPallets: parseLocalizedNumber(formData.get("receivedPallets")),
      palletCapacity: parseLocalizedNumber(formData.get("palletCapacity")),
    };
  }
  if (formulaType === "produtividade_contagens") {
    return {
      countedItems: parseLocalizedNumber(formData.get("countedItems")),
      collaboratorCount: parseLocalizedNumber(formData.get("collaboratorCount")),
    };
  }
  if (formulaType === "perdas_inventario") {
    return {
      lossItems: parseLocalizedNumber(formData.get("lossItems")),
      inventoriedItems: parseLocalizedNumber(formData.get("inventoriedItems")),
    };
  }
  if (formulaType === "secos_perdas_picks") {
    return {
      adjustedValue: parseLocalizedNumber(formData.get("adjustedValue")),
      totalStockValue: parseLocalizedNumber(formData.get("totalStockValue")),
    };
  }
  if (formulaType === "secos_ruptura_embalagens") {
    return {
      impactedOps: parseLocalizedNumber(formData.get("impactedOps")),
    };
  }
  if (formulaType === "secos_ops_atendidas_erradas") {
    return {
      wrongOps: parseLocalizedNumber(formData.get("wrongOps")),
      requestedOps: parseLocalizedNumber(formData.get("requestedOps")),
    };
  }
  if (formulaType === "secos_erros_movimentacao") {
    return {
      movementErrors: parseLocalizedNumber(formData.get("movementErrors")),
      movedItems: parseLocalizedNumber(formData.get("movedItems")),
    };
  }
  if (formulaType === "secos_erros_expedicao_fabrica") {
    return {
      expeditionErrorValue: parseLocalizedNumber(formData.get("expeditionErrorValue")),
    };
  }
  if (formulaType === "secos_tempo_carregamento_carretas") {
    return {
      loadedTrucks: parseLocalizedNumber(formData.get("loadedTrucks")),
      loadingTotalMinutes: parseLocalizedNumber(formData.get("loadingTotalMinutes")),
    };
  }
  if (formulaType === "secos_produtividade_individual") {
    return {
      completedShiftActivities: parseLocalizedNumber(formData.get("completedShiftActivities")),
      collaboratorCount: parseLocalizedNumber(formData.get("collaboratorCount")),
    };
  }
  if (formulaType === "quimica_confiabilidade_abastecimento") {
    return {
      chemSupplyOkOps: parseLocalizedNumber(formData.get("chemSupplyOkOps")),
      chemTotalOps: parseLocalizedNumber(formData.get("chemTotalOps")),
    };
  }
  if (formulaType === "quimica_eficiencia_atendimento_ops") {
    return {
      chemDeliveredOps: parseLocalizedNumber(formData.get("chemDeliveredOps")),
      chemPlannedOps: parseLocalizedNumber(formData.get("chemPlannedOps")),
    };
  }
  if (formulaType === "quimica_retrabalho_separacao") {
    return {
      chemReworkOps: parseLocalizedNumber(formData.get("chemReworkOps")),
      chemSeparatedOps: parseLocalizedNumber(formData.get("chemSeparatedOps")),
    };
  }
  if (formulaType === "quimica_giro_kanban") {
    return {
      chemKanbanOver7DaysOps: parseLocalizedNumber(formData.get("chemKanbanOver7DaysOps")),
      chemKanbanTotalOps: parseLocalizedNumber(formData.get("chemKanbanTotalOps")),
    };
  }
  if (formulaType === "quimica_produtividade_ops_separadas") {
    return {
      chemShiftDeliveredOps: parseLocalizedNumber(formData.get("chemShiftDeliveredOps")),
      chemShiftTargetOps: parseLocalizedNumber(formData.get("chemShiftTargetOps")),
    };
  }
  if (formulaType === "quimica_produtividade_individual") {
    return {
      completedShiftActivities: parseLocalizedNumber(formData.get("completedShiftActivities")),
      collaboratorCount: parseLocalizedNumber(formData.get("collaboratorCount")),
    };
  }
  if (formulaType === "movimentacao_colaborador") {
    return {
      movedItems: parseLocalizedNumber(formData.get("movedItems")),
      collaboratorCount: parseLocalizedNumber(formData.get("collaboratorCount")),
    };
  }
  if (formulaType === "erros_movimentacao") {
    return {
      movedItems: parseLocalizedNumber(formData.get("movedItems")),
      movementErrors: parseLocalizedNumber(formData.get("movementErrors")),
    };
  }
  if (formulaType === "avarias_movimentacao") {
    return {
      movedItems: parseLocalizedNumber(formData.get("movedItems")),
      damagedMovedItems: parseLocalizedNumber(formData.get("damagedMovedItems")),
    };
  }
  if (formulaType === "espera_carregamento") {
    return {
      waitMinutes: parseLocalizedNumber(formData.get("waitMinutes")),
    };
  }
  if (formulaType === "tempo_carregamento") {
    return {
      loadedTrucks: parseLocalizedNumber(formData.get("loadedTrucks")),
      loadingTotalMinutes: parseLocalizedNumber(formData.get("loadingTotalMinutes")),
    };
  }
  return null;
}

function buildHistoryEntry(dateValue, numericValue, formulaType, formulaPayload, launchId) {
  const entry = { date: dateValue, value: numericValue, launchId };
  if (!formulaType || !formulaPayload) return entry;
  if (formulaType === "acuracidade") {
    entry.correctItems = formulaPayload.correctItems;
    entry.inventoriedItems = formulaPayload.inventoriedItems;
  }
  if (formulaType === "divergencia_wms") {
    entry.accountingStock = formulaPayload.accountingStock;
    entry.wmsStock = formulaPayload.wmsStock;
  }
  if (formulaType === "obsolescencia") {
    entry.totalItemsStock = formulaPayload.totalItemsStock;
    entry.obsoleteItems = formulaPayload.obsoleteItems;
  }
  if (formulaType === "ruptura") {
    entry.missingItems = formulaPayload.missingItems;
    entry.criticalItems = formulaPayload.criticalItems;
  }
  if (formulaType === "giro_diario") {
    entry.initialStock = formulaPayload.initialStock;
    entry.entriesValue = formulaPayload.entriesValue;
    entry.outboundValue = formulaPayload.outboundValue;
    entry.finalStock = formulaPayload.finalStock;
    entry.averageStock = formulaPayload.averageStock;
  }
  if (formulaType === "recebimento_capacidade_diaria") {
    entry.dailyReceipts = formulaPayload.dailyReceipts;
    entry.plannedReceiptCapacity = formulaPayload.plannedReceiptCapacity;
  }
  if (formulaType === "recebimento_otif_fornecedores") {
    entry.onTimeSupplierDeliveries = formulaPayload.onTimeSupplierDeliveries;
    entry.scheduledSupplierDeliveries = formulaPayload.scheduledSupplierDeliveries;
  }
  if (formulaType === "recebimento_eficiencia") {
    entry.completedReceiptsOnTime = formulaPayload.completedReceiptsOnTime;
    entry.totalReceipts = formulaPayload.totalReceipts;
  }
  if (formulaType === "recebimento_tempo_liberacao") {
    entry.releaseTotalHours = formulaPayload.releaseTotalHours;
    entry.releasedReceipts = formulaPayload.releasedReceipts;
  }
  if (formulaType === "recebimento_erros_armazenagem") {
    entry.readdressedMaterials = formulaPayload.readdressedMaterials;
    entry.totalStoredMaterials = formulaPayload.totalStoredMaterials;
  }
  if (formulaType === "recebimento_produtividade_individual") {
    entry.completedShiftActivities = formulaPayload.completedShiftActivities;
    entry.collaboratorCount = formulaPayload.collaboratorCount;
  }
  if (formulaType === "ruptura_estocaveis") {
    entry.zeroStockMaintenanceItems = formulaPayload.zeroStockMaintenanceItems;
    entry.stockableMaintenanceItems = formulaPayload.stockableMaintenanceItems;
  }
  if (formulaType === "acuracidade_uso_consumo") {
    entry.correctItems = formulaPayload.correctItems;
    entry.totalCountedItems = formulaPayload.totalCountedItems;
  }
  if (formulaType === "estoque_acuracidade_sku") {
    entry.correctItems = formulaPayload.correctItems;
    entry.totalCountedItems = formulaPayload.totalCountedItems;
  }
  if (formulaType === "estoque_divergencia_wms_sku") {
    entry.divergentSkus = formulaPayload.divergentSkus;
    entry.totalSkus = formulaPayload.totalSkus;
  }
  if (formulaType === "aderencia_estoque_minimo") {
    entry.itemsAboveMinimum = formulaPayload.itemsAboveMinimum;
    entry.stockableMaintenanceItems = formulaPayload.stockableMaintenanceItems;
  }
  if (formulaType === "cumprimento_plano_inventario") {
    entry.countedSkusPeriod = formulaPayload.countedSkusPeriod;
    entry.replenishmentSkus = formulaPayload.replenishmentSkus;
  }
  if (formulaType === "estoque_cumprimento_plano_inventario") {
    entry.countedSkusPeriod = formulaPayload.countedSkusPeriod;
    entry.replenishmentSkus = formulaPayload.replenishmentSkus;
  }
  if (formulaType === "estoque_divergencias_tratadas") {
    entry.treatedDivergencesOnTime = formulaPayload.treatedDivergencesOnTime;
    entry.totalDivergences = formulaPayload.totalDivergences;
  }
  if (formulaType === "slow_mover") {
    entry.slowMovingSkus = formulaPayload.slowMovingSkus;
    entry.replenishmentSkus = formulaPayload.replenishmentSkus;
  }
  if (formulaType === "estoque_slow_mover") {
    entry.slowMovingSkus = formulaPayload.slowMovingSkus;
    entry.totalStockSkus = formulaPayload.totalStockSkus;
  }
  if (formulaType === "produtividade_individual") {
    entry.completedShiftActivities = formulaPayload.completedShiftActivities;
    entry.collaboratorCount = formulaPayload.collaboratorCount;
  }
  if (formulaType === "estoque_produtividade_individual_contagens") {
    entry.dailyCountedSkus = formulaPayload.dailyCountedSkus;
    entry.collaboratorCount = formulaPayload.collaboratorCount;
  }
  if (formulaType === "tempo_recebimento") {
    entry.receivedLoads = formulaPayload.receivedLoads;
    entry.receiptHours = formulaPayload.receiptHours;
  }
  if (formulaType === "avarias_recebimento") {
    entry.receivedUnits = formulaPayload.receivedUnits;
    entry.damagedUnits = formulaPayload.damagedUnits;
  }
  if (formulaType === "acuracia_recebimento") {
    entry.receivedUnits = formulaPayload.receivedUnits;
    entry.correctUnits = formulaPayload.correctUnits;
  }
  if (formulaType === "sla_recebimento") {
    entry.receivedLoads = formulaPayload.receivedLoads;
    entry.followUpLoads = formulaPayload.followUpLoads;
  }
  if (formulaType === "giro_recebimento") {
    entry.receivedPallets = formulaPayload.receivedPallets;
    entry.palletCapacity = formulaPayload.palletCapacity;
  }
  if (formulaType === "produtividade_contagens") {
    entry.countedItems = formulaPayload.countedItems;
    entry.collaboratorCount = formulaPayload.collaboratorCount;
  }
  if (formulaType === "perdas_inventario") {
    entry.lossItems = formulaPayload.lossItems;
    entry.inventoriedItems = formulaPayload.inventoriedItems;
  }
  if (formulaType === "secos_perdas_picks") {
    entry.adjustedValue = formulaPayload.adjustedValue;
    entry.totalStockValue = formulaPayload.totalStockValue;
  }
  if (formulaType === "secos_ruptura_embalagens") {
    entry.impactedOps = formulaPayload.impactedOps;
  }
  if (formulaType === "secos_ops_atendidas_erradas") {
    entry.wrongOps = formulaPayload.wrongOps;
    entry.requestedOps = formulaPayload.requestedOps;
  }
  if (formulaType === "secos_erros_movimentacao") {
    entry.movementErrors = formulaPayload.movementErrors;
    entry.movedItems = formulaPayload.movedItems;
  }
  if (formulaType === "secos_erros_expedicao_fabrica") {
    entry.expeditionErrorValue = formulaPayload.expeditionErrorValue;
  }
  if (formulaType === "secos_tempo_carregamento_carretas") {
    entry.loadedTrucks = formulaPayload.loadedTrucks;
    entry.loadingTotalMinutes = formulaPayload.loadingTotalMinutes;
  }
  if (formulaType === "secos_produtividade_individual") {
    entry.completedShiftActivities = formulaPayload.completedShiftActivities;
    entry.collaboratorCount = formulaPayload.collaboratorCount;
  }
  if (formulaType === "quimica_confiabilidade_abastecimento") {
    entry.chemSupplyOkOps = formulaPayload.chemSupplyOkOps;
    entry.chemTotalOps = formulaPayload.chemTotalOps;
  }
  if (formulaType === "quimica_eficiencia_atendimento_ops") {
    entry.chemDeliveredOps = formulaPayload.chemDeliveredOps;
    entry.chemPlannedOps = formulaPayload.chemPlannedOps;
  }
  if (formulaType === "quimica_retrabalho_separacao") {
    entry.chemReworkOps = formulaPayload.chemReworkOps;
    entry.chemSeparatedOps = formulaPayload.chemSeparatedOps;
  }
  if (formulaType === "quimica_giro_kanban") {
    entry.chemKanbanOver7DaysOps = formulaPayload.chemKanbanOver7DaysOps;
    entry.chemKanbanTotalOps = formulaPayload.chemKanbanTotalOps;
  }
  if (formulaType === "quimica_produtividade_ops_separadas") {
    entry.chemShiftDeliveredOps = formulaPayload.chemShiftDeliveredOps;
    entry.chemShiftTargetOps = formulaPayload.chemShiftTargetOps;
  }
  if (formulaType === "quimica_produtividade_individual") {
    entry.completedShiftActivities = formulaPayload.completedShiftActivities;
    entry.collaboratorCount = formulaPayload.collaboratorCount;
  }
  if (formulaType === "movimentacao_colaborador") {
    entry.movedItems = formulaPayload.movedItems;
    entry.collaboratorCount = formulaPayload.collaboratorCount;
  }
  if (formulaType === "erros_movimentacao") {
    entry.movedItems = formulaPayload.movedItems;
    entry.movementErrors = formulaPayload.movementErrors;
  }
  if (formulaType === "avarias_movimentacao") {
    entry.movedItems = formulaPayload.movedItems;
    entry.damagedMovedItems = formulaPayload.damagedMovedItems;
  }
  if (formulaType === "espera_carregamento") {
    entry.waitMinutes = formulaPayload.waitMinutes;
  }
  if (formulaType === "tempo_carregamento") {
    entry.loadedTrucks = formulaPayload.loadedTrucks;
    entry.loadingTotalMinutes = formulaPayload.loadingTotalMinutes;
  }
  return entry;
}

function startLaunchEdit(launchId) {
  const department = currentDepartment();
  const launch = department.launches.find((item) => item.id === launchId);
  if (!launch) return;

  const launchForm = qs("#launchForm");
  launchForm.reset();
  launchForm.elements.indicator.value = launch.indicator;
  syncLaunchFormByIndicator();
  launchForm.elements.date.value = launch.date;
  launchForm.elements.shift.value = normalizeLaunchShift(launch.shift);
  launchForm.elements.comment.value = launch.comment || "";

  const formulaType = getLaunchFormulaType(launch.indicator);
  if (formulaType && launch.formulaData) {
    Object.entries(launch.formulaData).forEach(([key, fieldValue]) => {
      const input = qs(`#launchForm [name="${key}"]`);
      if (!input || !Number.isFinite(fieldValue)) return;
      input.value = fieldValue;
    });
    updateLaunchResultFromFormula();
  } else {
    const numericValue = getLaunchNumericValue(launch);
    launchForm.elements.value.value = Number.isFinite(numericValue) ? numericValue : "";
  }

  editingLaunchId = launchId;
  qs("#launchSubmitButton").textContent = "Atualizar resultado";
  qs("#launchCancelEdit").classList.remove("hidden");
  setView("launches");
  showToast("Edição carregada.");
}

async function deleteLaunch(launchId) {
  const department = currentDepartment();
  const launch = department.launches.find((item) => item.id === launchId);
  if (!launch) return;

  try {
    await deleteSupabaseLaunch(launchId);
  } catch (error) {
    console.error("Não foi possível excluir o lançamento no Supabase.", error);
    showToast("Falha ao excluir no banco de dados.");
    return;
  }

  department.launches = department.launches.filter((item) => item.id !== launchId);
  removeHistoryByLaunchId(launchId, department);
  if (editingLaunchId === launchId) {
    qs("#launchForm").reset();
    setDefaultDates();
    resetLaunchFormState();
    syncLaunchFormByIndicator();
  }
  writePrototypeState();
  renderAll();
  setView(currentView);
  showToast(remotePersistenceActive() ? "Lançamento excluído da base SQL." : "Lançamento excluído.");
}

function getRecordTone(record) {
  return isRecordConcluded(record) ? "success" : "danger";
}

function renderActionList() {
  const records = getFilteredRecords(currentDepartment());
  const actionList = qs("#actionList");
  qs("#actionCounter").textContent = String(records.length);

  if (records.length === 0) {
    actionList.innerHTML = `
      <article class="record-card">
        <p>Sem registros para o período selecionado.</p>
      </article>
    `;
    return;
  }

  actionList.innerHTML = records
    .map((record) => {
      const tone = getRecordTone(record);
      const recordDate = getRecordDate(record);
      return `
        <article class="record-card">
          <header>
            <strong>${escapeHtml(record.type)}</strong>
            <div class="record-head-actions">
              <span class="pill ${tone}">${escapeHtml(record.status)}</span>
              <button class="mini-action" data-record-action="edit" data-record-id="${escapeAttribute(record.id)}" type="button">Editar</button>
              <button class="mini-action danger" data-record-action="delete" data-record-id="${escapeAttribute(record.id)}" type="button">Excluir</button>
            </div>
          </header>
          <p><strong>${escapeHtml(record.indicator)}</strong></p>
          <p>${escapeHtml(record.description)}</p>
          <div class="record-meta">
            <span>Registro ${recordDate ? formatDate(recordDate) : "-"}</span>
            <span>${escapeHtml(record.owner)}</span>
            <span>${record.dueDate ? `Prazo ${formatDate(record.dueDate)}` : "Sem prazo"}</span>
            ${record.file ? `<span>${escapeHtml(record.file)}</span>` : ""}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderActionTable() {
  const department = currentDepartment();
  const records = getFilteredRecords(department);
  const tableBody = qs("#actionTableBody");
  if (!tableBody) return;

  const periodLabel = getActivePeriodLabel();
  qs("#actionTablePeriod").textContent = periodLabel;

  const syncActionSelectFilter = (selector, filterKey, values, formatter = (value) => value) => {
    const input = qs(selector);
    if (!input) return;
    const options = values
      .map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(formatter(value))}</option>`)
      .join("");
    input.innerHTML = `<option value="">Todos</option>${options}`;
    input.value = actionTableFilters[filterKey] || "";
    if (input.value !== (actionTableFilters[filterKey] || "")) {
      actionTableFilters[filterKey] = input.value;
    }
  };

  const recordDates = Array.from(new Set(records.map((record) => getRecordDate(record)).filter(Boolean))).sort((a, b) => {
    const leftDate = toDateOrNull(a);
    const rightDate = toDateOrNull(b);
    if (!leftDate || !rightDate) return 0;
    return rightDate - leftDate;
  });
  const types = Array.from(new Set(records.map((record) => record.type).filter(Boolean)));
  const indicators = Array.from(new Set(records.map((record) => record.indicator).filter(Boolean)));
  const owners = Array.from(new Set(records.map((record) => record.owner).filter(Boolean)));
  const statuses = Array.from(new Set(records.map((record) => record.status).filter(Boolean)));
  const dueDates = Array.from(new Set(records.map((record) => record.dueDate).filter(Boolean))).sort((a, b) => {
    const leftDate = toDateOrNull(a);
    const rightDate = toDateOrNull(b);
    if (!leftDate || !rightDate) return 0;
    return rightDate - leftDate;
  });

  syncActionSelectFilter("#actionColFilterDate", "recordDate", recordDates, (value) => formatDate(value));
  syncActionSelectFilter("#actionColFilterType", "type", types);
  syncActionSelectFilter("#actionColFilterIndicator", "indicator", indicators);
  syncActionSelectFilter("#actionColFilterOwner", "owner", owners);
  syncActionSelectFilter("#actionColFilterStatus", "status", statuses);
  syncActionSelectFilter("#actionColFilterDueDate", "dueDate", dueDates, (value) => formatDate(value));

  const rows = records.map((record) => {
    const recordDate = getRecordDate(record);
    const tone = getRecordTone(record);
    return { record, recordDate, tone };
  });

  const filteredRows = rows.filter((row) => {
    if (actionTableFilters.recordDate && row.recordDate !== actionTableFilters.recordDate) return false;
    if (actionTableFilters.type && row.record.type !== actionTableFilters.type) return false;
    if (actionTableFilters.indicator && row.record.indicator !== actionTableFilters.indicator) return false;
    if (actionTableFilters.owner && row.record.owner !== actionTableFilters.owner) return false;
    if (actionTableFilters.dueDate && row.record.dueDate !== actionTableFilters.dueDate) return false;
    if (actionTableFilters.status && normalizeTextKey(row.record.status) !== normalizeTextKey(actionTableFilters.status)) return false;
    if (!textMatchesFilter(row.record.description, actionTableFilters.description)) return false;
    return true;
  });

  const pendingCount = filteredRows.filter((row) => row.tone !== "success").length;
  const ownerCount = new Set(filteredRows.map((row) => row.record.owner)).size;

  qs("#actionTableSummary").innerHTML = `
    <div class="status-card"><span class="status-dot ok"></span>${filteredRows.length} registros no período</div>
    <div class="status-card"><span class="status-dot warn"></span>${ownerCount} responsáveis envolvidos</div>
    <div class="status-card"><span class="status-dot danger"></span>${pendingCount} pendências abertas</div>
  `;

  if (filteredRows.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-row">Sem registros para os filtros selecionados.</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = filteredRows
    .map(({ record, recordDate, tone }) => {
      const normalizedStatus = normalizeRecordStatusLabel(record.status);
      return `
        <tr>
          <td>${recordDate ? formatDate(recordDate) : "-"}</td>
          <td>${escapeHtml(record.type)}</td>
          <td>${escapeHtml(record.indicator)}</td>
          <td>${escapeHtml(record.owner)}</td>
          <td>
            <select class="column-filter-control status-select status-${tone}" data-record-status-id="${escapeAttribute(record.id)}">
              <option ${normalizedStatus === "Em andamento" ? "selected" : ""}>Em andamento</option>
              <option ${normalizedStatus === "Concluída" ? "selected" : ""}>Concluída</option>
            </select>
          </td>
          <td>${record.dueDate ? formatDate(record.dueDate) : "-"}</td>
          <td>${escapeHtml(record.description || "-")}</td>
        </tr>
      `;
    })
    .join("");
}

function startRecordEdit(recordId) {
  const department = currentDepartment();
  const record = department.records.find((item) => item.id === recordId);
  if (!record) return;

  const form = qs("#actionForm");
  form.reset();
  form.elements.type.value = record.type;
  form.elements.status.value = normalizeRecordStatusLabel(record.status);
  form.elements.indicator.value = record.indicator;
  form.elements.owner.value = record.owner || "";
  form.elements.dueDate.value = record.dueDate || "";
  form.elements.recordDate.value = getRecordDate(record) || "";
  form.elements.description.value = record.description || "";

  editingRecordId = recordId;
  qs("#actionSubmitButton").textContent = "Atualizar registro";
  qs("#actionCancelEdit").classList.remove("hidden");
  setView("actions");
  showToast("Edição carregada.");
}

async function deleteRecord(recordId) {
  const department = currentDepartment();
  const record = department.records.find((item) => item.id === recordId);
  if (!record) return;

  try {
    await deleteSupabaseActionRecord(recordId);
  } catch (error) {
    console.error("Não foi possível excluir o registro no Supabase.", error);
    showToast("Falha ao excluir no banco de dados.");
    return;
  }

  department.records = department.records.filter((item) => item.id !== recordId);
  if (editingRecordId === recordId) {
    qs("#actionForm").reset();
    setDefaultDates();
    resetActionFormState();
  }
  writePrototypeState();
  renderAll();
  setView(currentView);
  showToast(remotePersistenceActive() ? "Registro excluído da base SQL." : "Registro excluído.");
}

async function updateRecordStatus(recordId, nextStatus, departmentKey = selectedDepartmentKey) {
  const department = departments[departmentKey] || currentDepartment();
  const record = department.records.find((item) => item.id === recordId);
  if (!record) return;
  const normalizedStatus = normalizeRecordStatusLabel(nextStatus);

  try {
    await patchSupabaseActionRecord(recordId, { status: normalizedStatus });
  } catch (error) {
    console.error("Não foi possível atualizar o status no Supabase.", error);
    showToast("Falha ao atualizar no banco de dados.");
    renderAll();
    setView(currentView);
    return;
  }

  record.status = normalizedStatus;
  writePrototypeState();
  renderAll();
  setView(currentView);
  showToast("Status atualizado.");
}

function getConsolidatedManagementRecords() {
  return operationalDepartmentKeys
    .flatMap((departmentKey) => {
      const department = departments[departmentKey];
      return (department.records || []).map((record) => ({
        departmentKey,
        departmentLabel: department.label,
        record,
        recordDate: getRecordDate(record),
        tone: getRecordTone(record),
      }));
    })
    .sort((left, right) => {
      const leftDate = toDateOrNull(left.recordDate);
      const rightDate = toDateOrNull(right.recordDate);
      if (!leftDate || !rightDate) return 0;
      return rightDate - leftDate;
    });
}

function renderManagementTreatments() {
  const tableBody = qs("#managementActionTableBody");
  if (!tableBody) return;

  const records = getConsolidatedManagementRecords();
  qs("#managementActionPeriod").textContent = "Consolidado";

  const syncManagementSelectFilter = (selector, filterKey, values, formatter = (value) => value) => {
    const input = qs(selector);
    if (!input) return;
    const options = values
      .map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(formatter(value))}</option>`)
      .join("");
    input.innerHTML = `<option value="">Todos</option>${options}`;
    input.value = managementActionTableFilters[filterKey] || "";
    if (input.value !== (managementActionTableFilters[filterKey] || "")) {
      managementActionTableFilters[filterKey] = input.value;
    }
  };

  const departmentsList = Array.from(new Set(records.map((row) => row.departmentLabel).filter(Boolean)));
  const recordDates = Array.from(new Set(records.map((row) => row.recordDate).filter(Boolean))).sort((a, b) => {
    const leftDate = toDateOrNull(a);
    const rightDate = toDateOrNull(b);
    if (!leftDate || !rightDate) return 0;
    return rightDate - leftDate;
  });
  const types = Array.from(new Set(records.map((row) => row.record.type).filter(Boolean)));
  const indicators = Array.from(new Set(records.map((row) => row.record.indicator).filter(Boolean)));
  const owners = Array.from(new Set(records.map((row) => row.record.owner).filter(Boolean)));
  const statuses = Array.from(new Set(records.map((row) => normalizeRecordStatusLabel(row.record.status)).filter(Boolean)));
  const dueDates = Array.from(new Set(records.map((row) => row.record.dueDate).filter(Boolean))).sort((a, b) => {
    const leftDate = toDateOrNull(a);
    const rightDate = toDateOrNull(b);
    if (!leftDate || !rightDate) return 0;
    return rightDate - leftDate;
  });

  syncManagementSelectFilter("#managementActionColFilterDepartment", "department", departmentsList);
  syncManagementSelectFilter("#managementActionColFilterDate", "recordDate", recordDates, (value) => formatDate(value));
  syncManagementSelectFilter("#managementActionColFilterType", "type", types);
  syncManagementSelectFilter("#managementActionColFilterIndicator", "indicator", indicators);
  syncManagementSelectFilter("#managementActionColFilterOwner", "owner", owners);
  syncManagementSelectFilter("#managementActionColFilterStatus", "status", statuses);
  syncManagementSelectFilter("#managementActionColFilterDueDate", "dueDate", dueDates, (value) => formatDate(value));

  const filteredRows = records.filter((row) => {
    if (managementActionTableFilters.department && row.departmentLabel !== managementActionTableFilters.department) return false;
    if (managementActionTableFilters.recordDate && row.recordDate !== managementActionTableFilters.recordDate) return false;
    if (managementActionTableFilters.type && row.record.type !== managementActionTableFilters.type) return false;
    if (managementActionTableFilters.indicator && row.record.indicator !== managementActionTableFilters.indicator) return false;
    if (managementActionTableFilters.owner && row.record.owner !== managementActionTableFilters.owner) return false;
    if (managementActionTableFilters.dueDate && row.record.dueDate !== managementActionTableFilters.dueDate) return false;
    if (
      managementActionTableFilters.status &&
      normalizeTextKey(row.record.status) !== normalizeTextKey(managementActionTableFilters.status)
    ) {
      return false;
    }
    if (!textMatchesFilter(row.record.description, managementActionTableFilters.description)) return false;
    return true;
  });

  const pendingCount = filteredRows.filter((row) => !isRecordConcluded(row.record)).length;
  const concludedCount = filteredRows.length - pendingCount;
  const departmentCount = new Set(filteredRows.map((row) => row.departmentLabel)).size;

  qs("#managementActionSummary").innerHTML = `
    <div class="status-card"><span class="status-dot ok"></span>${filteredRows.length} registros consolidados</div>
    <div class="status-card"><span class="status-dot danger"></span>${pendingCount} em andamento</div>
    <div class="status-card"><span class="status-dot ok"></span>${concludedCount} concluídos</div>
    <div class="status-card"><span class="status-dot warn"></span>${departmentCount} departamentos envolvidos</div>
  `;

  if (filteredRows.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-row">Sem tratativas ou planos para os filtros selecionados.</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = filteredRows
    .map((row) => {
      const { departmentKey, departmentLabel, record, recordDate, tone } = row;
      const normalizedStatus = normalizeRecordStatusLabel(record.status);
      return `
        <tr>
          <td>${escapeHtml(departmentLabel)}</td>
          <td>${recordDate ? formatDate(recordDate) : "-"}</td>
          <td>${escapeHtml(record.type)}</td>
          <td>${escapeHtml(record.indicator)}</td>
          <td>${escapeHtml(record.owner)}</td>
          <td>
            <select class="column-filter-control status-select status-${tone}" data-management-record-status-id="${escapeAttribute(
        record.id,
      )}" data-management-record-department="${escapeAttribute(departmentKey)}">
              <option ${normalizedStatus === "Em andamento" ? "selected" : ""}>Em andamento</option>
              <option ${normalizedStatus === "Concluída" ? "selected" : ""}>Concluída</option>
            </select>
          </td>
          <td>${record.dueDate ? formatDate(record.dueDate) : "-"}</td>
          <td>${escapeHtml(record.description || "-")}</td>
        </tr>
      `;
    })
    .join("");
}

function isOperationalStatus(status) {
  return status === "success" || status === "warn" || status === "danger";
}

function getStatusExecutiveLabel(status) {
  if (status === "success") return "Na meta";
  if (status === "warn") return "Atenção";
  if (status === "danger") return "Crítico";
  return statusLabel[status] || "Sem dados";
}

function getStatusScore(status) {
  if (status === "success") return 100;
  if (status === "warn") return 78;
  if (status === "danger") return 45;
  return null;
}

function getAnalysisToneByScore(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return "neutral";
  if (score >= 90) return "success";
  if (score >= 70) return "warn";
  return "danger";
}

function getOperationalIndicatorRows() {
  return operationalDepartmentKeys.flatMap((departmentKey) => {
    const department = departments[departmentKey];
    return department.indicators.map((indicator) => {
      const accumulatedValue = getIndicatorAccumulatedValue(indicator, department);
      const status = getStatus(indicator, department, accumulatedValue);
      return {
        departmentKey,
        department,
        departmentLabel: department.label,
        indicator,
        accumulatedValue,
        status,
      };
    });
  });
}

function getDepartmentAnalysisStats(departmentKey) {
  const department = departments[departmentKey];
  const rows = department.indicators.map((indicator) => {
    const accumulatedValue = getIndicatorAccumulatedValue(indicator, department);
    const status = getStatus(indicator, department, accumulatedValue);
    return { indicator, accumulatedValue, status };
  });
  const countedRows = rows.filter((row) => isOperationalStatus(row.status));
  const score =
    countedRows.length > 0
      ? countedRows.reduce((sum, row) => sum + getStatusScore(row.status), 0) / countedRows.length
      : null;
  const counts = rows.reduce(
    (summary, row) => {
      summary[row.status] += 1;
      return summary;
    },
    { success: 0, warn: 0, danger: 0, tracking: 0, neutral: 0 },
  );

  return {
    departmentKey,
    department,
    label: department.label,
    rows,
    countedRows,
    counts,
    score,
    tone: getAnalysisToneByScore(score),
  };
}

function getIndicatorRiskWeight(row) {
  if (row.status === "danger") return 3;
  if (row.status === "warn") return 2;
  if (row.status === "success") return 1;
  return 0;
}

function getIndicatorGap(row) {
  const { indicator, accumulatedValue } = row;
  if (!Number.isFinite(Number(accumulatedValue)) || !Number.isFinite(Number(indicator.target))) return 0;
  const value = Number(accumulatedValue);
  const target = Number(indicator.target);
  if (target === 0) return value === 0 ? 0 : Math.abs(value);
  if (indicator.goal === "higher") return Math.max(0, (target - value) / Math.abs(target));
  return Math.max(0, (value - target) / Math.abs(target));
}

function getMonthKey(dateValue) {
  const date = toDateOrNull(dateValue);
  if (!date) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(monthKey) {
  const [year, month] = monthKey.split("-");
  if (!year || !month) return monthKey;
  const date = new Date(Number(year), Number(month) - 1, 1);
  const monthLabel = date.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "");
  return `${monthLabel}/${String(year).slice(-2)}`;
}

function getMonthlyAnalysisData() {
  const buckets = new Map();

  operationalDepartmentKeys.forEach((departmentKey) => {
    const department = departments[departmentKey];
    department.indicators.forEach((indicator) => {
      if (indicator.goal === "tracking" || indicator.target === null || indicator.target === undefined) return;
      getIndicatorHistory(indicator, department).forEach((entry) => {
        const monthKey = getMonthKey(entry.date);
        if (!monthKey || !Number.isFinite(Number(entry.value))) return;
        const status = getStatus(indicator, department, Number(entry.value));
        if (!isOperationalStatus(status)) return;
        if (!buckets.has(monthKey)) buckets.set(monthKey, []);
        buckets.get(monthKey).push(getStatusScore(status));
      });
    });
  });

  return Array.from(buckets.entries())
    .map(([monthKey, scores]) => ({
      monthKey,
      label: formatMonthLabel(monthKey),
      value: scores.reduce((sum, score) => sum + score, 0) / scores.length,
    }))
    .sort((left, right) => left.monthKey.localeCompare(right.monthKey))
    .slice(-7);
}

function drawAnalysisMonthlyChart(canvas, data) {
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.round(rect.width || 720));
  const height = Math.max(240, Math.round(rect.height || 300));
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const renderWidth = Math.round(width * dpr);
  const renderHeight = Math.round(height * dpr);

  if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
    canvas.width = renderWidth;
    canvas.height = renderHeight;
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#101a29";
  ctx.fillRect(0, 0, width, height);

  if (!Array.isArray(data) || data.length === 0) {
    ctx.fillStyle = "#aebdd2";
    ctx.font = "800 13px Roboto, Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Sem histórico mensal suficiente para análise.", width / 2, height / 2);
    return;
  }

  const padding = { top: 26, right: 20, bottom: 38, left: 42 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const yFor = (value) => padding.top + ((100 - Number(value)) / 100) * plotHeight;
  const xStep = data.length > 1 ? plotWidth / (data.length - 1) : 0;
  const points = data.map((item, index) => ({
    x: padding.left + xStep * index,
    y: yFor(item.value),
    item,
  }));

  ctx.strokeStyle = "#263552";
  ctx.lineWidth = 1;
  ctx.font = "700 10px Roboto, Inter, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  [0, 25, 50, 75, 100].forEach((tick) => {
    const y = yFor(tick);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillStyle = "#8999b4";
    ctx.fillText(`${tick}%`, padding.left - 8, y);
  });

  const gradient = ctx.createLinearGradient(padding.left, 0, width - padding.right, 0);
  gradient.addColorStop(0, "#18b8ff");
  gradient.addColorStop(0.6, "#36d39e");
  gradient.addColorStop(1, "#f1c453");

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();

  points.forEach((point) => {
    const tone = getAnalysisToneByScore(point.item.value);
    ctx.fillStyle = "#101a29";
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = statusColor[tone] || statusColor.neutral;
    ctx.lineWidth = 2.4;
    ctx.stroke();

    ctx.fillStyle = "#eef5ff";
    ctx.font = "800 10.5px Roboto, Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${formatNumber(point.item.value)}%`, point.x, point.y - 10);

    ctx.fillStyle = "#9aacc7";
    ctx.textBaseline = "top";
    ctx.fillText(point.item.label, point.x, height - padding.bottom + 14);
  });
}

function renderAnalysisProfileIcon(profileKey, accentColor = "#4d7dff") {
  const iconKey = profileAvatarIcons[profileKey] ? profileKey : "default";
  return `<span class="analysis-profile-icon" style="--icon-accent: ${escapeAttribute(accentColor)}" aria-hidden="true">${profileAvatarIcons[iconKey]}</span>`;
}

function renderAnalyses() {
  const summaryTarget = qs("#analysisSummary");
  if (!summaryTarget) return;

  const rows = getOperationalIndicatorRows();
  const countedRows = rows.filter((row) => isOperationalStatus(row.status));
  const successCount = rows.filter((row) => row.status === "success").length;
  const dangerCount = rows.filter((row) => row.status === "danger").length;
  const pendingRecords = getConsolidatedManagementRecords().filter((row) => !isRecordConcluded(row.record));
  const periodLabel = getActivePeriodLabel();

  qs("#analysisPeriod").textContent = periodLabel;
  summaryTarget.innerHTML = `
    <article class="analysis-summary-card" style="--summary-color: #4d7dff">
      <span>Indicadores</span>
      <strong>${rows.length}</strong>
      <small>Total monitorado na logística</small>
    </article>
    <article class="analysis-summary-card" style="--summary-color: ${statusColor.success}">
      <span>Na meta</span>
      <strong>${successCount}</strong>
      <small>${countedRows.length ? formatNumber((successCount / countedRows.length) * 100) : 0}% dos indicadores avaliados</small>
    </article>
    <article class="analysis-summary-card" style="--summary-color: ${statusColor.danger}">
      <span>Críticos</span>
      <strong>${dangerCount}</strong>
      <small>${countedRows.length ? formatNumber((dangerCount / countedRows.length) * 100) : 0}% pedem ação imediata</small>
    </article>
    <article class="analysis-summary-card" style="--summary-color: ${statusColor.warn}">
      <span>Pendentes</span>
      <strong>${pendingRecords.length}</strong>
      <small>Tratativas e planos em andamento</small>
    </article>
  `;

  const departmentStats = operationalDepartmentKeys.map(getDepartmentAnalysisStats);
  qs("#analysisDepartmentBars").innerHTML = departmentStats
    .map((item) => {
      const score = Number.isFinite(Number(item.score)) ? item.score : 0;
      const toneColor = statusColor[item.tone] || statusColor.neutral;
      return `
        <div class="analysis-department-row">
          <span>${escapeHtml(item.label)}</span>
          <div class="analysis-bar-track" aria-hidden="true">
            <div class="analysis-bar-fill" style="--bar-value: ${Math.max(0, Math.min(100, score))}%; --bar-color: ${toneColor}"></div>
          </div>
          <strong class="analysis-score" style="--bar-color: ${toneColor}">${
            item.countedRows.length ? `${formatNumber(score)}%` : "Sem dados"
          }</strong>
        </div>
      `;
    })
    .join("");

  const criticalRows = rows
    .filter((row) => row.status === "danger" || row.status === "warn")
    .sort((left, right) => {
      const riskDelta = getIndicatorRiskWeight(right) - getIndicatorRiskWeight(left);
      if (riskDelta !== 0) return riskDelta;
      return getIndicatorGap(right) - getIndicatorGap(left);
    });
  qs("#analysisCriticalCount").textContent = String(dangerCount);
  qs("#analysisCriticalList").innerHTML =
    criticalRows.length > 0
      ? criticalRows
          .slice(0, 6)
          .map((row, index) => {
            const color = statusColor[row.status] || statusColor.warn;
            return `
              <article class="analysis-critical-item">
                ${renderAnalysisProfileIcon(row.departmentKey, row.department.color)}
                <div>
                  <strong>${escapeHtml(row.indicator.name)}</strong>
                  <span>${escapeHtml(row.departmentLabel)} · ${formatMetric(row.indicator, row.accumulatedValue)} de ${escapeHtml(
                    formatTarget(row.indicator),
                  )}</span>
                </div>
                <span class="analysis-status" style="--status-color: ${color}">${getStatusExecutiveLabel(row.status)}</span>
              </article>
            `;
          })
          .join("")
      : `<div class="analysis-empty">Nenhum indicador crítico ou em atenção no período.</div>`;

  const departmentsWithDanger = departmentStats.filter((item) => item.counts.danger > 0);
  const departmentsWithWarning = departmentStats.filter((item) => item.counts.warn > 0);
  const weakestDepartment = [...departmentStats]
    .filter((item) => item.countedRows.length > 0)
    .sort((left, right) => left.score - right.score)[0];
  const bestDepartment = [...departmentStats]
    .filter((item) => item.countedRows.length > 0)
    .sort((left, right) => right.score - left.score)[0];
  const warningIconDepartment = departmentsWithWarning[0] || weakestDepartment;
  const dangerIconDepartment = departmentsWithDanger[0] || weakestDepartment;

  qs("#analysisExecutiveSummary").innerHTML = `
    <article class="analysis-executive-item">
      ${renderAnalysisProfileIcon(warningIconDepartment?.departmentKey || "gestao", warningIconDepartment?.department.color || statusColor.warn)}
      <div>
        <strong>${departmentsWithWarning.length} departamentos em atenção</strong>
        <span>Monitore indicadores próximos ao limite operacional.</span>
      </div>
    </article>
    <article class="analysis-executive-item">
      ${renderAnalysisProfileIcon(dangerIconDepartment?.departmentKey || "gestao", dangerIconDepartment?.department.color || statusColor.danger)}
      <div>
        <strong>${departmentsWithDanger.length} departamentos críticos</strong>
        <span>Priorize tratativas com maior impacto na operação.</span>
      </div>
    </article>
    <article class="analysis-executive-item">
      ${renderAnalysisProfileIcon("gestao", statusColor.tracking)}
      <div>
        <strong>${pendingRecords.length} planos e evidências em andamento</strong>
        <span>Consolidação de todos os perfis operacionais.</span>
      </div>
    </article>
    <article class="analysis-executive-item">
      ${renderAnalysisProfileIcon(bestDepartment?.departmentKey || "gestao", bestDepartment?.department.color || statusColor.success)}
      <div>
        <strong>${bestDepartment ? `${bestDepartment.label} lidera a performance` : "Performance em formação"}</strong>
        <span>${
          weakestDepartment
            ? `${weakestDepartment.label} exige acompanhamento mais próximo.`
            : "Cadastre lançamentos para gerar comparativos executivos."
        }</span>
      </div>
    </article>
  `;

  drawAnalysisMonthlyChart(qs("#analysisMonthlyChart"), getMonthlyAnalysisData());
}

function hasFiveSScore(entry) {
  return entry?.score !== null && entry?.score !== undefined && entry?.score !== "" && Number.isFinite(Number(entry.score));
}

function getFiveSItemTone(entry) {
  if (!hasFiveSScore(entry)) return "neutral";
  const score = Number(entry.score);
  if (score >= 3.5) return "success";
  if (score >= 2.5) return "warn";
  return "danger";
}

function getFiveSScore(entries) {
  const answeredEntries = entries.filter(hasFiveSScore);
  const weightTotal = answeredEntries.reduce((sum, entry) => sum + (Number(entry.weight) || 1), 0);
  if (weightTotal <= 0) return null;
  const scoreTotal = answeredEntries.reduce(
    (sum, entry) => sum + Number(entry.score) * (Number(entry.weight) || 1),
    0,
  );
  return (scoreTotal / (weightTotal * 4)) * 100;
}

function getFiveSOverallTone(score, criticalFailures) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return "neutral";
  if (criticalFailures > 0 || score < 70) return "danger";
  if (score < 85) return "warn";
  return "success";
}

function getFiveSStatusLabel(tone, score) {
  if (tone === "neutral") return "Não iniciado";
  if (tone === "danger") return score < 70 ? "Crítico" : "Falha crítica";
  if (tone === "warn") return "Controlado";
  return "Excelência";
}

function summarizeFiveSBy(entries, key) {
  const grouped = new Map();
  entries.forEach((entry) => {
    const groupKey = entry[key] || "-";
    const current = grouped.get(groupKey) || [];
    current.push(entry);
    grouped.set(groupKey, current);
  });

  return Array.from(grouped.entries()).map(([label, rows]) => {
    const score = getFiveSScore(rows);
    const criticalFailures = rows.filter(
      (entry) => hasFiveSScore(entry) && entry.critical && Number(entry.score) <= 2,
    ).length;
    const tone = getFiveSOverallTone(score, criticalFailures);
    return {
      label,
      rows,
      score,
      tone,
      criticalFailures,
      openActions: rows.filter((entry) => (hasFiveSScore(entry) && Number(entry.score) < 3) || entry.action).length,
    };
  });
}

function updateFiveSEntry(entryId, field, rawValue) {
  const entry = fiveSChecklistEntries.find((item) => item.id === entryId);
  if (!entry) return;

  if (field === "score") {
    entry.score = rawValue === "" ? null : Math.max(0, Math.min(4, Number(rawValue)));
  } else {
    entry[field] = String(rawValue || "").trim();
  }

  writePrototypeState();
  renderFiveS();
}

function getFiveSAuditSnapshot() {
  ensureFiveSMetadata();
  const entries = fiveSChecklistEntries;
  const score = getFiveSScore(entries);
  const criticalFailures = entries.filter(
    (entry) => hasFiveSScore(entry) && entry.critical && Number(entry.score) <= 2,
  ).length;
  const openActions = entries.filter(
    (entry) => (hasFiveSScore(entry) && Number(entry.score) < 3) || entry.action,
  ).length;
  const answeredEntries = entries.filter(hasFiveSScore).length;
  const overallTone = getFiveSOverallTone(score, criticalFailures);
  const senseSummary = summarizeFiveSBy(entries, "sense").sort(
    (left, right) => fiveSSenses.indexOf(left.label) - fiveSSenses.indexOf(right.label),
  );
  const criticalSense =
    answeredEntries > 0
      ? [...senseSummary]
          .filter((item) => Number.isFinite(Number(item.score)))
          .sort((left, right) => left.score - right.score)[0]
      : null;

  return {
    entries,
    score,
    criticalFailures,
    openActions,
    answeredEntries,
    totalEntries: entries.length,
    overallTone,
    senseSummary,
    criticalSense,
  };
}

async function saveFiveSAuditRecord() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fiveSAuditDate)) {
    showToast("Informe a data da auditoria.");
    return;
  }

  const snapshot = getFiveSAuditSnapshot();
  if (snapshot.answeredEntries < snapshot.totalEntries) {
    showToast("Responda todas as perguntas antes de salvar a auditoria.");
    return;
  }
  const record = {
    id: `5s-audit-${selectedDepartmentKey}-${fiveSAuditDate}`,
    date: fiveSAuditDate,
    score: snapshot.score,
    tone: snapshot.overallTone,
    status: getFiveSStatusLabel(snapshot.overallTone, snapshot.score),
    answered: snapshot.answeredEntries,
    total: snapshot.totalEntries,
    criticalFailures: snapshot.criticalFailures,
    openActions: snapshot.openActions,
    focus: snapshot.criticalSense?.label || "-",
    createdAt: new Date().toISOString(),
  };

  try {
    await persistSupabaseFiveSAuditRecord(record, selectedDepartmentKey);
  } catch (error) {
    console.error("Não foi possível salvar a auditoria 5S no Supabase.", error);
    showToast("Falha ao salvar a auditoria na base SQL.");
    return;
  }

  const existingIndex = fiveSAuditRecords.findIndex((item) => item.date === fiveSAuditDate);

  if (existingIndex >= 0) {
    fiveSAuditRecords[existingIndex] = record;
  } else {
    fiveSAuditRecords.unshift(record);
  }

  ensureFiveSAuditRecordsMetadata();
  fiveSAuditRecords = fiveSAuditRecords.slice(0, 12);
  writePrototypeState();
  renderFiveS();
  showToast(existingIndex >= 0 ? "Auditoria atualizada." : "Auditoria registrada.");
}

function renderFiveSAuditRecords() {
  const recordsContainer = qs("#fiveSRecords");
  if (!recordsContainer) return;

  ensureFiveSAuditRecordsMetadata();
  qs("#fiveSRecordsCount").textContent = `${fiveSAuditRecords.length} registro${fiveSAuditRecords.length === 1 ? "" : "s"}`;

  if (fiveSAuditRecords.length === 0) {
    recordsContainer.innerHTML = `
      <article class="five-s-empty-record">
        <strong>Nenhuma auditoria registrada</strong>
        <span>Salve a auditoria do dia para acompanhar o histórico.</span>
      </article>
    `;
    return;
  }

  recordsContainer.innerHTML = fiveSAuditRecords
    .slice(0, 6)
    .map((record) => {
      const dotTone = record.tone === "success" ? "ok" : record.tone;
      return `
        <article class="five-s-record-card ${record.tone}">
          <div class="five-s-record-main">
            <div>
              <span>${formatDate(record.date)}</span>
              <strong>${formatNumber(record.score)}%</strong>
            </div>
            <span class="pill ${record.tone}">${escapeHtml(record.status)}</span>
          </div>
          <div class="five-s-record-meta">
            <span><i class="status-dot ${dotTone}"></i>${record.answered}/${record.total} respostas</span>
            <span><i class="status-dot danger"></i>${record.criticalFailures} crítica${record.criticalFailures === 1 ? "" : "s"}</span>
            <span><i class="status-dot warn"></i>${record.openActions} tratativa${record.openActions === 1 ? "" : "s"}</span>
          </div>
          <small>Maior atenção: ${escapeHtml(record.focus)}${record.createdAt ? ` | Salvo ${formatTimeLabel(record.createdAt)}` : ""}</small>
        </article>
      `;
    })
    .join("");
}

function renderFiveS() {
  const questionList = qs("#fiveSQuestionList");
  if (!questionList) return;

  const {
    entries,
    score,
    criticalFailures,
    openActions,
    answeredEntries,
    totalEntries,
    overallTone,
    senseSummary,
    criticalSense,
  } = getFiveSAuditSnapshot();
  const auditDateInput = qs("#fiveSAuditDate");
  if (auditDateInput && auditDateInput.value !== fiveSAuditDate) {
    auditDateInput.value = fiveSAuditDate;
  }
  const scoreText = Number.isFinite(Number(score)) && score !== null ? `${formatNumber(score)}%` : "Sem avaliação";

  qs("#fiveSPeriod").textContent = fiveSAuditDate ? `Auditoria ${formatDate(fiveSAuditDate)}` : "Auditoria vigente";
  qs("#fiveSOverallPill").className = `pill ${overallTone}`;
  qs("#fiveSOverallPill").textContent = scoreText;
  qs("#fiveSAnsweredPill").textContent = `${answeredEntries}/${totalEntries} respondidas`;
  qs("#fiveSSummary").innerHTML = `
    <div class="status-card"><span class="status-dot ${overallTone === "success" ? "ok" : overallTone}"></span>${scoreText}${score === null ? "" : " de aderência 5S"}</div>
    <div class="status-card"><span class="status-dot ${overallTone === "success" ? "ok" : overallTone}"></span>${getFiveSStatusLabel(overallTone, score)}</div>
    <div class="status-card"><span class="status-dot warn"></span>${criticalSense ? escapeHtml(criticalSense.label) : "-"} em maior atenção</div>
    <div class="status-card"><span class="status-dot danger"></span>${criticalFailures} falha${criticalFailures === 1 ? "" : "s"} crítica${criticalFailures === 1 ? "" : "s"}</div>
    <div class="status-card"><span class="status-dot ok"></span>${openActions} tratativa${openActions === 1 ? "" : "s"} aberta${openActions === 1 ? "" : "s"}</div>
  `;

  qs("#fiveSRadar").innerHTML = senseSummary
    .map((item) => {
      const tone = item.tone === "success" ? "ok" : item.tone;
      return `
        <article class="five-s-sense-row">
          <div>
            <strong>${escapeHtml(item.label)}</strong>
            <span>${item.rows.length} itens avaliados</span>
          </div>
          <div class="five-s-bar" aria-label="${escapeAttribute(item.label)} ${item.score === null ? "sem avaliação" : `${formatNumber(item.score)}%`}">
            <span class="${tone}" style="width: ${item.score === null ? 0 : Math.max(4, Math.min(100, item.score))}%"></span>
          </div>
          <b>${item.score === null ? "-" : `${formatNumber(item.score)}%`}</b>
        </article>
      `;
    })
    .join("");

  renderFiveSAuditRecords();

  questionList.innerHTML = entries
    .map((entry, index) => {
      const tone = getFiveSItemTone(entry);
      const statusText =
        tone === "success" ? "Conforme" : tone === "warn" ? "Atenção" : tone === "danger" ? "Crítico" : "Não respondida";
      const weightLabel = entry.critical ? "Crítico" : Number(entry.weight) >= 1.4 ? "Alto" : "Padrão";
      return `
        <article class="five-s-question-card ${tone}">
          <header>
            <div>
              <span class="five-s-question-index">Pergunta ${String(index + 1).padStart(2, "0")}</span>
              <h4>${escapeHtml(entry.checkpoint)}</h4>
            </div>
            <span class="pill ${tone}">${statusText}</span>
          </header>

          <div class="five-s-question-meta">
            <span>${escapeHtml(entry.sense)}</span>
            <span>${escapeHtml(entry.area)}</span>
            <span class="pill ${entry.critical ? "danger" : Number(entry.weight) >= 1.4 ? "warn" : "neutral"}">${weightLabel}</span>
          </div>

          <label class="five-s-answer-field">
            Resposta
            <select class="five-s-score-select ${tone}" data-five-s-field="score" data-five-s-id="${escapeAttribute(entry.id)}">
              <option value="" ${hasFiveSScore(entry) ? "" : "selected"}>Selecione uma resposta</option>
              ${fiveSAnswerOptions
                .map(
                  (option) => `
                    <option value="${option.value}" ${hasFiveSScore(entry) && Number(entry.score) === option.value ? "selected" : ""}>
                      ${option.value} - ${escapeHtml(option.label)}
                    </option>
                  `,
                )
                .join("")}
            </select>
          </label>

          <div class="five-s-response-grid">
            <label>
              Evidência
              <textarea class="five-s-text-field" data-five-s-field="evidence" data-five-s-id="${escapeAttribute(entry.id)}" placeholder="Registrar evidência...">${escapeHtml(entry.evidence)}</textarea>
            </label>
            <label>
              Tratativa
              <textarea class="five-s-text-field" data-five-s-field="action" data-five-s-id="${escapeAttribute(entry.id)}" placeholder="Tratativa, responsável e prazo...">${escapeHtml(entry.action)}</textarea>
            </label>
          </div>
        </article>
      `;
    })
    .join("");
}
function renderActions() {
  renderActionList();
  renderActionTable();
}

function renderTv() {
  qs("#tvSummary").innerHTML = "";

  qs("#tvCards").innerHTML = operationalDepartmentKeys
    .map((key) => {
      const department = departments[key];
      const departmentCounts = statusCounts(department.indicators, department);
      const indicatorCards = department.indicators
        .map((indicator) => {
          const accumulatedValue = getIndicatorAccumulatedValue(indicator, department);
          const status = getStatus(indicator, department, accumulatedValue);
          const showTvStatus = isOperationalStatus(status);
          const showTargetMetric = indicator.goal !== "tracking" && indicator.target !== null && indicator.target !== undefined;

          return `
            <article class="tv-indicator-card ${status}">
              <header>
                <h4>${escapeHtml(indicator.name)}</h4>
                ${showTvStatus ? `<span class="pill ${status}">${escapeHtml(getStatusExecutiveLabel(status))}</span>` : ""}
              </header>
              <div class="tv-metrics">
                <div>
                  <span>Acumulado</span>
                  <strong>${formatMetric(indicator, accumulatedValue)}</strong>
                </div>
                ${
                  showTargetMetric
                    ? `<div>
                        <span>Meta</span>
                        <strong>${escapeHtml(formatTargetValue(indicator))}</strong>
                      </div>`
                    : ""
                }
              </div>
            </article>
          `;
        })
        .join("");

      return `
        <section class="tv-department-lane">
          <header class="tv-department-header">
            <h3>${escapeHtml(department.label)}</h3>
            <div class="tv-lane-status" aria-label="Resumo dos indicadores do departamento">
              <span><i class="status-dot ok"></i>${departmentCounts.success} na meta</span>
              <span><i class="status-dot warn"></i>${departmentCounts.warn} em atenção</span>
              <span><i class="status-dot danger"></i>${departmentCounts.danger} críticos</span>
            </div>
          </header>
          <div class="tv-kanban-stack">${indicatorCards}</div>
        </section>
      `;
    })
    .join("");

  qs("#tvClock").textContent = `Atualizado ${new Date().toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function renderAll() {
  if (!isManagement() && currentUser) {
    selectedDepartmentKey = currentUser.departmentKey;
  }
  renderNavigation();
  populateDepartmentSelect();
  renderUser();
  renderIndicatorOptions();
  renderSummary();
  renderKpis();
  renderLineCharts();
  renderLaunches();
  renderLaunchTable();
  renderActions();
  renderManagementTreatments();
  renderFiveS();
  renderAnalyses();
  renderTv();
}

function applyPeriodFilter(nextPeriod, options = {}) {
  if (!currentUser) return;

  const showFeedback = options.showFeedback !== false;
  const normalizedPeriod = Object.prototype.hasOwnProperty.call(periodWindows, nextPeriod) ? nextPeriod : "semana";

  if (normalizedPeriod === currentPeriod) return;

  currentPeriod = normalizedPeriod;
  const periodSelect = qs("#periodSelect");
  if (periodSelect && periodSelect.value !== normalizedPeriod) {
    periodSelect.value = normalizedPeriod;
  }

  renderSummary();
  renderKpis();
  renderLineCharts();
  renderLaunches();
  renderLaunchTable();
  renderActions();
  renderManagementTreatments();
  renderFiveS();
  renderAnalyses();
  renderTv();

  if (showFeedback && periodSelect) {
    const selectedLabel = periodSelect.options[periodSelect.selectedIndex]?.text || "Período";
    showToast(`Período alterado para ${selectedLabel}.`);
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
  if (!isManagement() && (view === "tv" || view === "treatments" || view === "analyses")) return;
  if (view === "fiveS") return;
  if (isManagement() && (view === "launches" || view === "actions")) view = "dashboard";

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
  if (view === "dashboard") renderLineCharts();
  if (view === "treatments") renderManagementTreatments();
  if (view === "analyses") renderAnalyses();
  if (view === "fiveS") renderFiveS();
  if (view === "tv") renderTv();
}

function showToast(message) {
  const toast = qs("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2200);
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
    resetLaunchFormState();
    resetActionFormState();
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

  const periodSelect = qs("#periodSelect");
  const onPeriodChange = (event) => {
    const nextPeriod = event.target.value;
    applyPeriodFilter(nextPeriod);
  };
  periodSelect.addEventListener("change", onPeriodChange);
  periodSelect.addEventListener("input", onPeriodChange);

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
      shift: normalizeLaunchShift(data.get("shift")),
      date: String(data.get("date")),
      comment: String(data.get("comment")),
      formulaData: formulaPayload,
    };

    try {
      await persistSupabaseLaunch(launchRecord, selectedDepartmentKey);
    } catch (error) {
      console.error("Não foi possível salvar o lançamento no Supabase.", error);
      showToast("Falha ao salvar no banco de dados.");
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
      launchList[existingIndex] = launchRecord;
    } else {
      launchList.unshift(launchRecord);
    }

    writePrototypeState();
    event.currentTarget.reset();
    setDefaultDates();
    resetLaunchFormState();
    syncLaunchFormByIndicator();
    renderAll();
    setView("launches");
    showToast(
      wasEditing
        ? "Lançamento atualizado."
        : remotePersistenceActive()
          ? "Resultado salvo na base SQL."
          : "Resultado salvo no protótipo.",
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
    const nextRecord = {
      id: recordId,
      type,
      indicator: String(data.get("indicator")),
      owner: String(data.get("owner")),
      dueDate: String(data.get("dueDate")),
      recordDate: String(data.get("recordDate")),
      status,
      description: String(data.get("description")),
      file: file && file.name ? file.name : existingRecord?.file || "",
    };

    try {
      await persistSupabaseActionRecord(nextRecord, selectedDepartmentKey);
    } catch (error) {
      console.error("Não foi possível salvar o registro no Supabase.", error);
      showToast("Falha ao salvar no banco de dados.");
      return;
    }

    const recordList = currentDepartment().records;
    const existingIndex = recordList.findIndex((record) => record.id === recordId);
    if (existingIndex >= 0) {
      recordList[existingIndex] = nextRecord;
    } else {
      recordList.unshift(nextRecord);
    }

    writePrototypeState();
    event.currentTarget.reset();
    setDefaultDates();
    resetActionFormState();
    renderAll();
    setView("actions");
    showToast(
      wasEditing
        ? "Registro atualizado."
        : remotePersistenceActive()
          ? "Registro salvo na base SQL."
          : "Registro vinculado ao indicador.",
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
});
boot();

