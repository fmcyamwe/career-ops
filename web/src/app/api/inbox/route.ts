import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
//import { canonicalizeStatus } from "@/lib/core/states";
//import { atomicWrite } from "@/lib/core/safe-write";

// Writeback: UPDATE the status cell of an EXISTING tracker row only. Never adds
// rows — per the core data contract, new rows go through the TSV + merge flow.
// HARDENED: validate against the 8 canonical states (states.yml SSOT); reject any
// value with table-breaking chars (| \r \n **) that would scramble the row; detect
// the Status column from the header (8- and 9-col layouts); atomic write.

const file = path.join(careerOpsRoot(), "data", "pipeline.md");

function try_delete(url:string, content:string) {
  const lines = content.split("\n"); ///\r?\n/
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let patt = new RegExp(`^(- \\[ \\] ${escaped}.*)$`, 'm')
  let i = 0;
  while (i < lines.length) { 
    const found = lines[i].match(patt); //(/^##\s+(.*\S)\s*$/);
    const isFound = patt.test(lines[i]);
    if(found){
      ///console.log("huh, FOUND: "+i, url, found[0], isFound)
      break;
    } 
    i++;
  }
  //then splice
  lines.splice(i, 1); //// from index i remove 1 element
  //then write back
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
}

function markPipelineDone(url:string, content:string) {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  content = content.replace(
    new RegExp(`^(- \\[ \\] ${escaped}.*)$`, 'm'),
    (ln) => ln.replace('- [ ]', '- [x]')
  );

  fs.writeFileSync(file, content, 'utf-8');
}

export async function POST(req: Request) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { url } = body;
  if (!url || typeof url !== "string" || !url.trim()) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }
  if (/[|\r\n*]/.test(url)) {
    return NextResponse.json({ error: "invalid url (table-breaking characters)" }, { status: 400 });
  }

  //const file = path.join(careerOpsRoot(), "data", "pipeline.md");
  let md: string;
  try {
    md = fs.readFileSync(file, "utf8");
  } catch {
    return NextResponse.json({ error: "pipeline file not found" }, { status: 404 });
  }

  //bon should delete
  try_delete(url, md);
  //markPipelineDone(url,md) //meh doesnt delete
  return NextResponse.json({ ok: true, status: "Deleted!!!" });

}
