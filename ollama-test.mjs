#!/usr/bin/env node
// test for ollama llm call that gets spawn?
// could also do tool tests here!

import { execFileSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, format } from 'path';
import { fileURLToPath } from 'url';
//import { careerOpsRoot, readMemory } from "./src/lib/career-ops.ts"; //borks with/without .ts >>inner import issues


let modelName = process.env.OLLAMA_MODEL || 'gemma4';
let baseUrl   = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const timeoutMs = parseInt(process.env.OLLAMA_TIMEOUT_MS || '300000', 10);

const ROOT = dirname(fileURLToPath(import.meta.url)); //Users/florentcyamweshi/Downloads/career-ops (should)
//how to make above point to parent's dir? >>gotta set cwd in calling script!
// and wont it mess up inner imports still? >>prolly if was still in /web
const NODE = process.execPath;

const PATHS = { //toSee
  shared:   join(ROOT, 'modes', '_shared.md'),
  profile:  join(ROOT, 'modes', '_profile.md'),
  oferta:   join(ROOT, 'modes', 'oferta.md'),
  cv:       join(ROOT, 'cv.md'),
  cprofile: join(ROOT, 'config', 'profile.yml'),
  reports:  join(ROOT, 'reports'),
};

const args = process.argv.slice(2);
//const dryRun = args.includes('--dry-run'); // test passing in args >>yup works
const hasQ = args.includes('--question');  //requiered
const hasPrompt = args.includes('--prompt');  //should use when present?

//if (!dryRun) { 
//  console.error(`umm --dry-run argument needed!`);
//  process.exit(1);
//}

//console.error(`Current ROOT:: ${ROOT} \n`); // //career-ops/web when "cwd" not set in calling parent!
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_temperature',
      description: 'Get the current temperature for a city',
      parameters: {
        type: 'object',
        required: ['city'],
        properties: {
          city: { type: 'string', description: 'The name of the city' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'WebFetch the content of a job posting the url',
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'The url of the job posting' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read and get the content of a file',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'The path to the existing file' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_file',
      description: 'Run a script file and capture the output',
      parameters: {
        type: 'object',
        required: ['name', 'args'],
        properties: {
          name: { type: 'string', description: 'The name of the script file to execute' },
          args: { type: 'array', description: 'Array of arguments for the script execution' },
        },
      },
    },
  }
]

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function fileExists(relPath) {
  //return existsSync(join(ROOT, relPath)); //umm wouldnt this be wrong where invoked?
  return existsSync(relPath); 
}

/*function readFile(path, label) {
  if (! existsSync(path)) { // !fileExists(path)
    console.warn(`⚠️   ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return readFileSync(path, 'utf-8').trim();
}*/
function readFile(relPath, label) {
  try { return readFileSync(relPath, 'utf-8').trim(); }
  catch { 
    console.warn(`⚠️   ${label} reading issue at: ${relPath}`);
    return `[${label} not found — skipping]` ; //`⚠️   ${label} not found at: ${relPath}`; //null; 
  }
}

function getFileOrDefault({path}) { //, label
  if(fileExists(path)) return readFile(path, path);
  if (fileExists(join(ROOT, path))) { //!existsSync(path)
    //console.warn(`⚠️   ${label} not found at: ${path}`);
    //return `[${label} not found — skipping]`;
    return readFile(join(ROOT, path), path);
  }

  return `[${path} not found — skipping]`; //or just //readFile(path);  //readFileSync(path, 'utf-8').trim();
}

function runScript({script, args}) { //, sandbox
  //const env = {
  //  ...process.env,
  //  CAREER_OPS_TRACKER: sandbox.tracker,
  //  CAREER_OPS_ADDITIONS: sandbox.additions,
  //  CAREER_OPS_TRACKER_LOCK: sandbox.lock,
  //};
  try {
    const stdout = execFileSync(NODE, [join(ROOT, script), ...args], {
      cwd: ROOT, encoding: 'utf-8', timeout: 30000,
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

let question = "";
let prompt = '';
let allowedTls = '';
let disallowedTls = '';
let from = 'assistant'; //default..huh isnt 'from' a reserved keyword?

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--question' && args[i + 1]) {
    question = args[++i];
  } else if (args[i] === '--prompt' && args[i + 1]) {
    prompt = args[++i];
  } else if (args[i] === '--allowedTools' && args[i + 1]) {
    allowedTls = args[++i];
  } else if (args[i] === '--disallowedTools' && args[i + 1]) {
    disallowedTls = args[++i];
  } else if (args[i] === '--from' && args[i + 1]) {
    from = args[++i];
  }
}

if(!hasQ || question == ''){
  console.error(`umm --question argument needed!`);
  process.exit(1);
}

function getTemperature({city}) { //: string 
  const temperatures = { //: Record<string, string>
    'New York': '22°C',
    'London': '15°C',
    'Tokyo': '18°C',
  }
  return temperatures[city] ?? 'Unknown'
}

async function fetchJobPage({url}) {
  //assertSafeRemoteUrl(url);
  let chromium;
  try {
    ({ chromium } = await import('playwright')); //not sure this import will resolve..
  } catch {
    console.warn('[fetch] Playwright unavailable — falling back to plain fetch.');
  }

  if (chromium) {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForTimeout(3000); //3000 wait for SPA render--1000 + Math.random() * 3000
      
      const text = await page.evaluate(() => {
        //console.log('Chromium! > \n', document.body?.innerText,"\n\neeeeeeee ----\n", document.body?.textContent || 'NADA')
        //.cookie-banner, #cookie-modal, .gdpr-overlay
        document.querySelectorAll('script,style,nav,footer,header').forEach(el => el.remove());
        return (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
      });
      console.warn('USED>> Chromium!!!', url, JSON.stringify(text));
      return text.slice(0, 16_000);
    } catch (e) {
      console.warn(`[fetch] Playwright error: ${e.message} — falling back to plain fetch.`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  // Plain HTTP fallback
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; career-ops/1.0)' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const html = await r.text();
    console.warn('USED>> HTTP!!!', url, html)
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 16_000);
  } catch (e) {
    throw new Error(`Could not fetch job page: ${e.message}`);
  }
}

async function callLLM(mess) {
  const endpoint = `${baseUrl}/v1/chat/completions`;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:    modelName,
        messages: mess,
        tools: [...tools],
        stream:      false,
        temperature: 0.1, //0.4,
        max_tokens: 8192, //4096, //prolly better than 4096 default
        //think: true, //toUse? >meh...prolly no need
        //format:"json", //umm? > prolly response_format
        options: { num_ctx:64000, num_predict:64000, temperature: 0.1 }, 
        //32768 these options?!? context? set to min of 64000?
        //num_ctx is the total context window. num_predict is the max output tokens.
        // otherwise, Ollama defaults to 2,048 total, leaving almost no room for output after the system prompt and conversation history consume their share.

      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text();
      return ["","",`    ${body.slice(0, 300)}`] //content, tool_call, error
      //no exit yet?...
    }
    const data = await res.json();
    console.error(`🤖  WEEE REsponse Ollama (${modelName}) \n mess`, JSON.stringify(data));
    //so here is where gotta do tools calls!
    let message = data.choices?.[0]?.message
    let finish_reason = data.choices?.[0]?.finish_reason ?? ""
    if (!message){
      return [finish_reason,"",` Error no Ollama response?   ${data}`]
    }
    return [finish_reason,{...message},""]
  } catch (err) {
    console.error(`❌  Ollama API call failed: ${err.message}`);
    return ["","",` ${err.message}`]
  }

}
async function llmOrchestrator(sysPrompt, task) {
  const messages = [
    { role: 'system', content: sysPrompt},
    { role: 'user',   content: task },
  ]
  //let assistant = { //instead of const >> nope nope...lotsa json errors in next loop!
  //  role: "assistant",
    //tool_calls: []
  //}

  const availableFunctions = {
    get_temperature: getTemperature,
    web_fetch: fetchJobPage,
    read_file: getFileOrDefault,
    execute_file: runScript,
    
  };
  let evaluationText;
  let has_tools_calls = false;
  let done = "" //?

  try {
    do {
      const [stop_reason, message ,error] = await callLLM(messages)
      if(error !== ''){
        console.error('An error occurred::bork', error, stop_reason)
        //process.exit(1); //exit? or continue?
      }
      done = stop_reason; //ToTest**
      evaluationText = message?.content?.trim();
      has_tools_calls = message?.tool_calls?.length;
      if(has_tools_calls ){
        if(evaluationText == '' && stop_reason == 'tool_calls'){
          for (const tooly of message?.tool_calls) {
            const functionToCall = availableFunctions[tooly.function.name];
            if (functionToCall){
              //console.error('Calling function:', tooly.function.name);
              //console.error('Arguments:', tooly.function.arguments);
              let output = functionToCall(JSON.parse(tooly.function.arguments)); // JSON.parse needed prolly
              console.error(`tool_calls:: Calling >> ${tooly.function.name} with arguments >> ${ tooly.function.arguments} \n Function output: ${output}`);
              //should add to messages for last api hit?--toReview**. //"function"
              //also shift() to remove system? assistant.tool_calls.push(
              let newT_c = { type: tooly.type , function: {index: tooly.index, name: tooly.function.name, arguments: tooly.function.arguments} } //) "function"
              //assistant = 
              //messages.push(JSON.stringify({...assistant, tool_calls: [newT_c]})); // tool_calls:assistant.tool_calls.push({ type:tooly.type , function: {index: tooly.index,"name": "get_conditions", "arguments": {"city": "New York"}}})}
              messages.push({role: "assistant", tool_calls: [newT_c]});
              messages.push({ role: 'tool', tool_name: tooly.function.name, content: String(output) })
            } else {
              console.error('Function', tooly.function.name, 'not found');
            }
          }
        } //else { //just in case>>meh never gets here...
          //console.error('Weeird..tool_calls issue?', evaluationText, stop_reason);
        //}
      } else {
        console.error('ngggo return...\n',evaluationText, done,message, JSON.stringify(messages))
        return evaluationText; //toTest** some more...empty on tool calls!
      }
    } while (done !== "stop")

  } catch(err){
    if (err.name === 'TimeoutError') {
      console.error(`❌  Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
      console.error(`    Try a smaller/faster model, or increase OLLAMA_TIMEOUT_MS.`);
    } else {
      console.error(`❌  Ollama API call failed: ${err.message}`);
    }
    process.exit(1);//exit?
  }
}

/*
async function oldie_callLLM(sysPrompt, task) { //redundant--toRemove**
  const endpoint = `${baseUrl}/v1/chat/completions`;
  //const timeoutMs = parseInt(process.env.OLLAMA_TIMEOUT_MS || '300000', 10);
 
  const availableFunctions = {
    get_temperature: getTemperature,
    web_fetch: fetchJobPage
  };
  let evaluationText;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:    modelName,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user',   content: task },
        ],
        tools: [...tools],
        stream:      false,
        temperature: 0.1, //0.4,
        max_tokens: 8192, //4096, //bon see if sending it better than 4096 default
        //think: true, //toUse? >meh...prolly no need
        //format:"json", //umm? > prolly response_format
        options: { num_ctx:64000, num_predict:64000, temperature: 0.1 }, 
        //32768 these options?!? context? set to min of 64000?
        //num_ctx is the total context window. num_predict is the max output tokens.
        // otherwise, Ollama defaults to 2,048 total, leaving almost no room for output after the system prompt and conversation history consume their share.

      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`❌  Ollama API error: HTTP ${res.status}`);
      console.error(`    ${body.slice(0, 300)}`);
      process.exit(1);
    }

    const data = await res.json();
    console.error(`🤖  WEEE REsponse Ollama (${modelName}) \n`, JSON.stringify(data));
    //so here is where gotta do tools calls!
    let message = data.choices?.[0]?.message
    if (data.message?.tool_calls){
      for (const tooly of data.message?.tool_calls) {
        const functionToCall = availableFunctions[tooly.function.name];
        if (functionToCall){
          console.error('Calling function:', tooly.function.name);
          console.error('Arguments:', tooly.function.arguments);
          let output = functionToCall(tooly.function.arguments); //umm no need to coerce arguments as destructuring?
          console.error('Function output:', output);
          //should add to messages for last api hit?--toReview**
          //messages.push({ role: 'tool', tool_name: call.function.name, content: String(result) })
        } else {
          console.error('Function', tooly.function.name, 'not found');
        }
      }
    }
    evaluationText = data.choices?.[0]?.message?.content?.trim();
    if (!evaluationText) {
      console.error('❌  Ollama returned an empty response.');
      process.exit(1);
    }
    return data; //evaluationText; //toSee with data...and stringify again before return...
  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.error(`❌  Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
      console.error(`    Try a smaller/faster model, or increase OLLAMA_TIMEOUT_MS.`);
    } else {
      console.error(`❌  Ollama API call failed: ${err.message}`);
    }
    process.exit(1);
  }
}*/

let evaluationText;

evaluationText = await llmOrchestrator(
      //systemPrompt,
      //`JOB DESCRIPTION TO EVALUATE:\n\n${jdText}`,
      //todo** USE from below**
      prompt == '' ? "You are a helpful assistant." : prompt ,
      prompt == '' ? question : `JOB URL TO EVALUATE: ${question}`,
    );
  
console.log(JSON.stringify(evaluationText)); //evaluationText

//as json below that get parsed in parent afterwards? toTry and return res.json() from callLLM()
////console.log(JSON.stringify({ dryRun, ...out.result }, null, 2));

process.exit(0); //umm prolly needed...