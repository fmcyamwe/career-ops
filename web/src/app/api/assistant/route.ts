import { spawn } from "node:child_process";
//import fs from "node:fs";
import path from "node:path";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot, readMemory, doctorState } from "@/lib/career-ops";
import { assistantPreamble } from "@/lib/run-prompts.mjs";
import logger from "@/lib/logger.mjs"

export const runtime = "nodejs"; // child_process (spawn) requires the Node runtime
export const dynamic = "force-dynamic";
export const maxDuration = 120;


type Msg = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  let body: { message?: string; cliId?: string; history?: Msg[]; pageContext?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  const { message, cliId, pageContext } = body;
  if (!message || !cliId) {
    return new Response(JSON.stringify({ error: "message and cliId required" }), { status: 400 });
  }

  const resolved = resolveCli(cliId);
  if (!resolved) {
    return new Response(JSON.stringify({ error: `CLI '${cliId}' not found on this machine` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;

  const history = (body.history ?? []).slice(-8);
  const convo = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
  const pageLine = pageContext
    ? `\n\nCURRENT PAGE (the user is looking at this right now): ${pageContext}\nWhen the user's message is ambiguous ("this", "it", "apply", "evaluate this", "draft it"), assume it refers to what's on the current page.`
    : "";
  const memory = readMemory();
  const memoryLine = memory.trim()
    ? `\n\nWHAT YOU KNOW ABOUT THE USER (persistent memory — carries across sessions and CLIs):\n${memory.trim()}`
    : "\n\n(No persistent memory about the user yet — learn and use <<remember:>> as you go.)";
  // Hand the assistant the SAME authoritative setup signal the home screen reads
  // (doctorState), so it never re-asks for a file that already exists (disc#7) —
  // the home was correctly nudging for the missing PROFILE while the assistant,
  // given no state, restarted its onboarding script and asked for the CV again.
  const { hasCv, onboardingNeeded, missing } = doctorState();
  const setupLine = onboardingNeeded
    ? `\n\nSETUP STATE (authoritative — the SAME signal the home screen uses; trust it over guessing, and do NOT re-ask for anything already on file):\n- CV on file (cv.md): ${hasCv ? "YES — do NOT ask for it again; read it to be concrete" : "NO — this is the first thing to collect"}\n- Still missing: ${missing.length ? missing.join(", ") : "nothing"}\nWhen onboarding, START at the first item actually missing. If the CV is already on file, SKIP step 1 entirely and go straight to the next missing prerequisite (usually the profile — target roles, comp, location).`
    : `\n\nSETUP STATE: this user is fully set up (CV + profile + scanner all on file). Do NOT run onboarding or ask for a CV — just help them with what they actually asked.`;
  const prompt = `${assistantPreamble()}${setupLine}${memoryLine}${pageLine}\n\n--- Conversation ---\n${convo}\nUser: ${message}\nAssistant:`;

  // Claude Code streams token-level deltas via stream-json + partial messages.
  // Other CLIs: pass their stdout through raw.
  // The chat CLI is READ-ONLY: all writes go through gated registry actions
  // (remember → /api/memory, setStatus → /api/status), never the CLI editing
  // files directly. Scope its tools so it can advise (read) but not blind-write.
  const isClaude = cliId === "claude";
  const isOllama = cliId === "ollama";
  // allowedTools must be COMMA-separated; disallowedTools is the hard guardrail
  // so the advisor can read (and WebFetch) but never blind-writes or shells out.
  const args = isClaude
    ? [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read,WebFetch,Glob,Grep",
        "--disallowedTools",
        "Bash,Write,Edit,NotebookEdit,Task",
      ]
    : isOllama 
    ? 
      [
        'run', 
        //'-u', // flag for unbuffered stdout?--bof for python
        // '-v' instead for uv? --meh no need with flush flag in print 
        'agent.py',
        '--question',
        `${message}`,
        '--prompt',
        `${prompt}`,
        '--fromP',
        'api-assistant',
        //also allowedTools && disallowedTools? prolly...todo**
      ]
    : 
    spec.args(prompt);

  const filePath = path.join(careerOpsRoot(), 'api-assistant.log'); 
  //console.log(`🤖  assistant::POST...args...${careerOpsRoot()}\n\n`, args);
  logger.info("🤖 api-assistant", {root: careerOpsRoot(), args: args})


  const child = isOllama 
  ?
  //spawn(`ollama`, args) //`${binPath} serve` //binPath+" "+'serve' 
  //>>child process runs without spawn cmd options? tho cwd defaults to current working directory anyway? >> still error out with ENOENT...
  //// need to run straight cmd instead? >>yup works with spawn(`ollama`, ['serve'])
  //spawn(`curl`, args)  //works!
  //spawn(binPath, ['serve']) //huh also works with binPath as /opt/homebrew/bin/ollama BUT 500 error trying to load model
  //spawn('node',args, { cwd: careerOpsRoot(), stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }) //yeeeeeyuh!!
  //huh complains when last 'pipe' was 'ipc'...but not for third 'pipe'..huh?
  // yeeeyuh works and with the 'stdio' options output captured via console.log! 
  // also adding cwd does change working dir and script need to be in parent dir or borks >> /Users/florentcyamweshi/Downloads/career-ops
  spawn('uv', args, { cwd: careerOpsRoot(), stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }) //oldie that worked >> cwd: path.join(careerOpsRoot(), "seeds")
  //spawnHeadlessCli('uv', args, { cwd: careerOpsRoot(), stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }) //huh works //toSee with stdout changes to pipe as dont honor stdio params..., 
  :
  //spawn(binPath, args, { cwd: careerOpsRoot(), env: process.env });
  spawnHeadlessCli(binPath, args, { cwd: careerOpsRoot(), env: process.env });

  child.stdout.setEncoding("utf8"); //has any effect? >>dont seem like? even when should expect string instead of Buffer...
  child.stderr.setEncoding("utf8");//idem above

  const encoder = new TextEncoder();
  //child.stdout.pipe
  // `closed` + kill timer in the OUTER scope so cancel() can flip `closed` before
  // the child's late handlers run — otherwise they enqueue onto an already-closed
  // controller and throw an uncaught "Controller is already closed" (see #1155).
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  let output = "";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emitted = false;
      killer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 90_000);
      const safeClose = () => {
        if (!closed) {
          closed = true;
          if (killer) clearTimeout(killer);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };
      const safeEnqueue = (s: string): boolean => {
        //console.log(`🤖  stream::apiAssistant::safeEnqueue....${s}\n ${closed}`);
        if (closed || !s) return false;
        try {
          controller.enqueue(encoder.encode(s));
          return true;
        } catch {
          closed = true; // controller already closed underneath us — stop, never crash
          return false;
        }
      };

      const streamNodeAction = (chunk: string) => {
        let oContent;
        try { 
          oContent = JSON.parse(chunk); 
          let type = oContent.type || "";
          let data = oContent.data || "No data" ;
          let toSend = type == 'ToolCallPart' || type =='FunctionToolCallEvent' ? 'tool' : type == 'FinalResultEvent' ? 'status' : 'text'
          
          if (safeEnqueue(`${toSend} : ${data}`)) emitted = true;
        } catch {
          //handle error?!? retry?
          //console.log(`🤖  stream::onEmit>>Ollama...ERROR json!! \n ${s} \n`);
          logger.error("🤖 stream::apiAssistant::ERROR json", {on: 'OnEmit Ollama.', data: chunk})
        }
      };

      const emit = (s: string) => {
        //console.log(`🤖  stream::apiAssistant::onEmit....\n ${s}`);
        //logger.info("🤖 apiAssistant::onEmit", {data: s})
        if(isOllama){
         
          return streamNodeAction(s);
        }
        
        if (safeEnqueue(s)) emitted = true;
      };

      child.stdout.on("data", (d: Buffer) => { //chunk: string
        //console.log(`🤖 stream::apiAssistant::onData....${d.byteLength} \n`);
        logger.info("🤖 stream::apiAssistant", {on: 'stdout:onData', size: d.byteLength})
        if (closed) return;
        if (!isClaude) {
          //here should try and proper parsing >> toReview**
          emit(d.toString());
          return;
        }

        // line-buffered NDJSON → emit only assistant text deltas
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "stream_event" && obj.event?.type === "content_block_delta") {
              const text = obj.event.delta?.text;
              if (typeof text === "string") emit(text);
            }
          } catch {
            /* partial / non-json line — skip */
          }
        }
      });

      child.stderr.on("data", (d: Buffer) => { //chunk: string
        const s = d.toString();
        //console.log(`🤖  stream::apiAssistant::onData Errr....${s} \n`); 
        //huh thinking output?--from console.error--any text with error gets passed to parent--before process.exit(1)
        //fs.writeFileSync(filePath, s, {flag: 'a',encoding: 'utf8'}); //yeeeyuh 'a' flag to append!!
        logger.toFile(filePath, `\n ${s} \n`)
        logger.info("apiAssistant::stderr", {size: d.byteLength}) //on:'stderr', 

        if (/error|not found|denied|fatal/i.test(s)) {
          //safeEnqueue(`\n[${spec.name}] ${s.trim()}\n`); //bon dont just send to frontend willy nilly!
          let nodeT = s.slice(0, 50);
          //console.log(`🤖  stream::apiAssistant::onData Errr...SHIET ERROR? \n\n`)
          logger.error("🤖  stream::apiAssistant:::stderr", { size: d.byteLength, message: 'SHIET ERROR?', type: nodeT}) 
        }
        if (/input_tokens|output_tokens/i.test(s)) {
          //try to save the tokens?--should skip if seen multiple times...use lastCostUsd as flag? toReview**
          let usage;
          try{ usage = JSON.parse(s) } catch { console.error(`🤖  stream::apiAssistant::onData Errr...ERROR json!! \n ${s} \n`);};
          //lastTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0);
          //lastCostUsd = (usage.requests || 0) + (usage.tool_calls || 0) //WRONG..toFix**
        }
      });

      child.on("error", (e) => {
        console.log(`🤖  stream::apiAssistant::onError....${e.message} \n`); 
        safeEnqueue(`\n[error launching ${spec.name}: ${e.message}]`);
        safeClose();
      });
      child.on("close", (code,signal) => {
        if (!emitted) { //when process.exit(1) invoked without passing anyting to parent
          safeEnqueue("_(no output — is the CLI authenticated?)_ "+code+" ... "+signal);
        }
        safeClose();
      });
    },
    cancel() {
      closed = true;
      if (killer) clearTimeout(killer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
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
