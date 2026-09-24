
// About building system prompt for Ollama model <> ripped from ./lib/context-budget.mjs

import { CV_ENVELOPE_INSTRUCTION } from "./cv-envelope.mjs";
import logger from "@/lib/logger.mjs";
import { sharedContext, ofertaMode, pdfMode, coverMode, cvContent, profileContext,  profileConfigYml, languageInstruction } from "@/lib/core/context-files";

/**
 * context-budget.mjs — Token budget management for career-ops evaluators
 *
 * Provides lightweight token estimation and priority-based compression of
 * _shared.md context sections. Keeps evaluation-critical sections (P0:
 * scoring, archetypes, legitimacy, global rules) intact while trimming
 * generation-oriented sections (P2: voice DNA, writing style, ATS rules)
 * when the prompt approaches the model's context limit.
 *
 * Zero external dependencies — uses character-based estimation (~4 chars/token
 * for English text) with a safety margin to stay within model context windows.
 */

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the number of tokens in a text string.
 *
 * Uses a simple character-based heuristic: effective characters ÷ 4.
 * Whitespace is collapsed before counting. This is ~12% accurate for English
 * prose, which is sufficient when combined with a safety margin.
 *
 * @param {string} text - The text to estimate tokens for.
 * @returns {number} Estimated token count (always ≥ 0).
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  // Collapse whitespace (tokens aren't sensitive to repeated spaces/newlines)
  const effectiveChars = text.replace(/\s+/g, ' ').length;
  return Math.ceil(effectiveChars / 4);
}



// ---------------------------------------------------------------------------
// Section priority classification
// ---------------------------------------------------------------------------

/**
 * Priority map for _shared.md sections.
 *
 * P0 (never compress): Scoring System, Archetype Detection, Posting Legitimacy,
 *   Global Rules — these directly determine evaluation quality.
 * P1 (compress when budget tight): Company Type taxonomy, Spend Tier routing —
 *   useful but the model often has this knowledge baked in.
 * P2 (prefer to compress): Voice DNA, Writing Style Calibration, Professional
 *   Writing & ATS, Sources of Truth — these serve text generation, not scoring.
 *
 * Sections not listed default to P2 (safe to compress).
 *
 * Keys are lowercase for case-insensitive matching against `## Section Name` headers.
 *
 * @type {Record<string, number>}
 */
export const SECTION_PRIORITY = {
  // P0 — evaluation-critical (never compress)
  'scoring system': 0,
  'archetype detection': 0,
  'posting legitimacy': 0,
  'global rules': 0,
  'data root & path resolution': 0,

  // P1 — useful but non-critical (compress when budget tight)
  'company type and compensation reliability': 1,
  'spend tier': 1,

  // P2 — generation-oriented (prefer to compress)
  'sources of truth': 2,
  'voice dna': 2,
  'writing style calibration': 2,
  'writing style': 2,
  'professional writing & ats compatibility': 2,
};

/**
 * Default priority for sections not explicitly listed in SECTION_PRIORITY.
 * Conservative: unknown sections are treated as safe to compress (P2).
 *
 * @type {number}
 */
export const DEFAULT_PRIORITY = 2;

// ---------------------------------------------------------------------------
// Context budget defaults
// ---------------------------------------------------------------------------

/**
 * Default maximum prompt tokens (GPT-4o-mini context window).
 * @type {number}
 */
export const DEFAULT_MAX_TOKENS = 128000;

/**
 * Safety margin reserved for the model's maxOutputTokens / response.
 * @type {number}
 */
export const DEFAULT_SAFETY_MARGIN = 8192;

// ---------------------------------------------------------------------------
// Section parsing helpers
// ---------------------------------------------------------------------------

/**
 * Split _shared.md into an array of { name, content } section objects.
 *
 * Sections are delimited by `## Section Name` headers. Content before the
 * first `## ` header is treated as a preamble (name = '').
 *
 * @param {string} sharedContent - Raw _shared.md content.
 * @returns {Array<{ name: string, content: string }>}
 */
function parseSections(sharedContent) {
  const sections = [];
  // Split on `## ` at line start, capturing the header text.
  // Parts[0] = preamble, then [header1, body1, header2, body2, ...]
  const parts = sharedContent.split(/^## (.+)$/gm);

  if (parts[0] && parts[0].trim()) {
    sections.push({ name: '', content: parts[0] });
  }

  for (let i = 1; i < parts.length; i += 2) {
    const name = (parts[i] || '').trim();
    const body = parts[i + 1] || '';
    if (name) {
      sections.push({ name, content: `## ${name}${body}` });
    }
  }

  return sections;
}

/** @type {Set<string>} Tracks already-warned section names to avoid log spam. */
const _warnedSections = new Set();

/**
 * Look up the priority of a section by its header name.
 *
 * Emits a warning when a section falls through to DEFAULT_PRIORITY so drift
 * between _shared.md headings and SECTION_PRIORITY is observable.
 *
 * @param {string} sectionName - The section header text (e.g., "Scoring System").
 * @returns {number} 0 (P0), 1 (P1), or 2 (P2 / default).
 */
function getPriority(sectionName) {
  const key = sectionName.toLowerCase()
    // Strip parenthetical suffixes like "(Block G)" or "(writing guardrail)"
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!(key in SECTION_PRIORITY) && !_warnedSections.has(key)) {
    _warnedSections.add(key);
    console.warn(`⚠️  Unrecognized _shared.md section "${sectionName}" → defaulting to P${DEFAULT_PRIORITY} (compressible). Update SECTION_PRIORITY in lib/context-budget.mjs if this section is evaluation-critical.`);
  }
  return SECTION_PRIORITY[key] ?? DEFAULT_PRIORITY;
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/**
 * Compress _shared.md content by removing lower-priority sections.
 *
 * Sections are identified by `## Section Name` headers and removed in
 * priority order (P2 first, then P1) until the target token reduction
 * is met or no more removable sections remain.
 *
 * P0 sections (scoring, archetypes, legitimacy, global rules) are never removed.
 *
 * @param {string} sharedContent - Raw _shared.md content.
 * @param {number} targetReduction - Target number of tokens to remove.
 * @returns {{ compressed: string, removed: string[] }}
 *   compressed — the content with sections removed.
 *   removed — list of section names that were removed.
 */
export function compressSharedContext(sharedContent, targetReduction) {
  if (!sharedContent || targetReduction <= 0) {
    return { compressed: sharedContent || '', removed: [] };
  }

  const sections = parseSections(sharedContent);
  if (sections.length === 0) {
    return { compressed: sharedContent, removed: [] };
  }

  // Classify each section
  const classified = sections.map(s => ({
    ...s,
    priority: s.name ? getPriority(s.name) : -1, // preamble: never remove
    tokens: estimateTokens(s.content),
  }));

  // Collect removable sections (P2 first, then P1), sorted by priority descending (2 before 1)
  const removable = classified
    .filter(s => s.priority >= 1)
    .sort((a, b) => b.priority - a.priority); // P2 before P1

  let tokensRemoved = 0;
  const removed = [];

  for (const section of removable) {
    if (tokensRemoved >= targetReduction) break;
    tokensRemoved += section.tokens;
    removed.push(section.name);
  }

  // Build compressed output: keep sections not in the removed set
  const removedSet = new Set(removed);
  const compressed = classified
    .filter(s => !removedSet.has(s.name))
    .map(s => s.content)
    .join('');

  return { compressed, removed };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Build a token-budgeted context body for job offer evaluation.
 *
 * Assembles the context sections from _shared.md, oferta.md, cv.md, and
 * optional profile files. If the total estimated tokens exceed the available
 * budget, lower-priority sections of _shared.md are compressed.
 *
 * The returned `contextBody` is inserted between the evaluator's header
 * and operating rules — each evaluator (Gemini, OpenAI) keeps its own
 * framing text.
 *
 * @param {object} opts
 * @param {string} opts.sharedContent   - Raw _shared.md content.
 * @param {string} opts.ofertaContent   - Raw oferta.md content (evaluation mode).
 * @param {string} opts.pdfContent      - Raw pdf.md content (pdf mode).
 * @param {string} opts.coverContext    - Raw cover.md content (cover mode).
 * @param {string} opts.cvContent       - Raw cv.md content (candidate resume).
 * @param {string} [opts.profileYml]    - Raw profile.yml content (optional).
 * @param {string} [opts.profileContent] - Raw _profile.md content (optional).
 * @param {number} [opts.maxTokens]     - Model context window (default 128000).
 * @param {number} [opts.safetyMargin]  - Reserved for output tokens (default 8192).
 * @param {string} [opts.evalType]      - Api Run eval type
 * @param {boolean} [opts.noCompress]   - If true, skip compression entirely.
 * @returns {{ contextBody: string, budgetReport: object }}
 *   contextBody — the assembled context sections string.
 *   budgetReport — { totalTokens, budget, compressed, removed, beforeTokens,
 *     afterTokens, overBudget }.
 */
export function buildOllamaTotalContext(opts = {}) { //todo** add for pdfMode && coverMode --todo
  // * @param {Array<{ name: string, content: string, compressible:boolean }>}  [opts.sectionDefs]   - umm toCalc sections..boff
  //* @param {string} [opts.jdText]          - The job description text to evaluate.---prolly redundant >>toRemove**
  const safeOpts = opts ?? {};
  const {
    sharedContent = '', //umm default to ? sharedContext
    ofertaContent = '',
    pdfContent = '',
    coverContext = '',
    cvContent = '',
    profileYml = '',
    profileContent = '',
    //jdText = '',
    //sectionDefs = [],
    maxTokens = DEFAULT_MAX_TOKENS,
    safetyMargin = DEFAULT_SAFETY_MARGIN,
    evalType = 'evaluate', //default
    noCompress = false,
  } = safeOpts;

  const budget = maxTokens - safetyMargin;

  // Build the ordered section list (matches the evaluator prompt structure)
  const sectionDefs = []

  //const sectionDefs = [
  //  { name: '_shared.md', content: sharedContent, compressible: true },
  //  { name: 'oferta.md', content: ofertaContent, compressible: false },
  //  { name: 'cv.md', content: cvContent, compressible: false },
  //];
  evalType == 'evaluate' ? 
  sectionDefs.push(
    { name: '_shared.md', content: sharedContent, compressible: true },
    { name: 'oferta.md', content: ofertaContent, compressible: false }, 
    { name: 'cv.md', content: cvContent, compressible: false }) 
    : evalType == 'pdf' ?
  sectionDefs.push( //may also need to add modes/latex.md ?
    //{ name: '_shared.md', content: sharedContent, compressible: true },//prolly no need
    { name: 'pdf.md', content: pdfContent, compressible: false }, //compress?
    { name: 'cv.md', content: cvContent, compressible: false })
    : evalType == 'cover' ?
  sectionDefs.push(
    { name: 'cover.md', content: coverContext, compressible: false },
    { name: 'cv.md', content: cvContent, compressible: false }) 
    : console.error(`❌  buildOllamaTotalContext error: --no context for Eval type?!?: ${evalType}`); //um so nothing for default? toReview** if shouldnt add
  //sectionDefs.push( //um kinda like default tho? should add? toReview**
  //  { name: 'cv.md', content: cvContent, compressible: false }) 

  if (profileYml) {
    sectionDefs.push({ name: 'profile.yml', content: profileYml, compressible: false });
  }
  if (profileContent) {
    sectionDefs.push({ name: '_profile.md', content: profileContent, compressible: false });
  }

  // JD is always last and non-compressible
  //sectionDefs.push({ name: 'JD', content: jdText, compressible: false });

  // Calculate per-section tokens
  const sections = sectionDefs.map(s => ({
    ...s,
    tokens: estimateTokens(s.content),
  }));

  const estimatedTotal = sections.reduce((sum, s) => sum + s.tokens, 0);

  // Build the budget report
  const report = {
    totalTokens: estimatedTotal,
    budget,
    compressed: false,
    removed: [],
    beforeTokens: estimatedTotal,
    afterTokens: estimatedTotal,
    overBudget: false,
  };

  // If under budget or compression disabled, assemble as-is
  if (estimatedTotal <= budget || noCompress) {
    report.overBudget = estimatedTotal > budget;
    const contextBody = assembleContext(sections.map(s => ({
      name: s.name,
      content: s.content,
    })));
    return { contextBody, budgetReport: report };
  }

  // Need to compress _shared.md
  const reductionNeeded = estimatedTotal - budget;
  const sharedSection = sections.find(s => s.name === '_shared.md');
  const { compressed, removed } = compressSharedContext(sharedSection.content, reductionNeeded);

  report.compressed = removed.length > 0;
  report.removed = removed;

  // Rebuild sections with compressed _shared.md
  const compressedSections = sections.map(s => {
    if (s.name === '_shared.md') {
      const compressedTokens = estimateTokens(compressed);
      return { ...s, content: compressed, tokens: compressedTokens };
    }
    return s;
  });

  report.afterTokens = compressedSections.reduce((sum, s) => sum + s.tokens, 0);
  report.overBudget = report.afterTokens > budget;

  const contextBody = assembleContext(compressedSections.map(s => ({
    name: s.name,
    content: s.content,
  })));

  return { contextBody, budgetReport: report };
}

// ---------------------------------------------------------------------------
// Internal: assemble context sections into the prompt body
// ---------------------------------------------------------------------------

/**
 * @param {Array<{ name: string, content: string }>} sections
 * @returns {string}
 */
function assembleContext(sections) {
  const labels = {
    '_shared.md':   'SYSTEM CONTEXT (_shared.md)',
    'oferta.md':    'EVALUATION MODE (oferta.md)',
    'cv.md':        'CANDIDATE RESUME (cv.md)',
    'profile.yml':  'CANDIDATE PROFILE & TARGETS (config/profile.yml)',
    '_profile.md':  'USER ARCHETYPES & NARRATIVE (_profile.md)',
    //'JD':           'JOB DESCRIPTION',
  };

  const parts = [];
  for (const s of sections) {
    if (!s.content) continue;
    const label = labels[s.name] || s.name;
    parts.push(
      `═══════════════════════════════════════════════════════\n` +
      `${label}\n` +
      `═══════════════════════════════════════════════════════\n` +
      `${s.content}`
    );
  }

  return parts.join('\n\n');
}


/**
 *  //for >>api/run
 * @param {string} mode - Raw _shared.md content.
 * @returns {{ pdfContent: string, coverContext:string, cvContent:string, ofertaContent: string, sharedContent:string, profileYml:string, profileContent:string }}
 */
function loadContextFiles(mode){
    switch (mode) {
    case undefined: //what to do here? log?  
    case 'evaluate': return { ofertaContent : ofertaMode, cvContent: cvContent, profileYml:profileConfigYml, profileContent:profileContext }; //removed sharedContent: sharedContext,
    case 'fix-portal': return { }; //only need to load portals.yml --import loadYaml func? 
    case 'pdf': return { pdfContent: pdfMode, cvContent: cvContent, profileYml:profileConfigYml};
    case 'cover': return { coverContext: coverMode, cvContent: cvContent, profileYml: profileConfigYml, profileContent:profileContext };
    case 'research': return {};//prolly nothing? toReview
    default:
      //umm load all or nothing? // toReview** >>prolly at minimum the sharedContext methink?
      console.error(`⚠️   ${mode} Not known...Error: Nothing loadContextFiles \n`);
      return null
  }
}

export const apiAssistantInstructions = () => {
  //so that assistantPreamble() would have to be separated in two? or just keep as is?
  return ""
}

export const apiRunBaseInstructions = (evalMode) => { //smaller than 'apiRunInstructions'
  switch (evalMode) {
    case undefined:
    case 'fix-portal': return `A company's job-portal ATS slug is BROKEN — career-ops can no longer scan it, so it silently disappears from every future scan. Repair it (headless, on the user's machine)`;
    case 'pdf': return `You are tailoring the user's ATS-optimized CV for application #`; //toAdd
    case 'cover': return `You are generating the user's TAILORED COVER LETTER  for application #`;
    case 'research': return `You are investigating the user's OWN work / portfolio to surface job-search-relevant strengths, headless.`;
    //Investigate the target (use WebFetch for URLs; read local files if referenced) and report: what it is, why it is impressive, and how to leverage it in their job search — which roles/claims it supports and how to frame it on a CV. Be specific, honest, and encouraging. Report only: never submit, send, or click Apply anywhere, and contact no one — you are investigating the user's own work, not acting on it.${mem}
    //End with EXACTLY one final line: VERDICT: {0-5 signal strength}/5 — {why it helps their search, ≤12 words}
    //Target: ${input} //toAdd**
    default: //evaluate as default?
      console.log(`⚠️   ${evalMode} Assuming Evaluate default \n`);
      return `You are running the REAL career-ops job evaluation, HEADLESS, on the user's own machine. Today is ${new Date().toISOString().slice(0, 10)}. Run an evaluation of the given job posting against the user's CV using a structured A-G scoring system.— do NOT improvise your own scoring.`;
  }

}

const ISO_DATE_RE = /^20\d{2}-\d{2}-\d{2}$/;

export const apiRunSesshInstructions = ({ kind, input, memory, today, postedAt, lang, paths }) => {
  let baseInstru =  `${apiRunBaseInstructions(kind)}`;
  let something = `═══════════════════════════════════════════════════════
IMPORTANT OPERATING INSTRUCTIONS FOR THIS SESSION
═══════════════════════════════════════════════════════`; //rule or instructions?
  const languageDirective = `\n\nWrite all human-facing output in "${lang ?? 'en'}" regardless of the language of these instructions or the job description.\n`; //${marketNote}
  const mem = (memory.trim() ? `\n\nDurable notes about the user (from their profile):\n${memory.trim()}\n` : "") + languageDirective;
  const postedSegment = ISO_DATE_RE.test(String(postedAt ?? "")) ? `; posted: ${postedAt}` : "";

  switch (kind) {
    case undefined:
    case 'fix-portal': return `${baseInstru}\n${something}
1. Run \`node verify-portals.mjs --add "${input}"\` — it probes Greenhouse/Ashby/Lever for the company's correct ATS slug and prints the suggested ats + slug.
2. Open portals.yml, find the "${input}" entry under tracked_companies, and update its careers_url (and any api/slug field) to the suggested WORKING ATS URL. Change ONLY this one company; preserve all other YAML structure, comments and formatting exactly.
3. Re-run \`node verify-portals.mjs\` and confirm "${input}" now shows ✅ live (not ❌).
If NO slug variant resolves, say so clearly and leave portals.yml unchanged. Never touch any other company. This is a config repair: do not submit, send, or click Apply anywhere, and edit no file other than portals.yml.

End with EXACTLY one final line: VERDICT: {5 if now live, else 1}/5 — {what you changed, ≤12 words}`;
    case 'pdf': return `${baseInstru}${input}, headless, on their machine. \n${something}
1. Run the REAL career-ops "pdf" mode's and follow it exactly.
2. Follow the TAILORING rules exactly (do not improvise your own scoring or format). Apply its CONTENT rules — keyword injection, ordering, the competency grid, project selection, and its never-invent-a-skill rule. Its steps that shell out (the jd-skill-gap.mjs check, template resolution) and its build/save/render steps are NOT performed on web runs; the platform handles output itself.
3. Use the evaluation report at ${paths.reportPath} (for the JD keywords + analysis).
4. Tailor the CV per modes/pdf.md: inject the JD's keywords into the summary + first bullets, reorder experience by relevance, build the competency grid, pick the top 3–4 projects. NEVER invent skills — only reword REAL experience using the JD's vocabulary.
5. Fill templates/cv-template.html's {{...}} placeholders with the tailored content. Use that template even though modes/pdf.md resolves one via cv-templates.mjs: web runs always use the base template. ${CV_ENVELOPE_INSTRUCTION}
6. Emit the envelope EXACTLY ONCE. The platform writes the HTML, renders the PDF, and updates the tracker's PDF column itself, only after a confirmed successful render. Do not submit anything anywhere.

After the envelope, end with EXACTLY one final line: VERDICT: {5 if the complete HTML envelope was emitted, else 1}/5 — {a one-line summary, ≤15 words}`; //too many rules alike?
    case 'cover': return `${baseInstru}${input},headless, on their machine. \n${something}
1. Run the REAL career-ops "cover" mode — follow ALL of modes/cover.md EXACT STEPS within (do not improvise a format).
2. Use the evaluation report at ${paths.reportPath}.
3. LOAD any requiered files, EXECUTE any script from the steps and report any failure.
4. After all the steps in modes/cover.md, confirm that there is a json file in /output/cover-payload-${today}.json

End with EXACTLY one final line: VERDICT: {5 if the JSON file was written, else 1}/5 — {the output/ path, ≤15 words}`;
    case 'research': return `${baseInstru}\n${something}
1. Investigate the target (use WebFetch for URLs; read local files if referenced) and report: what it is, why it is impressive, and how to leverage it in their job search — which roles/claims it supports and how to frame it on a CV. Be specific, honest, and encouraging. 
2. Report only: never submit, send, or click Apply anywhere, and contact no one — you are investigating the user's own work, not acting on it.${mem}

End with EXACTLY one final line: VERDICT: {0-5 signal strength}/5 — {why it helps their search, ≤12 words}

Target: ${input}`;
    case 'evaluate': return `${baseInstru}\n${something}

1. Read modes/oferta.md and follow it EXACTLY — EVERY section its report template specifies, in its order, including the Machine Summary. Do not treat any list of sections in THIS prompt as the set to produce; that file is the only source of truth for which sections exist. Ground the fit in THIS person: use cv.md, config/profile.yml and modes/_profile.md.

  Use WebFetch to read the posting (you are headless — Playwright is unavailable), and mark the report header "Verification: unconfirmed (batch mode)".

  **If WebFetch does not return the posting itself — a login/consent wall, a partial page shell with no job description, a 404 or expired ad, a paywall, a bot challenge, or a page whose text is not this job — this is the mode file's "posting appears closed" case: STOP BEFORE BLOCK A and do not generate an evaluation, a report or a CV.** That rule is the mode's, not this prompt's; modes/pipeline.md states the same thing for extraction — never treat a login wall or partial shell as a verified JD. Instead, say which URL you fetched and what came back, so the user can paste the job text themselves. A scored report about a login screen looks exactly like a scored report about the job, and a run that reports it could not read the posting is a correct outcome.

2. Persist the result CANONICALLY so the web and the CLI share ONE source of truth:
   a. Reserve a report number: run \`node reserve-report-num.mjs\` — its stdout is a 3-digit number (e.g. 035).
   b. Write the full report to reports/{num}-{company-slug}-${today}.md  (company-slug = company lowercased, non-alphanumerics → hyphens).
   c. Write batch/tracker-additions/{num}-{company-slug}.tsv as TWO lines (real \\t tabs): a HEADER row of the 10 column labels, then ONE data row of 10 TAB-separated columns under it. merge-tracker reads the header and resolves every field by NAME, so no value can land in the wrong column. Copy both lines exactly as shown. ALWAYS write all 10 fields on the data row — leave the last one EMPTY if there is no posting URL, never "N/A" or "-":
      num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl
      {num}\t${today}\t{Company}\t{Role}\t{CanonicalStatus e.g. Evaluated}\t{score}/5\t❌\t[{num}](reports/{num}-{company-slug}-${today}.md)\t{one-line note}${postedSegment}\t{posting URL, or empty}
   d. Merge into the tracker: run \`node merge-tracker.mjs\` (it dedupes by company+role+report-num, validates the status, and writes data/applications.md — NEVER edit applications.md by hand).
   e. Release the sentinel by running \`node reserve-report-num.mjs --release {num}\` once the report is written.

3. NEVER submit an application, fill no forms, contact no one. This is evaluation + persistence ONLY.${mem}

After everything above is written and merged, output EXACTLY one final line, nothing after it:
VERDICT: {score}/5 — {reason in 20 words or fewer}

Posting URL: ${input}`;
    default:
      //umm load all or nothing? // toReview** >>prolly at minimum the sharedContext methink?
      console.error(`⚠️   ${kind} Not known...Error: Nope for  apiRunSesshInstructions \n`);
      return '';
  }

  ////umm wonder if will do extra reading of mentionned files or would know that in context? >>yup dont seem to do calls to read files
  //or that the batch/tracker-additions file will be written...lool prolly not? >>yup nope..had to reput the rules in...
}


//YOUR MISSION: genuinely help THIS person land a great role. Know them, advise honestly, and do real work for them:
//  CRITICAL RULES: 
// 1. Never claim you executed a command, web search, or script unless you strictly invoke the tool format. 
// 2. If you do not have a specific tool to fulfill the user's command, explicitly say "I do not have access to that tool or command." Do not invent placeholder metrics. 
// 3. Keep temperature lower (0.0 to 0.2) to prioritize strict command logic over creative responses.
export const basePrompt = () => {
  return `You are career-ops, a local AI job search assistant.
  You have a beginner's capability on internal data and MUST NOT rely on your own knowledge base for real-time, historical, or environment-specific commands. 
  NEVER ASSUME an internal logic has happened successfully NOR simulate an entire process.
  Verify everything via code, tools, provided context and instructions
  `
}

// >>send the context body..does some budget report as well...
//toReview** as other routes dont have kind parameter!!!!
export function buildSysPrompt(kind, fromScript) { 
  
  const contexts = loadContextFiles(kind);
  //check that 'contexts' has any keys? to fail fast?...todo**
  //umm for other scripts tho, kind dont exist!!!--toreview**
  if(! contexts) {
    console.error(`⚠️   ${kind} Not known...Error: No loadContextFiles \n`);
    return ''
  }

    //other cases:
    //// >>api/apply/prefill
    //// >>api/assistant >>(does it even have) huh would also need reports/, data/applications.md, and past worker logs in .career-ops-web/runs/{id}.md). Read them to be concrete.
    //// >>api/cv/ingest
    //// >>api/explore/ai > modes/discover.md + other?
    ////  >>api/run >>current implementation focus!!
    //// >>lib/apply/agent-interpret.ts ...prolly
  if (fromScript == "apiRun") {
    //explode contexts > pass to buildOllamaPrompt
    //instructions for fetching...and the posting url
    
    const { contextBody, budgetReport } = buildOllamaTotalContext({...contexts, evalType:kind })
    //console.log(`\n📂 For ${kind} >> contextBody be...\n ${contextBody} \n=====\n`); //JSON.stringify(contextBody, null, 2)
    console.log(`\n📂 For ${kind} >> budgetReport...\n ${JSON.stringify(budgetReport, null, 2)}`);

    return `${basePrompt()} \n${contextBody}`;
  }

  return "";
}

//


//oldie from '/web/src/app/api/run/route.ts' moved into 'web/src/lib/run-prompts.mjs'
/*
function buildPrompt(kind: string, input: string, memory: string, today: string): string {
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

    return kind === "pdf" ? 
    `You are generating the user's ATS-optimized, TAILORED CV PDF for application #${input}, headless, on their machine. Run the REAL career-ops "pdf" mode — follow modes/pdf.md EXACTLY (do not improvise a format).
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
}*/
