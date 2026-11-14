import { BaseAsyncPlugin } from "./manager";
import type { SearchResult } from "../types/models";
import { fetchWithRetry } from "../utils/fetch";
const API_ENDPOINT = "https://www.pansousuo.com/api/search";
const REQUEST_TIMEOUT_MS = 3500;
const MAX_PAGES = 2;

interface PanSuoSuoItem {
  id?: string | number;
  title?: string;
  work_title?: string;
  pan?: string;
  category?: string;
  tags?: string[];
  share_url?: string;
  access_code?: string | null;
  description?: string | null;
  published_at?: string | null;
  created_at?: string | null;
  heat?: number | null;
  size_bytes?: number | null;
  size_text?: string | null;
}

interface PanSuoSuoResponse {
  items?: PanSuoSuoItem[];
  total?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  blocked?: boolean;
  error?: string;
}

const SHARE_HOSTS: Record<string, string[]> = {
  quark: ["pan.quark.cn"],
  aliyun: ["alipan.com", "aliyundrive.com"],
  baidu: ["pan.baidu.com"],
  "115": ["115.com"],
  xunlei: ["pan.xunlei.com"],
  tianyi: ["cloud.189.cn"],
  uc: ["drive.uc.cn"],
  pikpak: ["mypikpak.com"],
  "123": ["123pan.com"],
  mobile: ["yun.139.com", "caiyun.139.com"],
  lanzou: ["lanzou.com", "lanzoux.com", "lanzoui.com", "lanzouj.com"],
};

function normalizePanType(pan?: string): string {
  const value = (pan || "").toLowerCase().trim();
  const aliases: Record<string, string> = {
    quark: "quark",
    aliyun: "aliyun",
    alipan: "aliyun",
    baidu: "baidu",
    "115": "115",
    xunlei: "xunlei",
    tianyi: "tianyi",
    uc: "uc",
    pikpak: "pikpak",
    "123": "123",
    mobile: "mobile",
    lanzou: "lanzou",
  };
  return aliases[value] || "others";
}

function isAllowedShareUrl(rawUrl: string, panType: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    const hosts = SHARE_HOSTS[panType];
    if (!hosts) return false;
    return hosts.some((host) =>
      url.hostname === host || url.hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

function validIsoDate(value?: string | null): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  if (timestamp > Date.now() + 24 * 60 * 60 * 1000) return "";
  return new Date(timestamp).toISOString();
}

function parsePageLimit(ext?: Record<string, any>): number {
  const requested = Number(ext?.pansousuoPages);
  if (!Number.isFinite(requested)) return MAX_PAGES;
  return Math.max(1, Math.min(MAX_PAGES, Math.floor(requested)));
}

function toSearchResult(item: PanSuoSuoItem): SearchResult | undefined {
  const title = (item.title || item.work_title || "").trim();
  const panType = normalizePanType(item.pan);
  const shareUrl = (item.share_url || "").trim();
  if (!title || !shareUrl || !isAllowedShareUrl(shareUrl, panType)) return undefined;

  const publishedAt = validIsoDate(item.published_at);
  const createdAt = validIsoDate(item.created_at);
  const description = (item.description || "").trim();
  const contentParts = [description];
  if (item.category) contentParts.push(`分类：${item.category}`);
  if (item.size_text) contentParts.push(`大小：${item.size_text}`);
  if (typeof item.heat === "number") contentParts.push(`热度：${item.heat}`);

  return {
    message_id: "",
    unique_id: `pansousuo-${item.id ?? encodeURIComponent(shareUrl)}`,
    channel: "pansousuo",
    // created_at is retained as an indexing/record-creation time candidate.
    // published_at is stored separately on the link and is not substituted here.
    datetime: createdAt,
    title,
    content: contentParts.filter(Boolean).join("\n"),
    tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string") : [],
    links: [
      {
        type: panType,
        url: shareUrl,
        password: (item.access_code || "").trim(),
        work_title: item.work_title || title,
        datetime: publishedAt,
      },
    ],
  };
}

export class PansousuoPlugin extends BaseAsyncPlugin {
  constructor() {
    super("pansousuo", 3);
  }

  override async search(keyword: string, ext?: Record<string, any>): Promise<SearchResult[]> {
    const query = keyword.trim();
    if (!query) return [];

    const signal = ext?.signal as AbortSignal | undefined;
    const pageLimit = parsePageLimit(ext);
    const collected: SearchResult[] = [];
    const seenUrls = new Set<string>();
    let totalPages = 1;
    let fetchedPages = 0;

    for (let page = 1; page <= Math.min(pageLimit, totalPages); page += 1) {
      if (signal?.aborted) {
        throw new DOMException("Request was cancelled", "AbortError");
      }

      const url = new URL(API_ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("sort", "latest");
      url.searchParams.set("p", String(page));

      const response = await fetchWithRetry<PanSuoSuoResponse>(
        url.toString(),
        {
          method: "GET",
          signal,
          headers: { accept: "application/json" },
        },
        {
          maxRetries: 0,
          timeout: REQUEST_TIMEOUT_MS,
          logWarnings: false,
          signal,
        }
      );

      if (response?.error) throw new Error(`PanSuoSuo API error: ${response.error}`);
      if (response?.blocked) throw new Error("PanSuoSuo API blocked this request");

      fetchedPages += 1;
      totalPages = Math.max(1, Number(response?.totalPages) || 1);
      const items = Array.isArray(response?.items) ? response.items : [];
      for (const item of items) {
        const result = toSearchResult(item);
        if (!result) continue;
        const normalizedUrl = result.links[0].url.replace(/\/$/, "").toLowerCase();
        if (seenUrls.has(normalizedUrl)) continue;
        seenUrls.add(normalizedUrl);
        collected.push(result);
      }
    }

    // Upstream page order was observed to differ from created_at order.
    // Sort the fetched window locally; records without a valid created_at go last.
    collected.sort((a, b) => {
      const aTime = Date.parse(a.datetime);
      const bTime = Date.parse(b.datetime);
      const aValid = Number.isFinite(aTime);
      const bValid = Number.isFinite(bTime);
      if (aValid && bValid) return bTime - aTime;
      if (aValid) return -1;
      if (bValid) return 1;
      return a.title.localeCompare(b.title, "zh-CN");
    });

    return collected;
  }
}
