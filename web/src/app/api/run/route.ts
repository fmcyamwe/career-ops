import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot, readMemory, findReportFile, readInbox, readScanDates } from "@/lib/career-ops"; //readReport
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { renderAndMarkPdf, writeCvHtml, pdfRunOutcome } from "@/lib/pdf-render.mjs";
import { buildPrompt, isShellSafeCompanyName } from "@/lib/run-prompts.mjs";
import { buildSysPrompt, apiRunSesshInstructions } from "@/lib/ollama-prompts.mjs"; //Olama system prompts
import { resolvePdfPaths, type PdfPaths } from "@/lib/pdf-paths.mjs";
import { createCvEnvelopeFilter, type CvEnvelope } from "@/lib/cv-envelope.mjs";
import { accumulateTokens, hasNewCompletedReport, isFatalGenericStderr, killMsForKind, timeoutMessage } from "@/lib/run-cli-support.mjs";
//import { fencingReport } from "@/lib/cli-fencing.mjs"; //meh?

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
    logger.error(`WOAH WOAH ERROR No CLI found for ${cliId} !!`, {input: input, in: careerOpsRoot()}); //toMonitor changes
    return new Response(JSON.stringify({ error: `CLI '${cliId}' not found` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;
  //logger.info(`resolvedCli ${cliId} >>`, {...spec, hasPar: typeof spec.parseEvent}); //just to see

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
  if (kind === "pdf") { //todo** add "cover" prolly
    const pathsResult = resolvePdfPaths(input, today, careerOpsRoot(), findReportFile);
    if (!pathsResult.ok) {
      logger.error(`ERROR No resolvePdfPaths for ${kind} !!`, {input: input, in: careerOpsRoot()});
      return new Response(JSON.stringify({ error: pathsResult.error }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    pdfPaths = pathsResult.paths;
    logger.info(`resolvePdfPaths ${kind} >>`, {...pdfPaths});
    //"html":"/Users/florentcyamweshi/Downloads/career-ops/.career-ops-web/pdf-tmp/cv-web-14.html",
    // "reportPath":"reports/014-1password-2026-09-18.md",
    // "finalPdf":"/Users/florentcyamweshi/Downloads/career-ops/output/cv-florent-cyamweshi-1password-2026-09-18.pdf"
  }

    // Resolve the posting date HERE rather than asking the agent for it. The
  // scanner already wrote it from the provider's own `offer.postedAt`, so this
  // copies a recorded value instead of inviting a guess — and modes/oferta.md is
  // explicit that a guessed date is worse than an absent one (the POSTED column
  // renders absent as `—`, a wrong date as a fresh req). Unknown URL → undefined
  // → the prompt writes no segment at all.
  const postedAt = kind === "evaluate" ? readInbox().find((j) => j.url === input)?.postedAt ?? readScanDates().get(input) : undefined;

  const isClaude = cliId === "claude";
  const isOllama = cliId === "ollama";

  const opts = {kind, input, memory: readMemory(), today, postedAt, lang:null, paths: pdfPaths };//bof lang will default
  let sysPrompt = ''
  let instructions = ''
  if(isOllama){
    sysPrompt = buildSysPrompt(kind, "apiRun");  //no need to pass in whole opts..
    instructions = apiRunSesshInstructions(opts);
  }

  const prompt = isOllama ? sysPrompt : buildPrompt(opts);  //{kind, input, memory: readMemory(), today, postedAt, lang:null, paths: pdfPaths }

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
      //'-u', //add flag for unbuffered?--bof for python
      // '-v' instead for uv? --meh no need with flush flag in print 
      'agent.py',
      '--question',
      `${input}`,
      "--prompt",
      instructions,
      "--sys_prompt",
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
      return fs.readdirSync(reportsDir).filter((f) => f.endsWith(".md"));//.length; 
    } catch {
      return [];
    }
  };

  const persists = kind === "evaluate";
  const reportsBefore = persists ? countReports() : [];

  // Tracker-mutating runs hold a write token so a row delete can't race their merge
  // (tracker.mjs delete doesn't yet share a lock with merge-tracker — see run-registry).
  const writeToken = kind === "evaluate" || kind === "pdf" || kind === "cover" ? acquireTrackerWrite() : null;

  const filePath = path.join(careerOpsRoot(), `api-run-${kind}.log`);
  //console.log(`🤖  Run:::POST on kind:${kind} >> ${isOllama} >> ${reportsBefore}....\n`,prompt);
  let lo = {on: kind, as: cliId, input: input, reports: reportsBefore.length, toPersist: persists, postedAt: postedAt}
  logger.info("🤖 api-Run::POST", {...lo}) 

  logger.toFile(filePath, `\n Start: ${instructions} \n with context: \n ${prompt.length}`)
  

  const child = isOllama ? 
  //spawn(`curl`, args) //huh when adding cwd does change working dir and script need to be in parent dir or borks >> /Users/florentcyamweshi/Downloads/career-ops/ollama-test.mjs
  //spawn('node',args, { cwd: careerOpsRoot(), stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
  spawn('uv',args, { cwd: careerOpsRoot(), stdio: ['pipe', 'pipe', 'pipe' , 'pipe'] })
  //spawnHeadlessCli('uv', args, { cwd: careerOpsRoot(), stdio: ['pipe', 'pipe', 'pipe', 'pipe']  }) //should use this? as >> stdin must reach EOF or the CLI waits on piped input that never comes...
  : 
  //spawn(binPath, args, { cwd: careerOpsRoot(), env: process.env });
  spawnHeadlessCli(binPath, args, { cwd: careerOpsRoot(), env: process.env });

  // Decode once on the stream, not per chunk. Buffer#toString() decodes each chunk
  // independently, so a chunk boundary falling inside a multi-byte UTF-8 sequence
  // yields a replacement character and mis-decodes the bytes after it. Those bytes
  // are the CV now (#2185) — the agent's HTML flows through cvFilter to
  // writeCvHtml and on to the renderer — and no structural check would catch it,
  // because the envelope markers and </html> are ASCII and still match. Setting
  // the encoding makes Node hold partial sequences across chunks.
  child.stdout.setEncoding("utf8"); //has any effect? >>dont seem like? even when should expect string instead of Buffer...
  child.stderr.setEncoding("utf8");//idem above

  const encoder = new TextEncoder();

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
      const killMs = kind === "pdf" ? 840_000 : 720_000; //14 && 12 minutes //meh //285_000;
      
      // Set by the killer so the close handler can tell "we timed it out" apart
      // from "the CLI exited on its own" — different failures, different message.
      let killedByTimeout = false;     
      killer = setTimeout(() => {
        killedByTimeout = true;
        try {
          logger.warn("🤖 api-Run::TIMEOUT!!!", {closed: closed, as: cliId, input: input, buffer: buf, emitted: emittedText})
          child.kill("SIGTERM"); //bon necessary
        } catch { /* ignore */ }
      }, killMs);

      // Declared before send() so send() can clear it the moment it sees the
      // client disconnect; assigned just below, once close() exists.
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      
      const send = (obj: unknown) => {
        if (closed) return;
        try { 
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); //umm that newline? \n
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
      heartbeat = setInterval(() => send({ type: "keepalive" }), 10_000);
      const close = () => {
        //logger.warn("🤖 apiRun::Close", {isClosed: closed, kind: kind, cli: cliId, hasWriteToken: writeToken !== null, tokenReleased: !writeTokenReleased})
        if (!closed) {
          closed = true;
          if (heartbeat) clearInterval(heartbeat); //think this makes nav after a while go to pipeline instead of report from the dialog?
          if (killer) clearTimeout(killer);
          releaseWriteTokenOnce();
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
        if (visible) logger.info("🤖 sendAgentText", {kind: kind, content: visible})
        //send({ type: "text", text: visible }); //toReview** if shouldnt? add check: kind === "pdf"
      };

      /** Surface non-fatal issues in the run log rather than only a server log. */
      const sendWarnings = (warnings: string[]) => {
        for (const w of warnings) send({ type: "text", text: `⚠️ ${w}\n` });
      };

      /** Persist the emitted CV; streams the reason and returns false on failure. */
      const saveCv = (paths: PdfPaths, envelope: CvEnvelope) => {
        const written = writeCvHtml({ pdfPaths: paths, html: envelope.html });
        //if (!written.ok) send({ type: "error", msg: written.error.slice(0, 200) }); //should be this and send error to frontend..todo**
        !written.ok ?  logger.info("🤖 saveCv --Boo Error", {kind: kind, error: written.error.slice(0, 200), paths: paths, envelope: envelope}) : logger.info("🤖 saveCv --YEEEYUH", {kind: kind, paths: paths, envelope: envelope}); 
        return written.ok;
      };

      const processParsedLine = (line: string) => { //prolly should use this instead of 'streamNodeAction' when have parseOllamaEvent for parseEvent
        if (!spec.parseEvent) return;
        const ev = spec.parseEvent(line);
        if (ev?.text) {
          emittedText = true;
          // sendAgentText, NEVER send: pdf's CV arrives inside the agent's text as a
          // <<cv-html>> envelope, so parsed text has to reach cvFilter too or the
          // backend has nothing to save and the 25 KB body floods the run log (#2185).
          sendAgentText(ev.text);
        }
        if (ev?.tool) send({ type: "tool", name: ev.tool });
        if (ev?.status) send({ type: "status", label: ev.status });
        // Accumulated, not assigned: usage events are per-turn, so overwriting made a
        // multi-turn run report only its last turn. The authoritative "done" is sent
        // on close, so the honesty gate decides done-vs-error first.
        lastTokens = accumulateTokens(lastTokens, ev);
        if (typeof ev?.costUsd === "number") lastCostUsd = ev.costUsd;
        if (ev?.error) {
          sawError = true;
          send({ type: "error", msg: ev.error.slice(0, 200) });
        }
      };

      const saveTokens = (s: string) =>{
        if (/input_tokens|output_tokens/im.test(s)) {
          //try to save the tokens?--should skip if seen multiple times...use lastCostUsd as flag? toReview**
          let usage;
          try { 
            usage = JSON.parse(s)
            lastTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0);
            lastCostUsd = (usage.requests || 0) + (usage.tool_calls || 0) //WRONG..toFix**
          }catch(e) { 
            logger.error(`🤖 saveTokens >> ERROR json!!`, {data: `${s} \n`});
          };
        }
      }

      const streamNodeAction = (node: any) => { //todo** move this into run-cli-support.mjs
        let type = node.type || "";
        let data = node.data || "No data" ; 
            //skip for 'UserPromptNode'  && 'ModelRequestNode' && 'CallToolsNode' ? 
            //FunctionToolResultEvent as status? >> use ToolReturnPart instead? ..prolly both
        if (type == 'UserPromptNode' || type == 'FinalResultEvent' || type == 'FinalEndNode' ){
          logger.info(`🤖 ${type}`, node);
          return
        }
        
        sendAgentText(`${type} : ${data}`)
        //use if and build object...
        let toSend = type == 'ToolCallPart' || type =='FunctionToolCallEvent' ? 'tool' : type == 'UserPromptNode' ? 'status' : 'text' //add in here 'FunctionToolCallEvent?' //umm
        send({ type: toSend, label: `${toSend}`, name: `${data}` });
        emittedText = true;
      }
      
      const processOllamaEvt = (line: string) => {
        //if (!spec.parseEvent) return;
        //const ev = spec.parseEvent(line);
        ////status?: string, tool?: string, text?: string, tokens?: number, tokensAreTotal?: boolean, costUsd?: number | null, error?: string 

        let oContent;
        try {
          oContent = JSON.parse(line);
          let OfType = oContent.OfType || undefined
          switch (OfType) { //smh falls through without return on a case smh
            case undefined: return logger.error("🤖 ERROR?--undefined OfType", {content: oContent}); //throw new Error("ERROR YO, no type!!");
            case 'Result': send({ type: "text", text: `${oContent.output ?? 'Nothing?'}` });
            case 'Tokens': return saveTokens(line);
            case 'Info': return logger.toFile(filePath, `\n ${line} \n`); //bon save this to file
            case 'NodeType': return streamNodeAction(oContent);
            default:
              logger.error("🤖 processOllamaEvt >>ERROR?--No OfType", { closed: closed, cli: cliId, content:line})
          }

        } catch {
          console.error(`🤖   processOllamaEvt >>Ollama...ERROR json!! \n ${line} \n`);

          //send({ type: "text", text: "Received some json!!"});
        }
      }
      
      child.stdout.on("data", (d: Buffer) => { //chunk: string
        if (closed) return;
        if (isOllama){
          return processOllamaEvt(d.toString()); //try with toString('utf8') ?
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
          //whole try below would be replaced by below
          ////if (line) processParsedLine(line);
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

      child.stderr.on("data", (d: Buffer) => { //chunk: string
        const s = d.toString();
        logger.info("🤖  stream::apiRun::stderr", { size: s.length})
        // Widened: auth/login/quota failures are the most common real error and
        // the old narrow regex missed them (silent false "success").
        //fs.writeFileSync(filePath,`\n ${s} \n`, {flag: 'a',encoding: 'utf8'});
        logger.toFile(filePath, `\n ${s} \n`)
        
        if (/error|denied|fatal|not found|unauthorized|forbidden|auth|credential|api[ -]?key|quota|rate limit|not authenticated/i.test(s)) { // |login|
          //console.log(`🤖  stream::apiRun::onData Errr...SHIET ERROR? \n\n`,s) //test not premature stream closing..the string trimming en plus smh
          //sawError = true;
          //send({ type: "error", msg: s.trim().slice(0, 200) });
          let nodeT = s.slice(0, 100);
          logger.error("🤖  onStderr", { size: s.length, message: 'some matching errs', type: nodeT}) //on:'stderr',
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
          logger.info("🔗 rendering PDF", {kind: kind, report: input, paths: paths, format: format})
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

      child.on("error", (e) => { 
        send({ type: "error", msg: e.message }); 
        logger.error("💣 ERROR", {kind: kind, msg: e.message, closed: closed, cli: cliId})
        close(); 
      });

      child.on("close", (code) => {
        const wroteReport =  hasNewCompletedReport(reportsBefore, countReports()); //countReports() > reportsBefore;
        const cleanExit = code === 0; // non-zero OR null (killed/signal) = NOT clean
        // Honesty gate (#9): a green "done" with a parsed score requires a CLEAN exit,
        // real output, AND (for evaluations) a report actually written. Anything else
        // is surfaced — an errored run must never be banked as a confident score.
        console.log(`🤖  stream::apiRun::onClose >> cleanExit? ${cleanExit} 
          <> emittedText: ${emittedText} 
          <> anyError?: ${sawError} <--> closed? ${closed}
          <> reportMade?:${wroteReport} -- from: ${reportsBefore.length} >>to ${countReports().length}
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
          if (tail) {logger.info("🤖 tailzzz", {content: tail, pdfs:pdfPaths}) ;send({ type: "text", text: tail }); }

          const envelope = cvFilter?.result();
          if (envelope) logger.info("🤖 cvEnvelope PRESENT!", {content: envelope,  pdfs:pdfPaths});
          const outcome = pdfRunOutcome({
            envelope,
            noOutputMessage: null, //toReview** //noOutputError(),
            sawError,
            cleanExit,
            hasPaths: pdfPaths !== undefined,
          });
          
          if (!outcome.ok) {
            logger.error("🤖 PDF run BAAAD outcome!", {content: outcome, envelope: envelope, pdfs:pdfPaths});
            //send({ type: "error", msg: outcome.message }); //send?
          } else if (!pdfPaths || envelope?.ok !== true) {
            // Unreachable: pdfRunOutcome validated both via hasPaths/envelope.ok.
            // Kept for narrowing, but it must REPORT rather than fall through to a
            // bare close() — a stream that ends with neither error nor done is the
            // one outcome this handler exists to prevent.
            logger.error("🤖 No PDF paths?!?", {content: outcome, envelope: envelope, pdfs:pdfPaths});
            send({ type: "error", msg: "Internal error: the pdf run passed its gate with no CV to save — No paths or envelope!!" });
          } else {
            sendWarnings(envelope.warnings);
            if (saveCv(pdfPaths, envelope)) {
              logger.info("🤖 WOOH saved CV..now rendering PDF", {envelope: envelope, pdfs:pdfPaths});
              // Tracked so cancel() can defer releasing writeToken until this
              // settles; close() happens once rendering finishes, not here.
              pdfRenderPromise = renderPdf(pdfPaths, envelope.format); 
              return;
            }
          }
          return close();
        }
  
        if (!emittedText && !sawError && !cleanExit) {
          send({ type: "error", msg: "The CLI exited with an error — is it installed and authenticated?" });
        } else if (!emittedText && !sawError) {
          if(lastTokens && lastCostUsd){
            //bon just to bypass emittedText...toRedo**
            logger.warn("🤖 stream::apiRun", {on:"onClose", type: "done..BYPASS", tokens: lastTokens, costUsd: lastCostUsd})
            send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
          }else{
             send({ type: "error", msg: "The CLI produced no output — is it installed and authenticated? (career-ops is best on Claude Code.)" });
          } 
        } else if (persists && !wroteReport) { //toReview..prolly needed for close?
          logger.warn("🤖 stream::apiRun", {on:"onClose", content: "evaluation didn't save a report..error?", kind:kind, tokens: lastTokens, costUsd: lastCostUsd})
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
      //releaseWriteTokenOnce();
      if (pdfRenderPromise) {
        // Render/mark keeps running after this client disconnects — wait for
        // it to settle before releasing the guard, so a concurrent tracker
        // delete can't race mark-pdf-ready.mjs's still-in-flight write.
        pdfRenderPromise.finally(releaseWriteTokenOnce);
      } else {
        releaseWriteTokenOnce();
      }
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
