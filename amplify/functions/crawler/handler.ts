import { crawl, HttpFetcher } from "./crawler";

export interface CrawlEvent {
  startUrl: string;
  maxPages?: number;
}

export interface CrawlResponse {
  pages: string[];
  count: number;
  capped: boolean;
  sitemapSeeds: string[];
}

export const handler = async (event: CrawlEvent): Promise<CrawlResponse> => {
  const res = await crawl(event.startUrl, {
    maxPages: event.maxPages,
    fetcher: new HttpFetcher(),
  });
  return {
    pages: res.pages,
    count: res.pages.length,
    capped: res.capped,
    sitemapSeeds: res.sitemapSeeds,
  };
};
