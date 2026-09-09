import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot, readMemory, findReportFile, readInbox, readScanDates } from "@/lib/career-ops"; //readReport
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { renderAndMarkPdf, writeCvHtml, pdfRunOutcome } from "@/lib/pdf-render.mjs";
import { buildPrompt, isShellSafeCompanyName } from "@/lib/run-prompts.mjs";
import { resolvePdfPaths, type PdfPaths } from "@/lib/pdf-paths.mjs";
import { createCvEnvelopeFilter, type CvEnvelope } from "@/lib/cv-envelope.mjs";

import logger from "@/lib/logger.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // a real oferta evaluation / pdf-mode CV tailoring + render is heavy and multi-step

// The web ORCHESTRATES the real career-ops engine — it does NOT reimplement it.
// kind "evaluate" runs the REAL modes/oferta.md and persists the canonical
// artifacts (A–F report + tracker row) via the SAME scripts the CLI uses
// (reserve-report-num.mjs → reports/ → batch/tracker-additions/ → merge-tracker.mjs),
// so a web evaluation is byte-identical to a CLI one (single source of truth, no
// drift). kind "research" stays read-only. Streams progress as NDJSON events.

//oldie..toRemove
function buildPrompts(kind: string, input: string, memory: string, today: string): string {
  const mem = memory.trim() ? `\n\nDurable notes about the user (from their profile):\n${memory.trim()}\n` : "";
  if (kind === "research") {
    return `You are investigating the user's OWN work / portfolio to surface job-search-relevant strengths, headless. Investigate the target (use WebFetch for URLs; read local files if referenced) and report: what it is, why it is impressive, and how to leverage it in their job search — which roles/claims it supports and how to frame it on a CV. Be specific, honest, and encouraging.${mem}

End with EXACTLY one final line: VERDICT: {0-5 signal strength}/5 — {why it helps their search, ≤12 words}

Target: ${input}`;
  } //colin the permission issues below to access /tmp smh
  if (kind === "pdf" || kind === "cover") {
    const file = findReportFile(input);
    if (!file) console.error(`🤖  apiRun::buildPrompt >> no report for ${input} :(` ); 
    //no need to bork when not found prolly?...
    let repF =  file ? `reports/${path.basename(file)}` : `reports/${input}-{company-slug}-{date}.md  (company-slug = company lowercased, non-alphanumerics → hyphens; date = a date in the same format as ${today} )` 
    // : path.join(careerOpsRoot(), "reports", input)
    const match = file ? file.match(/^\d+-([a-z0-9-]+)-\d{4}-\d{2}-\d{2}\.md$/) : null
    const companySlug = match ? match[1] : '{company-slug}';

    return kind === "pdf" ? `You are generating the user's ATS-optimized, TAILORED CV PDF for application #${input}, headless, on their machine. Run the REAL career-ops "pdf" mode — follow modes/pdf.md EXACTLY (do not improvise a format).
1. For the JD keywords + analysis, Read modes/pdf.md, cv.md, config/profile.yml, and the evaluation report at ${repF}.
2. Tailor the CV per modes/pdf.md: inject the JD's keywords into the summary + first bullets, reorder experience by relevance, build the competency grid, pick the top 3–4 projects. NEVER invent skills — only reword REAL experience using the JD's vocabulary.
3. Fill templates/cv-template.html's {{...}} placeholders with the tailored content; write the HTML to output/cv-{candidate}-${companySlug}.html (candidate = the profile name in kebab-case).
4. Render the PDF: \`node generate-pdf.mjs output/cv-{candidate}-${companySlug}.html output/cv-{candidate}-${companySlug}-${today}.pdf --format={letter for US/Canada companies, else a4}\`.
5. Update the tracker: in data/applications.md, for the row #${input}, ONLY update the PDF column from ❌ to ✅.
Do not submit anything anywhere.

End with EXACTLY one final line: VERDICT: {5 if the PDF was written, else 1}/5 — {the output/ path, ≤12 words}`
:
`You are generating the user's ATS-optimized, TAILORED COVER LETTER PDF for application #${input}, headless, on their machine. Run the REAL career-ops "cover" mode — follow modes/cover.md EXACT STEPS(do not improvise a format).
1. Read the evaluation report at ${repF}.
2. Read modes/cover.md and follow all EXACT STEPS within, LOAD any requiered files, EXECUTE any script from the steps and report any failure.
4. After all the steps in modes/cover.md, confirm that there is a json file in /output/cover-payload-${companySlug}.json

End with EXACTLY one final line: VERDICT: {5 if the PDF was written, else 1}/5 — {the output/ path, ≤12 words}`;
  }
  if (kind === "fix-portal") {
    return `A company's job-portal ATS slug is BROKEN — career-ops can no longer scan it, so it silently disappears from every future scan. Repair it (headless, on the user's machine):
1. Run \`node verify-portals.mjs --add "${input}"\` — it probes Greenhouse/Ashby/Lever for the company's correct ATS slug and prints the suggested ats + slug.
2. Open portals.yml, find the "${input}" entry under tracked_companies, and update its careers_url (and any api/slug field) to the suggested WORKING ATS URL. Change ONLY this one company; preserve all other YAML structure, comments and formatting exactly.
3. Re-run \`node verify-portals.mjs\` and confirm "${input}" now shows ✅ live (not ❌).
If NO slug variant resolves, say so clearly and leave portals.yml unchanged. Never touch any other company.

End with EXACTLY one final line: VERDICT: {5 if now live, else 1}/5 — {what you changed, ≤12 words}`;
  }
  // evaluate (default) — run the REAL oferta mode + persist canonically
  return `You are running the OFFICIAL career-ops job evaluation, HEADLESS, on the user's own machine. Today is ${today}. Run the REAL career-ops evaluation — do NOT improvise your own scoring.

1. Read modes/_shared.md and modes/oferta.md and follow the evaluation methodology EXACTLY (blocks A–F, G posting-legitimacy, and the Machine Summary). Ground the fit in THIS person: read cv.md, config/profile.yml and modes/_profile.md. Use WebFetch to read the posting (you are headless — Playwright is unavailable, so use WebFetch and mark the report header "Verification: unconfirmed (batch mode)").

2. Persist the result CANONICALLY so the web and the CLI share ONE source of truth:
   a. Reserve a report number: run \`node reserve-report-num.mjs\` — its stdout is a 3-digit number (e.g. 035).
   b. Write the full report to reports/{num}-{company-slug}-${today}.md  (company-slug = company lowercased, non-alphanumerics → hyphens).
   c. Append ONE row of 9 TAB-separated columns to batch/tracker-additions/{num}-{company-slug}.tsv, in THIS exact order (real \\t tabs, status BEFORE score):
      {num}\t${today}\t{Company}\t{Role}\t{CanonicalStatus e.g. Evaluated}\t{score}/5\t❌\t[{num}](reports/{num}-{company-slug}-${today}.md)\t{one-line note}
   d. Merge into the tracker: run \`node merge-tracker.mjs\` (it dedupes by company+role+report-num, validates the status, and writes data/applications.md — NEVER edit applications.md by hand).
   e. Release the sentinel by running \`node reserve-report-num.mjs --release {num}\` once the report is written.

3. NEVER submit an application, fill no forms, contact no one. This is evaluation + persistence ONLY.${mem}

After everything above is written and merged, output EXACTLY one final line, nothing after it:
VERDICT: {score}/5 — {reason in 20 words or fewer}

Posting URL: ${input}`;
}

export async function POST(req: Request) {
  let body: { kind?: string; input?: string; cliId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  const { kind = "evaluate", input, cliId } = body;
  if (!input || !cliId) {
    return new Response(JSON.stringify({ error: "input and cliId required" }), { status: 400 });
  }
  const resolved = resolveCli(cliId);
  if (!resolved) {
    return new Response(JSON.stringify({ error: `CLI '${cliId}' not found` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;

  // These run the REAL core (modes/scripts), not just data — fail clearly if the
  // root is incomplete instead of faking it.
  const needsScript: Record<string, string> = { evaluate: "modes/oferta.md", "fix-portal": "verify-portals.mjs", pdf: "generate-pdf.mjs", cover: "generate-cover-letter.mjs" };
  const required = needsScript[kind];
  if (required && !fs.existsSync(path.join(careerOpsRoot(), required))) {
    return new Response(
      JSON.stringify({
        error: `This needs a complete career-ops checkout (${required}). CAREER_OPS_ROOT has data only — point it at a full checkout.`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // An A–F score is meaningless without a CV to score against — the CLI would
  // hallucinate a fit narrative and still emit a VERDICT. Require cv.md first.
  if ((kind === "evaluate" || kind === "pdf") && !fs.existsSync(path.join(careerOpsRoot(), "cv.md"))) {
    return new Response(
      JSON.stringify({ error: "Add your CV first so I can score this against you — drop it on the home page." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  // Precompute deterministic scratch + final paths so the agent never chooses
  // its own filenames — the backend owns naming, writing (#2185) and rendering
  // (#2172). Nothing is cleared first: writeCvHtml rewrites the HTML
  // from this run's freshly parsed envelope before any render, and the agent is
  // no longer told these paths, so a stale file cannot survive into a render.
  let pdfPaths: PdfPaths | undefined;
  if (kind === "pdf") { //or cover?
    const pathsResult = resolvePdfPaths(input, today, careerOpsRoot(), findReportFile);
    if (!pathsResult.ok) {
      logger.error(`No resolvePdfPaths for ${kind} !!`, {input: input, in: careerOpsRoot()});
      //return?!? or continue?
      return new Response(JSON.stringify({ error: pathsResult.error }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    pdfPaths = pathsResult.paths;
  }

    // Resolve the posting date HERE rather than asking the agent for it. The
  // scanner already wrote it from the provider's own `offer.postedAt`, so this
  // copies a recorded value instead of inviting a guess — and modes/oferta.md is
  // explicit that a guessed date is worse than an absent one (the POSTED column
  // renders absent as `—`, a wrong date as a fresh req). Unknown URL → undefined
  // → the prompt writes no segment at all.
  const postedAt =
    kind === "evaluate"
      ? readInbox().find((j) => j.url === input)?.postedAt ?? readScanDates().get(input)
      : undefined;
  //umm above postedAt could be useful in resolvePdfPaths() above for old posts!!-toReview

  const prompt = buildPrompt({kind, input, memory: readMemory(), today, postedAt, lang:null, paths: pdfPaths } ); //bof lang will default

  const isClaude = cliId === "claude";
  const isOllama = cliId === "ollama";
  // Tool scope by kind (comma-separated lists; disallowedTools is the hard
  // guardrail). 'evaluate' runs the REAL mode + persists canonical artifacts →
  // it needs Write + Bash (reserve-report-num / merge-tracker / write the
  // report). 'research' stays read-only. Task (sub-agents) is always blocked
  // (runaway cost). NEVER auto-submits — that is a prompt-level guarantee.
  const tools =
    kind === "evaluate" || kind === "fix-portal" || kind === "pdf" || kind === "cover"
      ? { allowed: "Read,WebFetch,WebSearch,Write,Edit,Bash,Glob,Grep", disallowed: "Task,NotebookEdit" }
      : { allowed: "Read,WebFetch,WebSearch,Glob,Grep", disallowed: "Bash,Write,Edit,NotebookEdit,Task" };
  const args = isClaude
    ? ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
       "--permission-mode", "acceptEdits",
       "--allowedTools", tools.allowed,
       "--disallowedTools", tools.disallowed]
    : isOllama ?
   [
      'run',
      'agent.py',
      '--question',
      `${input}`,
      "--prompt",
      prompt,
      "--allowedTools",
      tools.allowed, 
      "--disallowedTools", 
      tools.disallowed,
      '--fromP',
      'api-run',
    ]
    : spec.args(prompt);

  // For write-needing kinds, snapshot reports/ so we can verify the worker
  // actually persisted (non-Claude CLIs lack Write auth and silently no-op).
  const reportsDir = path.join(careerOpsRoot(), "reports");
  const countReports = () => {
    try {
      return fs.readdirSync(reportsDir).filter((f) => f.endsWith(".md")).length;
    } catch {
      return 0;
    }
  };
  const persists = kind === "evaluate";
  const reportsBefore = persists ? countReports() : 0;
  // Tracker-mutating runs hold a write token so a row delete can't race their merge
  // (tracker.mjs delete doesn't yet share a lock with merge-tracker — see run-registry).
  const writeToken = kind === "evaluate" || kind === "pdf" || kind === "cover" ? acquireTrackerWrite() : null;

  const filePath = path.join(careerOpsRoot(), `api-run-${kind}.log`);
  //console.log(`🤖  Run:::POST on kind:${kind} >> ${isOllama} >> ${reportsBefore}....\n`,prompt);
  logger.info("🤖 api-Run::POST", {on: kind, as: cliId, prompt: prompt})

  const child = isOllama ? 
  //spawn(`curl`, args) //huh when adding cwd does change working dir and script need to be in parent dir or borks >> /Users/florentcyamweshi/Downloads/career-ops/ollama-test.mjs
  //spawn('node',args, { cwd: careerOpsRoot(), stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
  //spawn('uv',args, { cwd: careerOpsRoot(), stdio: ['pipe', 'pipe', 'pipe' , 'pipe'] })
  spawnHeadlessCli('uv', args, { cwd: careerOpsRoot(), stdio: ['pipe', 'pipe', 'pipe', 'pipe']  })
  : 
  //spawn(binPath, args, { cwd: careerOpsRoot(), env: process.env });
  spawnHeadlessCli(binPath, args, { cwd: careerOpsRoot(), env: process.env });

  const enc = new TextEncoder();

  // `closed` + kill timer in the OUTER scope so cancel() (client disconnect) can
  // flip `closed` before the child's late handlers run, and send() is try/catch'd —
  // otherwise a late enqueue onto a closed controller throws uncaught (see #1155).
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;

  // pdf-kind's render+mark work (renderPdf, below) keeps running detached even
  // after the agent child closes — and even after a client disconnect fires
  // cancel(). Track its promise so cancel() can defer releasing writeToken
  // until that work actually settles, instead of releasing the tracker-delete
  // guard while mark-pdf-ready.mjs is still actively writing applications.md.
  let pdfRenderPromise: Promise<void> | null = null;
  let writeTokenReleased = false;
  const releaseWriteTokenOnce = () => {
    if (writeToken !== null && !writeTokenReleased) {
      writeTokenReleased = true;
      releaseTrackerWrite(writeToken);
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emittedText = false; // any assistant text delta → the CLI actually ran
      let sawError = false;
      let lastTokens = 0; // per-run token cost from the Claude result event (#6) — local only
      let lastCostUsd: number | null = null;
      // pdf-mode tailors a full CV + renders it — give it more headroom.
      const killMs = kind === "pdf" ? 720_000 : 720_000; //meh //285_000;
      
      // Set by the killer so the close handler can tell "we timed it out" apart
      // from "the CLI exited on its own" — different failures, different message.
      let killedByTimeout = false;     
      killer = setTimeout(() => {
        killedByTimeout = true;
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, killMs);

      // Declared before send() so send() can clear it the moment it sees the
      // client disconnect; assigned just below, once close() exists.
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const send = (obj: unknown) => {
        if (closed) return;
        try { 
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n")); 
        } catch { 
          // The client is gone. Stop the heartbeat here rather than waiting for
          // close(): the child can still run for minutes (maxDuration 800s), and
          // a user retrying a failed run would otherwise accumulate one live
          // timer per abandoned request.
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
        }
      };

      // Time-based keepalive. The stream is silent whenever the agent is thinking
      // or inside a long tool call, and in pdf mode it is silent for the whole
      // 15-25 KB <<cv-html>> envelope (cvFilter swallows every byte). Measured
      // idle gaps on a real pdf run reached 149s — long enough for the browser or
      // a proxy to drop the connection, after which the client reports
      // "Connection error" even though the agent finished and the PDF rendered.
      // It must be a timer, not a hook on incoming text: piggy-backing on agent
      // output cannot fire during exactly the silences it needs to cover.
      // Unknown event types are ignored by the client's switch, so old tabs are safe.
      heartbeat = setInterval(() => send({ type: "keepalive" }), 720_000);//10_000
      const close = () => {
        logger.warn("🤖 stream::apiRun", {on: 'close', isClosed: closed, kind: kind, cli: cliId})
        if (!closed) {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          if (killer) clearTimeout(killer);
          releaseWriteTokenOnce();//if (writeToken !== null) releaseTrackerWrite(writeToken);
          try { controller.close(); } catch { /* */ }
        }
      };

      // pdf's CV arrives inline in a <<cv-html>> envelope instead of being written
      // by the agent (#2185). The filter keeps every byte for the backend while
      // holding the 15-25 KB body out of the run log, which is the agent's
      // narration — see cv-envelope.mjs.
      const cvFilter = kind === "pdf" ? createCvEnvelopeFilter() : null;
      
      // While the agent emits the 15-25 KB <<cv-html>> envelope, cvFilter swallows
      // every byte, so the response stream goes completely silent for as long as
      // the model takes to write the CV — a minute or more. Nothing downstream can
      // tell that from a hung request, and the browser/proxy drops the connection;
      // the client then reports "Connection error" even though the agent is fine
      // and the PDF renders correctly server-side. Emit a throttled keepalive so
      // the stream never idles during the filtered phase. Unknown event types are
      // ignored by the client's switch, so this is safe for older tabs too.
      const sendAgentText = (text: string) => {
        const visible = cvFilter ? cvFilter.push(text) : text;
        if (visible) logger.info("🤖 sendAgentText", {content: visible}) //toSee** 
          //...send({ type: "text", text: visible });
      };
      /** Surface non-fatal issues in the run log rather than only a server log. */
      const sendWarnings = (warnings: string[]) => {
        for (const w of warnings) send({ type: "text", text: `⚠️ ${w}\n` });
      };
      /** Persist the emitted CV; streams the reason and returns false on failure. */
      const saveCv = (paths: PdfPaths, envelope: CvEnvelope) => {
        const written = writeCvHtml({ pdfPaths: paths, html: envelope.html });
        if (!written.ok) send({ type: "error", msg: written.error.slice(0, 200) });
        return written.ok;
      };
      
      child.stdout.on("data", (d: Buffer) => {
        //console.log(`🤖  stream::apiRun::onData....${d.byteLength} --closed? ${closed} \n`,isOllama);
        logger.info("🤖 stream::apiRun", {on: 'onData', size: d.byteLength, closed: closed, cli: cliId})
        if (closed) return;
        if (isOllama){
          let oContent;
          try { 
            //buf += d.toString(); //umm add to buf? >>naah prolly not? toReview**
            oContent = JSON.parse(d.toString()); //buf
            //oContent = oContent.choices?.[0]?.message?.content?.trim() ?? "";
            oContent = oContent.output ?? "";
            emittedText = true;
            sendAgentText(oContent) //toSee
            send({ type: "text", text: oContent });
          } catch {
            //handle error?!? retry?
            console.error(`🤖  stream::onData::Run>>Ollama...ERROR json!! \n ${d.toString()} \n`);
          }
          return;
        }
        if (!isClaude) {
          emittedText = true;
          send({ type: "text", text: d.toString() });
          return;
        }

        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === "stream_event") {
              const e = ev.event;
              if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
                send({ type: "tool", name: e.content_block.name });
              } else if (e?.type === "content_block_delta" && e.delta?.text) {
                emittedText = true;
                send({ type: "text", text: e.delta.text });
              }
            } else if (ev.type === "system" && ev.subtype === "init") {
              send({ type: "status", label: "Agent ready" });
            } else if (ev.type === "result") {
              // Capture the per-run cost; the authoritative "done" is sent on close
              // (so the honesty gate decides done-vs-error first). Tokens = the same
              // formula /api/usage uses: input + output + cache-creation.
              const u = ev.usage || {};
              lastTokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
              if (typeof ev.total_cost_usd === "number") lastCostUsd = ev.total_cost_usd;
            }
          } catch {
            /* partial line */
          }
        }
      });

      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        //console.log(`🤖  stream::apiRun::onData Errr....${d.byteLength} \n`);
        logger.info("🤖  stream::apiRun::onData", {on:'stderr', size: d.byteLength})
        // Widened: auth/login/quota failures are the most common real error and
        // the old narrow regex missed them (silent false "success").
        //fs.writeFileSync(filePath,`\n ${s} \n`, {flag: 'a',encoding: 'utf8'});
        logger.toFile(filePath, `\n ${s} \n`)
        
        if (/error|denied|fatal|not found|unauthorized|forbidden|auth|login|credential|api[ -]?key|quota|rate limit|not authenticated/i.test(s)) {
          //console.log(`🤖  stream::apiRun::onData Errr...SHIET ERROR? \n\n`,s) //test not premature stream closing..the string trimming en plus smh
          //sawError = true;
          //send({ type: "error", msg: s.trim().slice(0, 200) });
          logger.error("🤖  stream::apiRun::onData", {on:'stderr', size: d.byteLength, message: 'Errr...SHIET ERROR?'})
        }
        if (/input_tokens|output_tokens/im.test(s)) {
          //try to save the tokens?--should skip if seen multiple times...use lastCostUsd as flag? toReview**
          let usage;
          try { 
            usage = JSON.parse(s)
            lastTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0);
            lastCostUsd = (usage.requests || 0) + (usage.tool_calls || 0) //WRONG..toFix**
          }catch(e) { 
            console.error(`🤖  stream::apiRun::onData Errr...ERROR json!! \n ${s} \n`);
          };
        }
      });
      
      // Render + mark-tracker-ready live in pdf-render.mjs (plain, dependency-
      // injected, unit-tested) so the render-then-mark orchestration isn't
      // buried untested inside this transport-layer closure. Runs generate-
      // pdf.mjs and mark-pdf-ready.mjs as plain Node child processes — no agent
      // CLI or its sandbox involved — so a browser launch never depends on an
      // interactive approval nobody is present to grant in a headless/web-
      // triggered run (#2172). The tracker is marked ✅ only after a CONFIRMED
      // successful render, not optimistically — same honesty-gate discipline as
      // the evaluate path below.
      const renderPdf = async (paths: PdfPaths, format: "letter" | "a4") => {
        send({ type: "status", label: "Rendering PDF…" });
        // renderAndMarkPdf is designed to resolve, never throw — but this is
        // the one place nothing else awaits or catches this promise (cancel()
        // only attaches a .finally for the write-token release), so an
        // unexpected exception here must still close the stream instead of
        // leaving it — and the write-token — open until process shutdown.
        try {
          const result = await renderAndMarkPdf({
            spawnFn: spawn,
            execPath: process.execPath,
            root: careerOpsRoot(),
            pdfPaths: paths,
            format,
            reportNum: input,
          });
          if (result.kind === "render-failed") {
            send({ type: "error", msg: result.error.slice(0, 200) });
            return;
          }
          // Non-fatal issues (a defaulted page format, a tracker row not marked) still
          // surface here rather than only in a server log nobody sees.
          sendWarnings(result.warnings);
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
        } catch (e) {
          send({ type: "error", msg: `PDF rendering crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
        } finally {
          close();
        }
      };

      child.on("error", (e) => { send({ type: "error", msg: e.message }); close(); });

      child.on("close", (code,signal) => {
        const wroteReport = countReports() > reportsBefore;
        const cleanExit = code === 0; // non-zero OR null (killed/signal) = NOT clean
        // Honesty gate (#9): a green "done" with a parsed score requires a CLEAN exit,
        // real output, AND (for evaluations) a report actually written. Anything else
        // is surfaced — an errored run must never be banked as a confident score.
        console.log(`🤖  stream::apiRun::onClose >> cleanExit? ${cleanExit} 
          <> emittedText: ${emittedText} 
          <> anyError?: ${sawError}
          <> signal...${signal} --${wroteReport} --${closed}
          <> tokens: ${lastTokens} <--> ${lastCostUsd} \n\n`); 

        // A client disconnect can fire cancel() (which kills `child`) before
        // this event finally arrives — killing a process doesn't make its
        // 'close' event disappear, just delays it. Without this guard a pdf
        // run could still start a brand-new render (and re-touch the tracker)
        // after the stream — and its writeToken guard — is already gone.
        if (closed) return; //toReview**

        // A timeout is the ROOT cause behind every "no report / not clean"
        // symptom the gates below test, so classify it FIRST, for any kind.
        // Otherwise a run we cut off at the time limit reads as "the CLI couldn't
        // save a report" and sends the user to re-check a CLI that was working
        // fine (#3124). code is null here (killed by signal), which the gates
        // would read as a generic non-clean exit.
        if (killedByTimeout) {
          logger.error("🤖  stream::apiRun", {on:"close", mess: "killedByTimeout", rest: buf.trim()});
          //send({
          //  type: "error",
          //  msg: timeoutMessage(killMs, kind),
          //});
          //return close();
        }
        
        if(kind === "pdf"){
          const tail = cvFilter?.flush();
          if (tail) logger.info("🤖 tailzzz", {content: tail, pdfs:pdfPaths})//send({ type: "text", text: tail });
          const envelope = cvFilter?.result();
          if (envelope) logger.info("🤖 cvEnvelope", {content: envelope,  pdfs:pdfPaths})
          // The worker ran but never wrote the report/tracker row (e.g. a CLI
          // without file-write authorization) — surface it instead of a fake score.
          //if (saveCv(pdfPaths ?? {html:'',reportPath:'',finalPdf:""}, envelope)) {
            // Tracked so cancel() can defer releasing writeToken until this
            // settles; close() happens once rendering finishes, not here.
          //  pdfRenderPromise = renderPdf(pdfPaths, envelope.format);
          //  return;
          //}
        }
  
        if (!emittedText && !sawError && !cleanExit) {
          send({ type: "error", msg: "The CLI exited with an error — is it installed and authenticated?" });
        } else if (!emittedText && !sawError) {
          send({ type: "error", msg: "The CLI produced no output — is it installed and authenticated? (career-ops is best on Claude Code.)" });
        } else if (persists && !wroteReport) {
          send({ type: "error", msg: "This evaluation didn't save a report, so it's not in your tracker. Full evaluation is verified on Claude Code." });
        } else if (!cleanExit || sawError) {
          // Produced output (maybe even a report) but did NOT finish cleanly — flag it
          // instead of recording a confident score off a half-finished run.
          send({ type: "error", msg: "This run hit an error before finishing, so it isn't recorded as a confident result — re-run it to verify." });
        } else {
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
        }

        close();
      });
    },
    cancel() {
      closed = true;
      if (killer) clearTimeout(killer);
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      releaseWriteTokenOnce();//if (writeToken !== null) releaseTrackerWrite(writeToken);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
