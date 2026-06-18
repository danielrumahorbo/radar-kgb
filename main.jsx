import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import * as XLSX from 'xlsx';
import * as turf from '@turf/turf';
import { createClient } from '@supabase/supabase-js';
import {
  Upload, Download, MapPinned, Search, RefreshCcw, Database, CalendarDays,
  CheckCircle2, AlertTriangle, Route, ClipboardCheck, Building2, X, Save,
  FileSpreadsheet, Layers, Target, Users, Wifi, WifiOff, ChevronLeft, ChevronRight,
  Info, CreditCard, History, ChevronUp, ChevronDown
} from 'lucide-react';
import './styles.css';
import 'leaflet/dist/leaflet.css';
import merchantSeed from './merchant_seed.json';
import lvmSeed from './lvm_kgb_light.json';
import branchSeed from './branches_jabodetabek_seed.json';
import competitorSeed from './competitors_seed.json';
import areaSeed from './areas_kelapa_gading.json';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const KG_CENTER = [-6.1652, 106.9087];
const STORAGE_KEY = 'kgb-radar-branch-ready-v2';
const VISIT_KEY = 'kgb-radar-visits-v2';

function cleanText(value) {
  return String(value ?? '')
    .replaceAll('Â·', ' ')
    .replaceAll('â€¯', ' ')
    .replaceAll('î”®', '')
    .replaceAll('î ‹', '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !['pt', 'cv', 'tbk', 'jakarta', 'kelapa', 'gading', 'dan', 'di', 'the', 'toko', 'warung'].includes(w))
    .join(' ');
}

function toNumber(value, fallback = 0) {
  const cleaned = String(value ?? '').replace(',', '.').replace(/[^0-9.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.abs(n) : fallback;
}

function looksLikeAddress(value) {
  const text = cleanText(value);
  if (!text || text.length < 8) return false;
  const lower = text.toLowerCase();
  const badPatterns = [
    'good service', 'reasonable price', 'directions', 'reviews', 'rating', 'instagram.com',
    'facebook.com', 'whatsapp', 'http://', 'https://', 'open now', 'closed', 'buka', 'tutup'
  ];
  if (badPatterns.some((x) => lower.includes(x))) return false;
  const addressHints = [
    'jl', 'jalan', 'jln', 'komplek', 'ruko', 'blok', 'no.', 'no ', 'rt', 'rw',
    'kel.', 'kec.', 'jakarta', 'gading', 'boulevard', 'raya', 'permai', 'apartemen',
    'mall', 'tower', 'lantai', 'lt ', 'depan', 'seberang', 'samping'
  ];
  const hasHint = addressHints.some((x) => lower.includes(x));
  const hasNumber = /\d/.test(text);
  return hasHint || hasNumber;
}

function pickAddress(row, joined, fallbackName = '') {
  const addressKeys = ['address', 'alamat', 'lokasi', 'location', 'w4efsd (3)'];
  for (const key of Object.keys(row)) {
    const label = key.toLowerCase();
    if (!addressKeys.some((x) => label.includes(x))) continue;
    const value = cleanText(row[key]);
    if (looksLikeAddress(value)) return value;
  }
  const candidates = Object.values(row).map((v) => cleanText(v)).filter(Boolean);
  const best = candidates.find(looksLikeAddress);
  if (best) return best.slice(0, 180);
  if (fallbackName && looksLikeAddress(fallbackName)) return cleanText(fallbackName).slice(0, 180);
  const coord = extractCoords(joined);
  if (coord.latitude && coord.longitude) return `Lokasi tersedia dari koordinat: ${coord.latitude}, ${coord.longitude}`;
  return 'Alamat perlu validasi saat visit';
}

function googleMapsUrl(merchant) {
  if (merchant?.latitude && merchant?.longitude) {
    return `https://www.google.com/maps/search/?api=1&query=${merchant.latitude},${merchant.longitude}`;
  }
  const q = encodeURIComponent(`${merchant?.merchantName || ''} ${merchant?.address || ''}`.trim());
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function extractCoords(text) {
  const raw = String(text ?? '');
  const a = raw.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (a) return { latitude: Number(a[1]), longitude: Number(a[2]) };
  const b = raw.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (b) return { latitude: Number(b[1]), longitude: Number(b[2]) };
  const c = raw.match(/(-?\d{1,2}\.\d+)\s*,\s*(10\d\.\d+)/);
  if (c) return { latitude: Number(c[1]), longitude: Number(c[2]) };
  return { latitude: null, longitude: null };
}

function detectValue(row, candidates, matcher) {
  for (const key of Object.keys(row)) {
    const label = key.toLowerCase();
    const value = row[key];
    if (candidates.some((c) => label.includes(c)) || matcher?.(value, key)) return value;
  }
  return '';
}

function tokenSimilarity(a, b) {
  const A = new Set(normalizeName(a).split(' ').filter(Boolean));
  const B = new Set(normalizeName(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter += 1; });
  return inter / Math.max(A.size, B.size);
}

function distanceKm(a, b) {
  if (!a?.latitude || !a?.longitude || !b?.latitude || !b?.longitude) return 999;
  return turf.distance(turf.point([+a.longitude, +a.latitude]), turf.point([+b.longitude, +b.latitude]), { units: 'kilometers' });
}

function pointInPolygonName(merchant) {
  if (!merchant?.latitude || !merchant?.longitude || !areaSeed?.features) return 'Outside Area';
  try {
    const pt = turf.point([+merchant.longitude, +merchant.latitude]);
    const hit = areaSeed.features.find((f) => turf.booleanPointInPolygon(pt, f));
    return hit?.properties?.area ?? 'Outside Area';
  } catch {
    return 'Outside Area';
  }
}

function buildLvmIndex(rows = []) {
  return rows.map((r, i) => ({
    id: r.id ?? `lvm-${i}`,
    merchantName: cleanText(r.merchantName ?? r.store_name ?? r.storeName ?? r['STORE NAME'] ?? r['store_name']),
    normalizedName: normalizeName(r.merchantName ?? r.store_name ?? r.storeName ?? r['STORE NAME'] ?? r['store_name']),
    address: cleanText(r.address ?? r.alamat ?? r['ALAMAT'] ?? r['address']),
    category: cleanText(r.category ?? r.lob_lm ?? r['LOB'] ?? r['lob_lm']),
    qr: cleanText(r.qr ?? r.QR ?? (r.mid_static || r.mid_dynamic ? 'Yes' : 'No')) || 'No',
    edc: cleanText(r.edc ?? r.EDC ?? (String(r.flag_card_dongle).toUpperCase() === 'YES' ? 'Yes' : 'No')) || 'No',
    branchName: cleanText(r.branchName ?? r.nama_cabang_final ?? r['NAMA CABANG'] ?? r['nama_cabang_final']),
    sales30d: toNumber(r.sales30d ?? r.sv_30_days ?? r['SV 30 DAYS'] ?? r['sv_30_days']),
    freq30d: toNumber(r.freq30d ?? r.freq_30_days ?? r['FREQ 30 DAYS'] ?? r['freq_30_days']),
    gradingTrx: cleanText(r.gradingTrx ?? r.grading_trx ?? r['GRADING TRX'] ?? r['grading_trx'] ?? r['gradingTrx'])
  })).filter((x) => x.merchantName);
}

function findLvmMatch(merchant, lvmRows) {
  let best = null;
  let score = 0;
  for (const lvm of lvmRows) {
    const nameScore = merchant.normalizedName === lvm.normalizedName ? 1 : tokenSimilarity(merchant.merchantName, lvm.merchantName);
    const addressScore = tokenSimilarity(merchant.address, lvm.address);
    const combined = nameScore * 0.8 + addressScore * 0.2;
    if (combined > score) { best = lvm; score = combined; }
  }
  return score >= 0.72 ? { record: best, confidence: Math.round(score * 100) / 100 } : null;
}

function nearestBranch(merchant) {
  const candidates = branchSeed.filter((b) => b.latitude && b.longitude);
  const best = candidates.map((b) => ({ ...b, distanceKm: distanceKm(merchant, b) })).sort((a, b) => a.distanceKm - b.distanceKm)[0];
  return best ?? null;
}

function nearestCompetitors(merchant, radiusKm = 0.8) {
  return competitorSeed
    .filter((c) => c.latitude && c.longitude)
    .map((c) => ({ ...c, distanceKm: distanceKm(merchant, c) }))
    .filter((c) => c.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

function priorityScore(m, match) {
  const reviews = Math.min(20, Math.round((toNumber(m.reviewCount) || 0) / 5));
  const rating = Math.min(20, Math.round((toNumber(m.rating) || 0) * 4));
  const nonLvm = match ? 0 : 24;
  const hasCoords = m.latitude && m.longitude ? 10 : 0;
  const nearBranch = nearestBranch(m)?.distanceKm <= 1 ? 10 : 4;
  const competitor = nearestCompetitors(m, 0.8).length ? 8 : 0;
  return Math.min(99, Math.round(25 + reviews + rating + nonLvm + hasCoords + nearBranch + competitor));
}

function normalizeUploadedMerchant(row, index, lvmIndex) {
  const joined = Object.values(row).map((v) => cleanText(v)).filter(Boolean).join(' | ');
  const coord = extractCoords(joined);
  const latDirect = detectValue(row, ['latitude', 'lat'], (v, k) => /lat/i.test(k));
  const lngDirect = detectValue(row, ['longitude', 'lng', 'lon'], (v, k) => /lng|lon/i.test(k));
  const latitude = coord.latitude ?? toNumber(latDirect, null);
  const longitude = coord.longitude ?? toNumber(lngDirect, null);
  const name = cleanText(detectValue(row, ['merchant', 'nama', 'name', 'qbf1pd', 'tempat', 'usaha']) || `Merchant Upload ${index + 1}`);
  const category = cleanText(detectValue(row, ['category', 'kategori', 'jenis', 'w4efsd']) || 'Merchant');
  const address = pickAddress(row, joined, name);
  const rating = toNumber(detectValue(row, ['rating', 'mw4etd']), 0);
  const reviewRaw = detectValue(row, ['review', 'ulasan', 'uy7f9']);
  const reviewCount = Math.round(toNumber(reviewRaw, 0));
  const phone = cleanText(detectValue(row, ['phone', 'telepon', 'hp', 'w4efsd (5)']));
  const base = {
    id: `up-${Date.now()}-${index}`,
    merchantName: name,
    normalizedName: normalizeName(name),
    category,
    address,
    latitude: Number.isFinite(+latitude) ? +latitude : null,
    longitude: Number.isFinite(+longitude) ? +longitude : null,
    rating,
    reviewCount,
    phone,
    source: 'Easy Scrap Upload'
  };
  const match = findLvmMatch(base, lvmIndex);
  const branch = nearestBranch(base);
  const competitors = nearestCompetitors(base);
  const score = priorityScore(base, match);
  return {
    ...base,
    areaName: pointInPolygonName(base),
    lvmStatus: match ? (String(match.record?.gradingTrx || '').includes('USAK') ? 'LVM/USAK' : 'LVM UREG') : 'Non-LVM',
    priorityScore: score,
    visitStatus: 'Belum Dikunjungi',
    pipelineStatus: match ? 'Existing' : 'New Prospect',
    qrProvider: match?.record?.qr === 'Yes' ? 'Mandiri' : '',
    edcProvider: match?.record?.edc === 'Yes' ? 'Mandiri' : '',
    competitorBank: competitors[0]?.bank ?? '',
    nextFollowupDate: '',
    lastVisitDate: '',
    notes: match ? `Matched LVM confidence ${match.confidence}` : 'Prospek baru dari upload',
    branchName: branch?.name ?? 'KCP Kelapa Gading Bolevar',
    branchDistanceKm: branch?.distanceKm ? Math.round(branch.distanceKm * 100) / 100 : null,
    competitorCount: competitors.length
  };
}

function seedToMerchant(m) {
  let rawLvm = cleanText(m.lvmStatus ?? m.lvm_status ?? 'Non-LVM');
  let lvmStatus = 'Non-LVM';
  if (rawLvm === 'LVM Active' || rawLvm.includes('USAK') || rawLvm === 'LVM/USAK') {
    lvmStatus = 'LVM/USAK';
  } else if (rawLvm.includes('UREG') || rawLvm === 'LVM UREG') {
    lvmStatus = 'LVM UREG';
  }

  const base = {
    id: String(m.id ?? `seed-${Math.random()}`),
    merchantName: cleanText(m.merchantName ?? m.merchant_name),
    normalizedName: normalizeName(m.merchantName ?? m.merchant_name),
    category: cleanText(m.category),
    address: cleanText(m.address),
    latitude: Number(m.latitude),
    longitude: Number(m.longitude),
    areaName: cleanText(m.areaName ?? m.area ?? 'Unassigned'),
    lvmStatus,
    priorityScore: Math.round(toNumber(m.priorityScore ?? m.priority_score, 60)),
    visitStatus: cleanText(m.visitStatus ?? m.visit_status ?? 'Belum Dikunjungi'),
    pipelineStatus: cleanText(m.pipelineStatus ?? m.pipeline_status ?? 'New Prospect'),
    qrProvider: cleanText(m.qrProvider ?? m.qr_provider ?? ''),
    edcProvider: cleanText(m.edcProvider ?? m.edc_provider ?? ''),
    competitorBank: cleanText(m.competitorBank ?? m.competitor_bank ?? ''),
    nextFollowupDate: m.nextFollowupDate ?? m.next_followup_date ?? '',
    lastVisitDate: m.lastVisitDate ?? m.last_visit_date ?? '',
    notes: cleanText(m.notes ?? ''),
    source: cleanText(m.source ?? 'Seed Data'),
    branchName: cleanText(m.branchName ?? 'KCP Kelapa Gading Bolevar')
  };
  return { ...base, areaName: base.areaName === 'Unassigned' ? pointInPolygonName(base) : base.areaName };
}

function merchantToDb(m) {
  return {
    id: String(m.id),
    merchant_name: m.merchantName,
    category: m.category,
    address: m.address,
    latitude: m.latitude || null,
    longitude: m.longitude || null,
    area_name: m.areaName,
    lvm_status: m.lvmStatus,
    priority_score: Math.round(toNumber(m.priorityScore, 0)),
    visit_status: m.visitStatus || 'Belum Dikunjungi',
    pipeline_status: m.pipelineStatus || 'New Prospect',
    qr_provider: m.qrProvider || null,
    edc_provider: m.edcProvider || null,
    competitor_bank: m.competitorBank || null,
    next_followup_date: m.nextFollowupDate || null,
    last_visit_date: m.lastVisitDate || null,
    notes: m.notes || null,
    source: m.source || 'website',
    updated_at: new Date().toISOString()
  };
}

function dbToMerchant(r) {
  return {
    id: String(r.id),
    merchantName: r.merchant_name,
    normalizedName: normalizeName(r.merchant_name),
    category: r.category || 'Merchant',
    address: r.address || '',
    latitude: r.latitude,
    longitude: r.longitude,
    areaName: r.area_name || 'Outside Area',
    lvmStatus: r.lvm_status || 'Non-LVM',
    priorityScore: r.priority_score || 0,
    visitStatus: r.visit_status || 'Belum Dikunjungi',
    pipelineStatus: r.pipeline_status || 'New Prospect',
    qrProvider: r.qr_provider || '',
    edcProvider: r.edc_provider || '',
    competitorBank: r.competitor_bank || '',
    nextFollowupDate: r.next_followup_date || '',
    lastVisitDate: r.last_visit_date || '',
    notes: r.notes || '',
    source: r.source || 'database'
  };
}

function downloadBlob(filename, content, mime = 'text/csv;charset=utf-8;') {
  const blob = new Blob([content], { type: mime });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

function exportExcel(filename, rows, sheetName = 'DATA') {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

function recommendation(m) {
  if (m.pipelineStatus === 'Converted' || m.lvmStatus !== 'Non-LVM') return 'Maintain & aktivasi transaksi.';
  if (m.competitorBank) return `Counter ${m.competitorBank}: tawarkan QRIS/EDC + settlement Mandiri.`;
  if (m.priorityScore >= 85) return 'Visit prioritas: tawarkan QRIS Mandiri + EDC bila traffic tinggi.';
  if (m.nextFollowupDate) return `Follow-up sesuai tanggal ${m.nextFollowupDate}.`;
  return 'Prospek visit reguler dan validasi kebutuhan pembayaran.';
}

function App() {
  const [activeTab, setActiveTab] = useState('radar'); // 'radar' | 'merchants' | 'visits' | 'database'
  const [merchants, setMerchants] = useState(() => merchantSeed.slice(0, 120).map(seedToMerchant));
  const [visits, setVisits] = useState([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const [hasManualSelection, setHasManualSelection] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showVisit, setShowVisit] = useState(false);
  const [pendingRows, setPendingRows] = useState([]);
  const [pendingLvmRows, setPendingLvmRows] = useState(buildLvmIndex(lvmSeed));
  const [importSummary, setImportSummary] = useState(null);
  const [syncState, setSyncState] = useState(supabase ? 'connecting' : 'local');
  const [message, setMessage] = useState('');

  // Merchants directory page filters
  const [areaFilter, setAreaFilter] = useState('all');
  const [lvmFilter, setLvmFilter] = useState('all');
  const [mapLvmFilter, setMapLvmFilter] = useState('all');
  const [pipelineFilter, setPipelineFilter] = useState('all');
  const [sortField, setSortField] = useState('priorityScore');
  const [sortDirection, setSortDirection] = useState('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const rowsPerPage = 12;

  // Visit log page filters
  const [officerFilter, setOfficerFilter] = useState('all');

  const loadDb = useCallback(async () => {
    if (!supabase) {
      const saved = localStorage.getItem(STORAGE_KEY);
      const savedVisits = localStorage.getItem(VISIT_KEY);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) setMerchants(parsed);
        } catch (e) { console.error(e); }
      }
      if (savedVisits) {
        try {
          const parsed = JSON.parse(savedVisits);
          if (Array.isArray(parsed)) setVisits(parsed);
          else setVisits([]);
        } catch (e) {
          console.error(e);
          setVisits([]);
        }
      } else {
        setVisits([]);
      }
      setSyncState('local');
      return;
    }
    setSyncState('connecting');
    try {
      const [{ data: dbMerchants, error: em }, { data: dbVisits, error: ev }] = await Promise.all([
        supabase.from('merchants').select('*').order('priority_score', { ascending: false }),
        supabase.from('visits').select('*').order('created_at', { ascending: false })
      ]);
      if (em) throw em;
      if (ev) throw ev;
      if (dbMerchants?.length) setMerchants(dbMerchants.map(dbToMerchant));
      setVisits(dbVisits ?? []);
      setSyncState('online');
    } catch (err) {
      console.error(err);
      setSyncState('error');
      setMessage(`Database belum siap: ${err.message}. Mode lokal tetap aktif.`);
    }
  }, []);

  useEffect(() => { loadDb(); }, [loadDb]);
  const handleMerchantSelect = useCallback((merchant) => {
    setSelected(merchant);
    setHasManualSelection(true);
  }, []);

  const clearMerchantSelection = useCallback(() => {
    setSelected(null);
    setHasManualSelection(false);
  }, []);

  useEffect(() => {
    if (activeTab !== 'radar') {
      clearMerchantSelection();
      setShowVisit(false);
    }
  }, [activeTab, clearMerchantSelection]);

  useEffect(() => {
    clearMerchantSelection();
  }, [mapLvmFilter, clearMerchantSelection]);


  useEffect(() => {
    if (!supabase) localStorage.setItem(STORAGE_KEY, JSON.stringify(merchants));
  }, [merchants]);

  useEffect(() => {
    if (!supabase) localStorage.setItem(VISIT_KEY, JSON.stringify(visits));
  }, [visits]);

  const kpis = useMemo(() => {
    const total = merchants.length;
    const visited = merchants.filter((m) => m.visitStatus && m.visitStatus !== 'Belum Dikunjungi').length;
    const followup = merchants.filter((m) => ['Follow-up', 'Butuh Follow-up'].includes(m.visitStatus) || m.nextFollowupDate).length;
    const competitor = merchants.filter((m) => m.competitorBank).length;
    return { total, visited, followup, competitor };
  }, [merchants]);

  const uniqueAreas = useMemo(() => {
    const areas = merchants.map(m => m.areaName).filter(Boolean);
    return Array.from(new Set(areas));
  }, [merchants]);

  const uniqueOfficers = useMemo(() => {
    const list = Array.isArray(visits) ? visits : [];
    const officers = list.map(v => v.officer_name).filter(Boolean);
    return Array.from(new Set(officers));
  }, [visits]);

  const filtered = useMemo(() => {
    return merchants
      .filter((m) => {
        const matchesQuery = !query || `${m.merchantName} ${m.address} ${m.category} ${m.areaName} ${m.competitorBank}`.toLowerCase().includes(query.toLowerCase());
        const matchesStatus = statusFilter === 'all' || m.visitStatus === statusFilter || m.pipelineStatus === statusFilter;
        const matchesArea = areaFilter === 'all' || m.areaName === areaFilter;
        const matchesLvm = lvmFilter === 'all' || m.lvmStatus === lvmFilter;
        const matchesPipeline = pipelineFilter === 'all' || m.pipelineStatus === pipelineFilter;

        return matchesQuery && matchesStatus && matchesArea && matchesLvm && matchesPipeline;
      })
      .sort((a, b) => {
        let valA = a[sortField] ?? '';
        let valB = b[sortField] ?? '';

        if (typeof valA === 'number' && typeof valB === 'number') {
          return sortDirection === 'asc' ? valA - valB : valB - valA;
        }

        valA = String(valA).toLowerCase();
        valB = String(valB).toLowerCase();
        if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      });
  }, [merchants, query, statusFilter, areaFilter, lvmFilter, pipelineFilter, sortField, sortDirection]);


  const radarBaseMerchants = useMemo(() => {
    return merchants.filter((m) => {
      const matchesQuery = !query || `${m.merchantName} ${m.address} ${m.category} ${m.areaName} ${m.competitorBank}`.toLowerCase().includes(query.toLowerCase());
      const matchesStatus = statusFilter === 'all' || m.visitStatus === statusFilter || m.pipelineStatus === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [merchants, query, statusFilter]);

  const radarFiltered = useMemo(() => {
    return radarBaseMerchants
      .filter((m) => mapLvmFilter === 'all' || m.lvmStatus === mapLvmFilter)
      .sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));
  }, [radarBaseMerchants, mapLvmFilter]);

  const radarLvmCounts = useMemo(() => ({
    all: radarBaseMerchants.length,
    'LVM/USAK': radarBaseMerchants.filter((m) => m.lvmStatus === 'LVM/USAK').length,
    'LVM UREG': radarBaseMerchants.filter((m) => m.lvmStatus === 'LVM UREG').length,
    'Non-LVM': radarBaseMerchants.filter((m) => m.lvmStatus === 'Non-LVM').length
  }), [radarBaseMerchants]);

  // Radar Queue lists (only un-converted)
  const visitQueue = useMemo(() => {
    return merchants
      .filter((m) => !['Converted', 'Rejected', 'Existing'].includes(m.pipelineStatus))
      .filter((m) => {
        const hay = `${m.merchantName} ${m.address} ${m.category} ${m.areaName}`.toLowerCase();
        return !query || hay.includes(query.toLowerCase());
      })
      .filter((m) => statusFilter === 'all' || m.visitStatus === statusFilter)
      .sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0))
      .slice(0, 8);
  }, [merchants, query, statusFilter]);

  const paginatedMerchants = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage;
    return filtered.slice(start, start + rowsPerPage);
  }, [filtered, currentPage]);

  const totalPages = Math.ceil(filtered.length / rowsPerPage);

  const filteredVisits = useMemo(() => {
    const list = Array.isArray(visits) ? visits : [];
    return list.filter(v => officerFilter === 'all' || v.officer_name === officerFilter);
  }, [visits, officerFilter]);

  useEffect(() => {
    setCurrentPage(1);
  }, [query, statusFilter, areaFilter, lvmFilter, mapLvmFilter, pipelineFilter, sortField]);

  async function readExcelFile(file, mode) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    let ws = wb.Sheets[wb.SheetNames[0]];
    if (mode === 'lvm' && wb.SheetNames.length > 1) ws = wb.Sheets[wb.SheetNames[1]] || ws;
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (mode === 'lvm') {
      const index = buildLvmIndex(rows);
      const merged = index.length ? index : pendingLvmRows;
      setPendingLvmRows(merged);
      setImportSummary((prev) => prev ? { ...prev, lvmRead: merged.length } : { lvmRead: merged.length });
      setMessage(`Data LVM dibaca: ${merged.length} record.`);
      return;
    }
    const lvmIndex = pendingLvmRows.length ? pendingLvmRows : buildLvmIndex(lvmSeed);
    const normalized = rows.map((r, i) => normalizeUploadedMerchant(r, i, lvmIndex)).filter((m) => m.latitude && m.longitude);
    setPendingRows(normalized);
    const matchedCount = normalized.filter((m) => m.lvmStatus !== 'Non-LVM').length;
    const unmatchedCount = normalized.filter((m) => m.lvmStatus === 'Non-LVM').length;
    const summary = {
      totalRows: rows.length,
      validCoords: normalized.length,
      existing: matchedCount,
      nonLvm: unmatchedCount,
      highPriority: normalized.filter((m) => m.priorityScore >= 70).length,
      needReview: rows.length - normalized.length,
      merchantRead: rows.length,
      lvmRead: lvmIndex.length,
      matched: matchedCount,
      unmatched: unmatchedCount,
      readyForMap: normalized.length
    };
    setImportSummary(summary);
    setMessage(`Easy Scrap dibaca: ${normalized.length} titik valid dari ${rows.length} baris.`);
  }

  async function publishImport() {
    if (!pendingRows.length) return setMessage('Belum ada data Easy Scrap valid untuk dipublish.');
    const merged = [...pendingRows, ...merchants.filter((m) => !m.source?.includes('Easy Scrap Upload'))];
    setMerchants(merged);
    setPendingRows([]);
    setImportSummary(null);
    if (supabase) {
      const { error } = await supabase.from('merchants').upsert(merged.map(merchantToDb), { onConflict: 'id' });
      if (error) return setMessage(`Gagal sync Supabase: ${error.message}`);
      setSyncState('online');
    }
    setMessage('Data sudah dipublish ke radar.');
    setShowImport(false);
  }

  async function saveVisit(form) {
    const m = selected;
    if (!m) return;
    const visitRecord = {
      merchant_id: String(m.id),
      visit_date: form.visitDate,
      officer_name: form.officerName,
      visit_result: form.visitResult,
      pic_name: form.picName,
      pic_phone: form.picPhone,
      qr_provider: form.qrProvider,
      edc_provider: form.edcProvider,
      competitor_bank: form.competitorBank,
      mandiri_opportunity: form.mandiriOpportunity,
      next_action: form.nextAction,
      next_followup_date: form.nextFollowupDate || null,
      notes: form.notes
    };
    const status = form.visitResult === 'Sudah Onboarding' ? 'Sudah Dikunjungi' : form.visitResult === 'Menolak' ? 'Tidak Berminat' : form.nextFollowupDate ? 'Follow-up' : 'Sudah Dikunjungi';
    const pipeline = form.visitResult === 'Sudah Onboarding' ? 'Converted' : form.visitResult === 'Siap Onboarding' ? 'Onboarding' : form.visitResult === 'Tertarik' ? 'Interested' : form.visitResult === 'Menolak' ? 'Rejected' : form.nextFollowupDate ? 'Follow-up' : 'Visited';
    const updatedMerchant = {
      ...m,
      visitStatus: status,
      pipelineStatus: pipeline,
      lastVisitDate: form.visitDate,
      qrProvider: form.qrProvider,
      edcProvider: form.edcProvider,
      competitorBank: form.competitorBank,
      nextFollowupDate: form.nextFollowupDate,
      notes: form.notes || m.notes
    };
    setMerchants((prev) => prev.map((x) => String(x.id) === String(m.id) ? updatedMerchant : x));
    setSelected(updatedMerchant);
    if (supabase) {
      const { error: e1 } = await supabase.from('visits').insert(visitRecord);
      const { error: e2 } = await supabase.from('merchants').upsert(merchantToDb(updatedMerchant), { onConflict: 'id' });
      if (e1 || e2) return setMessage(`Gagal simpan ke Supabase: ${(e1 || e2).message}`);
      setVisits((prev) => [{ ...visitRecord, id: crypto.randomUUID(), created_at: new Date().toISOString() }, ...prev]);
    } else {
      setVisits((prev) => [{ ...visitRecord, id: crypto.randomUUID(), created_at: new Date().toISOString() }, ...prev]);
    }
    setShowVisit(false);
    setMessage('Visit merchant berhasil dicatat.');
  }

  async function pushSeedToDb() {
    if (!supabase) return setMessage('Supabase belum dikonfigurasi. Tambahkan env VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY di Vercel.');
    const { error } = await supabase.from('merchants').upsert(merchants.map(merchantToDb), { onConflict: 'id' });
    if (error) return setMessage(`Gagal upload seed: ${error.message}`);
    setMessage('Data merchant saat ini sudah disinkronkan ke Supabase.');
    setSyncState('online');
  }

  function handleSort(field) {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  }

  function exportPriority() {
    const rows = visitQueue.map((m) => ({
      merchant_name: m.merchantName,
      category: m.category,
      address: m.address,
      area: m.areaName,
      score: m.priorityScore,
      lvm_status: m.lvmStatus,
      visit_status: m.visitStatus,
      competitor_bank: m.competitorBank,
      recommendation: recommendation(m)
    }));
    exportExcel(`KGB-RADAR-priority-list-${new Date().toISOString().slice(0, 10)}.xlsx`, rows, 'PRIORITY');
  }

  function exportVisitReport() {
    const rows = merchants.map((m) => ({
      merchant_name: m.merchantName,
      category: m.category,
      address: m.address,
      area: m.areaName,
      score: m.priorityScore,
      lvm_status: m.lvmStatus,
      pipeline_status: m.pipelineStatus,
      visit_status: m.visitStatus,
      last_visit_date: m.lastVisitDate,
      next_followup_date: m.nextFollowupDate,
      qr_provider: m.qrProvider,
      edc_provider: m.edcProvider,
      competitor_bank: m.competitorBank,
      notes: m.notes
    }));
    exportExcel(`KGB-RADAR-visit-report-${new Date().toISOString().slice(0, 10)}.xlsx`, rows, 'VISIT_REPORT');
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-section">
          <div className="brand-logo">
            <MapPinned size={22} className="logo-icon" />
            <div className="radar-pulse"></div>
          </div>
          <div className="brand-info">
            <span className="brand-title">KGB-RADAR</span>
            <span className="brand-subtitle">Command Center</span>
          </div>
        </div>

        <nav className="nav-menu">
          <button className={`nav-item ${activeTab === 'radar' ? 'active' : ''}`} onClick={() => { setActiveTab('radar'); }}>
            <MapPinned size={20} className="nav-icon" />
            <span className="nav-label">Radar Map</span>
          </button>
          <button className={`nav-item ${activeTab === 'merchants' ? 'active' : ''}`} onClick={() => { setActiveTab('merchants'); clearMerchantSelection(); }}>
            <Target size={20} className="nav-icon" />
            <span className="nav-label">Merchant Directory</span>
          </button>
          <button className={`nav-item ${activeTab === 'visits' ? 'active' : ''}`} onClick={() => { setActiveTab('visits'); clearMerchantSelection(); }}>
            <ClipboardCheck size={20} className="nav-icon" />
            <span className="nav-label">Visit Logs</span>
          </button>
          <button className={`nav-item ${activeTab === 'database' ? 'active' : ''}`} onClick={() => { setActiveTab('database'); clearMerchantSelection(); }}>
            <Database size={20} className="nav-icon" />
            <span className="nav-label">Database Sync</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="user-profile">
            <div className="user-avatar">AD</div>
            <div className="user-info">
              <span className="user-name">Admin</span>
              <span className="user-role">KGB-RADAR Operator</span>
            </div>
          </div>
          <div className="sync-status-widget">
            <div className={`status-dot ${syncState}`}></div>
            <span className="status-text">
              {syncState === 'online' ? 'Supabase Connected' : syncState === 'local' ? 'Local Storage' : 'Connecting...'}
            </span>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">Branch-ready merchant command center</div>
            <h1>KGB-RADAR</h1>
            <p>Kelapa Gading Bolevar · Mapping, visit tracking, QR/EDC competitor capture</p>
          </div>
          <div className="top-actions">
            <div className={`sync-pill ${syncState}`}>
              {syncState === 'online' ? <Wifi size={16} /> : <WifiOff size={16} />}
              {syncState === 'online' ? 'Supabase Online' : syncState === 'local' ? 'Local Mode' : syncState === 'connecting' ? 'Connecting DB' : 'DB Error'}
            </div>
            <button className="btn ghost" onClick={loadDb}><RefreshCcw size={17} />Refresh</button>
            {activeTab === 'radar' && (
              <>
                <button className="btn yellow" onClick={() => setShowImport(true)}><Upload size={17} />Data Import</button>
                <button className="btn blue" onClick={exportVisitReport}><Download size={17} />Export Report</button>
              </>
            )}
          </div>
        </header>

        {message && <div className="message"><AlertTriangle size={16} />{message}<button onClick={() => setMessage('')}>×</button></div>}

        {activeTab === 'radar' && (
          <section className="kpi-row">
            <Kpi label="Merchant Terpetakan" value={kpis.total} note="titik valid di radar" icon={<Target />} />
            <Kpi label="Belum Visit" value={merchants.filter((m) => m.visitStatus === 'Belum Dikunjungi').length} note="butuh kunjungan awal" icon={<Route />} />
            <Kpi label="Follow-up Aktif" value={kpis.followup} note="punya next action" icon={<CalendarDays />} />
            <Kpi label="Non-LVM" value={merchants.filter((m) => m.lvmStatus === 'Non-LVM').length} note="prospek akuisisi" icon={<Users />} />
          </section>
        )}

        {/* Tab 1: Radar View (Peta & Queue) */}
        {activeTab === 'radar' && (
          <div className="tab-content">
            <section className="content-grid">
              <div className="map-panel">
                <div className="toolbar radar-toolbar">
                  <div className="searchbox"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari merchant, area, alamat, kompetitor..." /></div>
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter status kunjungan merchant">
                    <option value="all">Semua status visit</option>
                    <option value="Belum Dikunjungi">Belum Dikunjungi</option>
                    <option value="Sudah Dikunjungi">Sudah Dikunjungi</option>
                    <option value="Follow-up">Follow-up</option>
                    <option value="Tidak Berminat">Tidak Berminat</option>
                    <option value="Converted">Converted</option>
                  </select>
                  <button className="btn ghost sync-db-btn" onClick={pushSeedToDb}><Database size={16} />Sync DB</button>
                </div>
                <div className="map-filter-strip" aria-label="Filter titik merchant yang tampil di peta berdasarkan status LVM">
                  <div className="map-filter-copy">
                    <strong>Filter titik di peta</strong>
                  </div>
                  <div className="map-filter-chips">
                    <button className={mapLvmFilter === 'all' ? 'active' : ''} onClick={() => setMapLvmFilter('all')}>
                      Semua <b>{radarLvmCounts.all}</b>
                    </button>
                    <button className={mapLvmFilter === 'LVM/USAK' ? 'active green' : 'green'} onClick={() => setMapLvmFilter('LVM/USAK')}>
                      LVM Active <b>{radarLvmCounts['LVM/USAK']}</b>
                    </button>
                    <button className={mapLvmFilter === 'LVM UREG' ? 'active red' : 'red'} onClick={() => setMapLvmFilter('LVM UREG')}>
                      LVM Inactive <b>{radarLvmCounts['LVM UREG']}</b>
                    </button>
                    <button className={mapLvmFilter === 'Non-LVM' ? 'active orange' : 'orange'} onClick={() => setMapLvmFilter('Non-LVM')}>
                      Non-LVM <b>{radarLvmCounts['Non-LVM']}</b>
                    </button>
                  </div>
                </div>
                <RadarMap merchants={radarFiltered} selected={hasManualSelection ? selected : null} onSelect={handleMerchantSelect} />
                <div className="insight-strip">
                  <Insight title="Area Focus" text={`${radarFiltered.filter((m) => m.priorityScore >= 80).length} high-priority merchant aktif di filter peta.`} />
                  <Insight title="Visit Gap" text={`${radarFiltered.filter((m) => m.visitStatus === 'Belum Dikunjungi').length} merchant belum memiliki catatan visit pada filter ini.`} />
                  <Insight title="Jumlah Pin" text={`${radarFiltered.length} titik merchant sedang tampil di peta.`} />
                </div>
              </div>

              <aside className="right-panel">
                <MerchantDetailPanel
                  merchant={hasManualSelection ? selected : null}
                  onVisit={() => setShowVisit(true)}
                  visits={hasManualSelection && selected ? (Array.isArray(visits) ? visits.filter((v) => String(v.merchant_id) === String(selected.id)) : []) : []}
                />
              </aside>
            </section>
          </div>
        )}

        {/* Tab 2: Merchant Directory (Tabel lengkap) */}
        {activeTab === 'merchants' && (
          <div className="tab-content">
            <div className="directory-card">
              <div className="directory-header">
                <h2>Merchant Directory</h2>
                <div className="directory-filters">
                  <div className="searchbox" style={{ width: '260px' }}>
                    <Search size={16} />
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari merchant..." />
                  </div>
                  <select value={areaFilter} onChange={(e) => setAreaFilter(e.target.value)}>
                    <option value="all">Semua Area</option>
                    {uniqueAreas.map(area => <option key={area} value={area}>{area}</option>)}
                  </select>
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                    <option value="all">Semua Visit Status</option>
                    <option value="Belum Dikunjungi">Belum Dikunjungi</option>
                    <option value="Sudah Dikunjungi">Sudah Dikunjungi</option>
                    <option value="Follow-up">Follow-up</option>
                    <option value="Tidak Berminat">Tidak Berminat</option>
                  </select>
                  <select value={lvmFilter} onChange={(e) => setLvmFilter(e.target.value)}>
                    <option value="all">Semua LVM Status</option>
                    <option value="LVM/USAK">LVM/USAK</option>
                    <option value="LVM UREG">LVM UREG</option>
                    <option value="Non-LVM">Non-LVM</option>
                  </select>
                  <select value={pipelineFilter} onChange={(e) => setPipelineFilter(e.target.value)}>
                    <option value="all">Semua Pipeline</option>
                    <option value="New Prospect">New Prospect</option>
                    <option value="Interested">Interested</option>
                    <option value="Visited">Visited</option>
                    <option value="Follow-up">Follow-up</option>
                    <option value="Onboarding">Onboarding</option>
                    <option value="Converted">Converted</option>
                    <option value="Rejected">Rejected</option>
                  </select>
                </div>
              </div>

              <div className="table-wrap">
                <table className="table-merchant">
                  <thead>
                    <tr>
                      <th onClick={() => handleSort('merchantName')}>
                        <div className="th-content">
                          Merchant Name
                          <span className={`sort-icon ${sortField === 'merchantName' ? 'active' : ''}`}>
                            {sortField === 'merchantName' ? (sortDirection === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : <ChevronDown size={14} />}
                          </span>
                        </div>
                      </th>
                      <th onClick={() => handleSort('category')}>
                        <div className="th-content">
                          Category
                          <span className={`sort-icon ${sortField === 'category' ? 'active' : ''}`}>
                            {sortField === 'category' ? (sortDirection === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : <ChevronDown size={14} />}
                          </span>
                        </div>
                      </th>
                      <th onClick={() => handleSort('areaName')}>
                        <div className="th-content">
                          Area
                          <span className={`sort-icon ${sortField === 'areaName' ? 'active' : ''}`}>
                            {sortField === 'areaName' ? (sortDirection === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : <ChevronDown size={14} />}
                          </span>
                        </div>
                      </th>
                      <th onClick={() => handleSort('lvmStatus')}>
                        <div className="th-content">
                          LVM Status
                          <span className={`sort-icon ${sortField === 'lvmStatus' ? 'active' : ''}`}>
                            {sortField === 'lvmStatus' ? (sortDirection === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : <ChevronDown size={14} />}
                          </span>
                        </div>
                      </th>
                      <th onClick={() => handleSort('priorityScore')}>
                        <div className="th-content">
                          Score
                          <span className={`sort-icon ${sortField === 'priorityScore' ? 'active' : ''}`}>
                            {sortField === 'priorityScore' ? (sortDirection === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : <ChevronDown size={14} />}
                          </span>
                        </div>
                      </th>
                      <th onClick={() => handleSort('visitStatus')}>
                        <div className="th-content">
                          Visit Status
                          <span className={`sort-icon ${sortField === 'visitStatus' ? 'active' : ''}`}>
                            {sortField === 'visitStatus' ? (sortDirection === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : <ChevronDown size={14} />}
                          </span>
                        </div>
                      </th>
                      <th onClick={() => handleSort('competitorBank')}>
                        <div className="th-content">
                          Competitor
                          <span className={`sort-icon ${sortField === 'competitorBank' ? 'active' : ''}`}>
                            {sortField === 'competitorBank' ? (sortDirection === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : <ChevronDown size={14} />}
                          </span>
                        </div>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedMerchants.map((m) => (
                      <tr key={m.id}>
                        <td><strong>{m.merchantName}</strong><div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>{m.address.slice(0, 50)}...</div></td>
                        <td>{m.category}</td>
                        <td>{m.areaName}</td>
                        <td>
                          <span className={`badge ${
                            m.lvmStatus === 'LVM/USAK' ? 'green' :
                            m.lvmStatus === 'LVM UREG' ? 'red' : 'orange'
                          }`}>
                            {m.lvmStatus}
                          </span>
                        </td>
                        <td><strong style={{ color: 'var(--mandiri-gold)' }}>{Math.round(m.priorityScore)}</strong></td>
                        <td>
                          <span className={`badge ${
                            m.visitStatus === 'Sudah Dikunjungi' ? 'green' :
                            m.visitStatus === 'Follow-up' ? 'orange' :
                            m.visitStatus === 'Tidak Berminat' ? 'red' : 'yellow'
                          }`}>
                            {m.visitStatus}
                          </span>
                        </td>
                        <td>{m.competitorBank ? <span className="badge red">{m.competitorBank}</span> : '-'}</td>
                      </tr>
                    ))}
                    {paginatedMerchants.length === 0 && (
                      <tr>
                        <td colSpan="7" style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>Tidak ada data merchant ditemukan.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="pagination">
                <span>Menampilkan {filtered.length > 0 ? (currentPage - 1) * rowsPerPage + 1 : 0} - {Math.min(currentPage * rowsPerPage, filtered.length)} dari {filtered.length} item</span>
                <div className="page-controls">
                  <button className="btn ghost small" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}><ChevronLeft size={16} /></button>
                  <span style={{ margin: '0 8px', fontWeight: 'bold' }}>Page {currentPage} of {totalPages || 1}</span>
                  <button className="btn ghost small" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}><ChevronRight size={16} /></button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Visit Logs (Histori Kunjungan) */}
        {activeTab === 'visits' && (
          <div className="tab-content">
            <div className="logs-grid">
              <div className="logs-list-card">
                <div className="directory-header">
                  <h2>KGB Visit Logs</h2>
                  <div className="directory-filters">
                    <select value={officerFilter} onChange={(e) => setOfficerFilter(e.target.value)}>
                      <option value="all">Semua Petugas (RM/Sales)</option>
                      {uniqueOfficers.map(off => <option key={off} value={off}>{off}</option>)}
                    </select>
                  </div>
                </div>

                <div className="logs-scrollable">
                  {filteredVisits.map((v) => {
                    const m = merchants.find((x) => String(x.id) === String(v.merchant_id));
                    return (
                      <div className="log-item-card" key={v.id}>
                        <div className="log-item-header">
                          <div>
                            <h3>{m ? m.merchantName : `Merchant #${v.merchant_id}`}</h3>
                            <div className="log-item-meta" style={{ marginTop: '4px' }}>
                              <span><CalendarDays size={14} /> {v.visit_date}</span>
                              <span><Users size={14} /> Petugas: <b>{v.officer_name || '-'}</b></span>
                              <span>PIC: <b>{v.pic_name || '-'} ({v.pic_phone || '-'})</b></span>
                            </div>
                          </div>
                          <span className={`badge ${
                            v.visit_result === 'Sudah Onboarding' || v.visit_result === 'Berhasil ditemui' ? 'green' :
                            v.visit_result === 'Tertarik' || v.visit_result === 'Siap Onboarding' ? 'blue' :
                            v.visit_result === 'Menolak' ? 'red' : 'orange'
                          }`}>
                            {v.visit_result}
                          </span>
                        </div>

                        {v.notes && (
                          <div className="log-item-body">
                            <strong>Catatan:</strong> {v.notes}
                            {v.next_action && <div style={{ marginTop: '4px' }}><strong>Tindakan Lanjut:</strong> {v.next_action}</div>}
                          </div>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                          <div className="log-item-opportunities">
                            {v.mandiri_opportunity && v.mandiri_opportunity.map((opp, idx) => (
                              <span key={idx}>{opp}</span>
                            ))}
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {v.qr_provider && <span>QRIS: <b>{v.qr_provider}</b> </span>}
                            {v.edc_provider && <span>EDC: <b>{v.edc_provider}</b> </span>}
                            {v.competitor_bank && <span>Kompetitor: <b style={{ color: 'var(--red)' }}>{v.competitor_bank}</b></span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {filteredVisits.length === 0 && (
                    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Belum ada catatan log kunjungan.</div>
                  )}
                </div>
              </div>

              {/* Visit Stats Panel */}
              <div className="stats-panel">
                <h3>Visit Statistics</h3>
                <div className="stats-list">
                  <div className="stat-row">
                    <label>Total Kunjungan</label>
                    <span>{visits.length}</span>
                  </div>
                  <div className="stat-row">
                    <label>Sudah Onboarding</label>
                    <span style={{ color: 'var(--green)' }}>{visits.filter(v => v.visit_result === 'Sudah Onboarding').length}</span>
                  </div>
                  <div className="stat-row">
                    <label>Siap Onboarding</label>
                    <span style={{ color: 'var(--blue)' }}>{visits.filter(v => v.visit_result === 'Siap Onboarding').length}</span>
                  </div>
                  <div className="stat-row">
                    <label>Tertarik Prospek</label>
                    <span style={{ color: 'var(--mandiri-gold)' }}>{visits.filter(v => v.visit_result === 'Tertarik').length}</span>
                  </div>
                  <div className="stat-row">
                    <label>Menolak/Tidak Minat</label>
                    <span style={{ color: 'var(--red)' }}>{visits.filter(v => v.visit_result === 'Menolak').length}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: Database Panel (Sinkronisasi & Control Room) */}
        {activeTab === 'database' && (
          <div className="tab-content">
            <div className="db-grid">
              <div className="db-card">
                <div className="db-header">
                  <h2>Database Sync & Operations</h2>
                  <p>Sinkronisasi data ke cloud server Supabase untuk kolaborasi RM/Sales secara real-time.</p>
                </div>
                <div className="db-actions-row" style={{ marginTop: '10px' }}>
                  <button className="btn blue" onClick={pushSeedToDb} disabled={!supabase}><Database size={16} />Sync DB (Supabase)</button>
                  <button className="btn ghost" onClick={exportVisitReport}><FileSpreadsheet size={16} />Export excel visit report</button>
                </div>
              </div>

              {/* Status panel */}
              <div className="stats-panel">
                <h3>Integrasi Status</h3>
                <div className="status-grid">
                  <div className="status-card">
                    <h4>Supabase</h4>
                    <span className={`status-val ${syncState === 'online' ? 'green' : 'red'}`} style={{ fontSize: '16px', fontWeight: 'bold' }}>
                      {syncState === 'online' ? 'Terhubung' : 'Lokal Mode'}
                    </span>
                  </div>
                  <div className="status-card">
                    <h4>Merchant</h4>
                    <span className="status-val">{merchants.length}</span>
                  </div>
                  <div className="status-card">
                    <h4>Visit Logs</h4>
                    <span className="status-val">{Array.isArray(visits) ? visits.length : 0}</span>
                  </div>
                  <div className="status-card">
                    <h4>LVM Index</h4>
                    <span className="status-val">{pendingLvmRows.length}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {showImport && <ImportModal onClose={() => setShowImport(false)} onRead={readExcelFile} summary={importSummary} onPublish={publishImport} pendingCount={pendingRows.length} lvmCount={pendingLvmRows.length} />}
      {activeTab === 'radar' && showVisit && hasManualSelection && selected && <VisitModal merchant={selected} onClose={() => setShowVisit(false)} onSave={saveVisit} />}
    </div>
  );
}

function Kpi({ label, value, note, icon }) {
  return <div className="kpi"><div className="kpi-icon">{icon}</div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function Insight({ title, text }) {
  return <div className="insight"><strong>{title}</strong><span>{text}</span></div>;
}

function markerClass(m) {
  if (m.lvmStatus === 'LVM/USAK') return 'marker-green';
  if (m.lvmStatus === 'LVM UREG') return 'marker-red';
  return 'marker-orange'; // Non-LVM
}

function RadarMap({ merchants, selected, onSelect }) {
  const mapRef = useRef(null);
  const divRef = useRef(null);
  const layersRef = useRef(null);

  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, { zoomControl: false }).setView(KG_CENTER, 14);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(map);
    layersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layersRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    try {
      L.geoJSON(areaSeed, { style: { color: '#0057A8', weight: 2, fillColor: '#0B74D1', fillOpacity: 0.07, dashArray: '6 6' } }).addTo(layer);
    } catch {}

    branchSeed.forEach((b) => {
      if (!b.latitude || !b.longitude) return;
      L.circle([b.latitude, b.longitude], { radius: 550, color: '#FFB600', fillColor: '#FFB600', fillOpacity: 0.08, weight: 1 }).addTo(layer);
      L.marker([b.latitude, b.longitude], { icon: L.divIcon({ className: 'branch-pin', html: '<span>BM</span>', iconSize: [34, 34] }) }).bindPopup(`<b>${b.name}</b><br/>${b.area}`).addTo(layer);
    });

    competitorSeed.forEach((c) => {
      if (!c.latitude || !c.longitude) return;
      L.marker([c.latitude, c.longitude], { icon: L.divIcon({ className: 'competitor-pin', html: c.bank, iconSize: [30, 24] }) }).bindPopup(`<b>${c.bank}</b><br/>${c.name}`).addTo(layer);
    });

    merchants.forEach((m) => {
      if (!m.latitude || !m.longitude) return;
      const isSelected = selected?.id === m.id;
      const icon = L.divIcon({
        className: `merchant-pin ${markerClass(m)} ${isSelected ? 'active' : ''}`,
        html: `<span>${Math.round(m.priorityScore || 0)}</span>`,
        iconSize: [34, 34]
      });
      const marker = L.marker([m.latitude, m.longitude], { icon }).addTo(layer);
      marker.on('click', () => onSelect(m));
      marker.bindTooltip(m.merchantName, { direction: 'top', offset: [0, -14] });
    });
  }, [merchants, selected, onSelect]);

  return (
    <div className="map-wrap">
      <div className="legend floating-card">
        <div><span className="dot green" />LVM/USAK</div>
        <div><span className="dot red" />LVM UREG</div>
        <div><span className="dot orange" />Non-LVM</div>
      </div>
      <div className="layer-note floating-card"><Layers size={15} />Merchant · Cabang · Kompetitor · Area</div>
      <div className="leaflet-host" ref={divRef} />
    </div>
  );
}

function MerchantDetailPanel({ merchant, onVisit, visits }) {
  if (!merchant) {
    return (
      <div className="detail-empty">
        <div className="panel-head compact">
          <div>
            <div className="eyebrow">Merchant Detail</div>
            <h2>Pilih Merchant</h2>
          </div>
        </div>
        <div className="empty-state-card empty-state-radar no-merchant-state">
          <div className="empty-orb"><MapPinned size={30} /></div>
          <div>
            <strong>Belum ada merchant dipilih</strong>
            <p>Klik salah satu pin pada peta untuk melihat detail merchant. Panel ini sengaja kosong agar tidak menampilkan rekomendasi yang belum dipilih.</p>
          </div>
          <div className="empty-guide-grid">
            <div><b>1</b><span>Filter titik di peta</span></div>
            <div><b>2</b><span>Klik pin merchant</span></div>
            <div><b>3</b><span>Catat hasil visit</span></div>
          </div>
          <div className="empty-tip">Detail yang muncul setelah klik pin: status LVM, QRIS/EDC, alamat, tombol Google Maps, dan rekomendasi tindak lanjut.</div>
        </div>
      </div>
    );
  }

  const lvmClass = merchant.lvmStatus === 'LVM/USAK' ? 'success' : merchant.lvmStatus === 'LVM UREG' ? 'danger' : 'warning';
  const lvmLabel = merchant.lvmStatus === 'LVM/USAK' ? 'LVM Active' : merchant.lvmStatus === 'LVM UREG' ? 'LVM Inactive' : 'Non-LVM';

  return (
    <div className="merchant-detail-card selected-merchant-card">
      <div className="panel-head compact detail-title-row">
        <div>
          <div className="eyebrow">Merchant Detail</div>
          <h2>Profil Merchant</h2>
        </div>
        <span className="selected-chip">Dipilih dari peta</span>
      </div>
      <div className="detail-hero selected-detail-hero">
        <div className="drawer-score">{Math.round(merchant.priorityScore || 0)}</div>
        <div>
          <h3>{merchant.merchantName}</h3>
          <p>{merchant.category} · {merchant.areaName}</p>
        </div>
      </div>
      <div className="badges detail-badges">
        <span className={lvmClass}>{lvmLabel}</span>
        <span>{merchant.visitStatus}</span>
        {merchant.competitorBank && <span className="danger">Kompetitor: {merchant.competitorBank}</span>}
      </div>
      <button className="btn yellow full" onClick={onVisit}><ClipboardCheck size={17} />Catat / Update Visit</button>
      <section className="drawer-section detail-address-card">
        <div className="section-title-row">
          <strong>Alamat Merchant</strong>
          <a className="map-mini-btn" href={googleMapsUrl(merchant)} target="_blank" rel="noreferrer">
            <MapPinned size={14} />Buka Maps
          </a>
        </div>
        <p>{merchant.address || 'Alamat perlu validasi saat visit'}</p>
      </section>
      <section className="drawer-section grid2 detail-metric-grid">
        <div><strong>QRIS</strong><p>{merchant.qrProvider || '-'}</p></div>
        <div><strong>EDC</strong><p>{merchant.edcProvider || '-'}</p></div>
        <div><strong>Last Visit</strong><p>{merchant.lastVisitDate || '-'}</p></div>
        <div><strong>Next Follow-up</strong><p>{merchant.nextFollowupDate || '-'}</p></div>
      </section>
      <section className="drawer-section recommendation-box">
        <strong>Rekomendasi Tindakan</strong>
        <p>{recommendation(merchant)}</p>
      </section>
      <section className="drawer-section">
        <strong>Visit History</strong>
        {visits.length ? visits.slice(0, 4).map((v) => (
          <div className="timeline" key={v.id}>
            <b>{v.visit_date}</b>
            <span>{v.visit_result} · {v.officer_name || 'Petugas'}</span>
            <small>{v.notes || v.next_action}</small>
          </div>
        )) : <p>Belum ada catatan visit.</p>}
      </section>
    </div>
  );
}

function MerchantDrawer({ merchant, visits, onClose, onVisit }) {
  return (
    <aside className="drawer">
      <button className="close" onClick={onClose}><X /></button>
      <div className="drawer-score">{Math.round(merchant.priorityScore)}</div>
      <h2>{merchant.merchantName}</h2>
      <p>{merchant.category} · {merchant.areaName}</p>
      <div className="badges">
        <span className={
          merchant.lvmStatus === 'LVM/USAK' ? 'success' :
          merchant.lvmStatus === 'LVM UREG' ? 'danger' : 'warning'
        }>{merchant.lvmStatus}</span>
        <span>{merchant.visitStatus}</span>
        {merchant.competitorBank && <span className="danger">{merchant.competitorBank}</span>}
      </div>
      <button className="btn yellow full" onClick={onVisit}><ClipboardCheck size={17} />Catat / Update Visit</button>
      <section className="drawer-section">
        <div className="section-title-row">
          <strong>Alamat</strong>
          <a className="map-mini-btn" href={googleMapsUrl(merchant)} target="_blank" rel="noreferrer"><MapPinned size={14} />Buka Maps</a>
        </div>
        <p>{merchant.address}</p>
      </section>
      <section className="drawer-section grid2">
        <div><strong>QRIS</strong><p>{merchant.qrProvider || '-'}</p></div>
        <div><strong>EDC</strong><p>{merchant.edcProvider || '-'}</p></div>
        <div><strong>Last Visit</strong><p>{merchant.lastVisitDate || '-'}</p></div>
        <div><strong>Next Follow-up</strong><p>{merchant.nextFollowupDate || '-'}</p></div>
      </section>
      <section className="drawer-section">
        <strong>Rekomendasi</strong>
        <p>{recommendation(merchant)}</p>
      </section>
      <section className="drawer-section">
        <strong>Visit History</strong>
        {visits.length ? visits.slice(0, 5).map((v) => <div className="timeline" key={v.id}><b>{v.visit_date}</b><span>{v.visit_result} · {v.officer_name || 'Petugas'}</span><small>{v.notes || v.next_action}</small></div>) : <p>Belum ada catatan visit.</p>}
      </section>
    </aside>
  );
}

function ImportModal({ onClose, onRead, summary, onPublish, pendingCount, lvmCount }) {
  return (
    <div className="modal-backdrop">
      <div className="modal import-modal">
        <button className="close" onClick={onClose}><X /></button>
        <div className="modal-title"><FileSpreadsheet /><div><h2>Data Import Center</h2><p>Upload data mentah Easy Scrap dan LVM. Informasi lain disembunyikan agar cabang fokus pada prospek dan visit.</p></div></div>
        <div className="upload-grid">
          <label className="upload-box">
            <Upload /><strong>Upload Easy Scrap</strong><span>Excel hasil scrap merchant</span>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files?.[0] && onRead(e.target.files[0], 'merchant')} />
          </label>
          <label className="upload-box">
            <Database /><strong>Upload LVM Existing</strong><span>Untuk matching merchant Mandiri</span>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files?.[0] && onRead(e.target.files[0], 'lvm')} />
          </label>
        </div>
        <div className="summary-card">
          <strong>Import Summary</strong>
          <div className="summary-grid">
            <span>Merchant terbaca dari Easy Scrap <b>{summary?.merchantRead ?? pendingCount}</b></span>
            <span>Data LVM terbaca <b>{summary?.lvmRead ?? lvmCount}</b></span>
            <span>Berhasil dicocokkan <b>{summary?.matched ?? 0}</b></span>
            <span>Belum cocok <b>{summary?.unmatched ?? 0}</b></span>
            <span>Siap ditampilkan di maps <b>{summary?.readyForMap ?? pendingCount}</b></span>
          </div>
        </div>
        <div className="modal-actions"><button className="btn ghost" onClick={onClose}>Batal</button><button className="btn blue" onClick={onPublish}><Save size={16} />Publish to Radar</button></div>
      </div>
    </div>
  );
}

function VisitModal({ merchant, onClose, onSave }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    visitDate: today,
    officerName: '',
    visitResult: 'Berhasil ditemui',
    picName: '',
    picPhone: '',
    qrProvider: merchant.qrProvider || '',
    edcProvider: merchant.edcProvider || '',
    competitorBank: merchant.competitorBank || '',
    mandiriOpportunity: [],
    nextAction: 'Follow-up pricing/MDR',
    nextFollowupDate: '',
    notes: merchant.notes || ''
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleOpp = (value) => setForm((f) => ({ ...f, mandiriOpportunity: f.mandiriOpportunity.includes(value) ? f.mandiriOpportunity.filter((x) => x !== value) : [...f.mandiriOpportunity, value] }));
  return (
    <div className="modal-backdrop">
      <div className="modal visit-modal">
        <button className="close" onClick={onClose}><X /></button>
        <div className="modal-title"><ClipboardCheck /><div><h2>Catat Kunjungan</h2><p>{merchant.merchantName} · Score {Math.round(merchant.priorityScore)}</p></div></div>
        <div className="form-grid">
          <label>Tanggal visit<input type="date" value={form.visitDate} onChange={(e) => set('visitDate', e.target.value)} /></label>
          <label>Nama petugas<input value={form.officerName} onChange={(e) => set('officerName', e.target.value)} placeholder="Nama RM/Sales" /></label>
          <label>Status hasil<select value={form.visitResult} onChange={(e) => set('visitResult', e.target.value)}><option>Berhasil ditemui</option><option>Tidak bertemu PIC</option><option>Tertarik</option><option>Butuh follow-up</option><option>Siap Onboarding</option><option>Sudah Onboarding</option><option>Menolak</option></select></label>
          <label>PIC merchant<input value={form.picName} onChange={(e) => set('picName', e.target.value)} placeholder="Nama owner/PIC" /></label>
          <label>No. HP PIC<input value={form.picPhone} onChange={(e) => set('picPhone', e.target.value)} placeholder="08xx" /></label>
          <label>QRIS provider<select value={form.qrProvider} onChange={(e) => set('qrProvider', e.target.value)}><option value="">Tidak diketahui</option><option>Mandiri</option><option>BCA</option><option>BRI</option><option>BNI</option><option>CIMB</option><option>ShopeePay</option><option>GoPay</option><option>OVO</option><option>DANA</option><option>Lainnya</option></select></label>
          <label>EDC provider<select value={form.edcProvider} onChange={(e) => set('edcProvider', e.target.value)}><option value="">Tidak diketahui</option><option>Mandiri</option><option>BCA</option><option>BRI</option><option>BNI</option><option>CIMB</option><option>Lainnya</option></select></label>
          <label>Bank kompetitor<select value={form.competitorBank} onChange={(e) => set('competitorBank', e.target.value)}><option value="">Tidak ada/tidak tahu</option><option>BCA</option><option>BRI</option><option>BNI</option><option>CIMB</option><option>Danamon</option><option>Lainnya</option></select></label>
          <label>Next action<select value={form.nextAction} onChange={(e) => set('nextAction', e.target.value)}><option>Follow-up pricing/MDR</option><option>Kirim dokumen</option><option>Jadwalkan onboarding</option><option>Koordinasi dengan BM/RM</option><option>Tunggu keputusan owner</option><option>Tidak dilanjutkan</option></select></label>
          <label>Tanggal follow-up<input type="date" value={form.nextFollowupDate} onChange={(e) => set('nextFollowupDate', e.target.value)} /></label>
        </div>
        <div className="check-group"><strong>Potensi Mandiri</strong>{['QRIS Mandiri', 'EDC Mandiri', 'Livin Merchant', 'Rekening Bisnis', 'Settlement Mandiri', 'KUR/Kredit Mikro'].map((x) => <button type="button" key={x} className={form.mandiriOpportunity.includes(x) ? 'checked' : ''} onClick={() => toggleOpp(x)}>{x}</button>)}</div>
        <label className="notes-label">Catatan singkat<textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Ringkas: kendala, kebutuhan, dan arahan follow-up." /></label>
        <div className="modal-actions"><button className="btn ghost" onClick={onClose}>Batal</button><button className="btn blue" onClick={() => onSave(form)}><Save size={16} />Simpan Visit</button></div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
