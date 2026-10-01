
import { NextResponse } from "next/server";
import { addOffersToPipeline } from "@/lib/core/pipeline";
//import type { DiscoveredOffer } from "@/lib/explore";
import { runDiscovery } from "@/lib/core/scan";
import { rootScript } from "@/lib/career-ops";
import { parseExplorePatch, DEFAULT_FILTERS, type DiscoveredOffer, type ScanEvent } from "@/lib/explore";
import path from "node:path";
import fs from "node:fs";
import { careerOpsRoot } from "@/lib/career-ops";

import logger from "@/lib/logger.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  url: string;
  title: string;
  company?:string;
  download?: boolean;
};

const file = path.join(careerOpsRoot(), "data", "pipeline.md");

function addToPipeline(url:string, company:string, title:string, content:string[]) {
  //- [ ] https://job-boards.greenhouse.io/intercom/jobs/8122199 | Intercom | Senior Solutions Engineer- LATAM | NYC, Remote; San Francisco, California | posted: 2026-08-20
  
  const curr = content.length;
  let postedAt = new Date().toISOString().slice(0, 10);
  const base = `- [ ] ${url} | ${company} | ${title} | NYC, Remote; San Francisco, California | posted: ${postedAt}`;
  content.push(base);
  //fs.writeFileSync(file, content, 'utf-8');
  
  fs.writeFileSync(file, content.join('\n'), 'utf-8');

  return {old: curr, new:content.length}
}


// Free + reversible: append chosen discovered offers to data/pipeline.md AND
// record them in data/scan-history.tsv, via the core's CANONICAL exported writers
// (no parallel writer). No tokens spent.
export async function POST(req: Request) {
  /*
  let offers: DiscoveredOffer[] = [];
  try {
    const body = (await req.json()) as { offers?: DiscoveredOffer[] };
    offers = Array.isArray(body.offers) ? body.offers : [];
  } catch {
    return Response.json({ added: 0, error: "bad request" }, { status: 400 });
  }

  if (offers.length === 0) return Response.json({ added: 0 });
  */
  
  let b: Body;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  if (!b.url) return NextResponse.json({ error: "url required" }, { status: 400 });

  let md:string[]; //prolly []
  try {
    md = fs.readFileSync(file, "utf8").split('\n');
  } catch {
    return NextResponse.json({ error: "pipeline file not parsed properly" }, { status: 404 });
  }
  
  const result = addToPipeline(b.url, b.company ?? "", b.title, md);
  logger.info(`addToPipeline ${b.url} >>`, {...result});
  //const result = await addOffersToPipeline(offers);
  return Response.json(result);
}

