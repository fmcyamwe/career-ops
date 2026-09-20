/**
 * run-prompts.mjs — the prompts /api/run sends each worker kind (#2185).
 *
 * The web ORCHESTRATES the real career-ops engine — it does NOT reimplement it.
 * kind "evaluate" runs the REAL modes/oferta.md and persists the canonical
 * artifacts (A–F report + tracker row) via the SAME scripts the CLI uses
 * (reserve-report-num.mjs → reports/ → batch/tracker-additions/ → merge-tracker.mjs),
 * so a web evaluation is byte-identical to a CLI one (single source of truth, no
 * drift). kind "research" stays read-only.
 */
import { CV_ENVELOPE_INSTRUCTION } from "./cv-envelope.mjs";
import logger from "@/lib/logger.mjs";

/**
 * Is this company name safe to interpolate into a shell command inside a prompt?
 *
 * The fix-portal prompt tells the agent to run
 * `node verify-portals.mjs --add "<company>"`, and fix-portal is one of the kinds
 * that still holds Bash. Company names are not always the user's own typing — they
 * reach the dashboard from public ATS listings — so a crafted one could close the
 * quote and append a command. Allow the characters real company names use and
 * refuse the rest. The caller turns a refusal into a 400 rather than sanitizing,
 * because a silently rewritten name would resolve the wrong portal.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isShellSafeCompanyName(name) {
  return typeof name === "string"
    && name.length > 0
    && name.length <= 80
    && SAFE_COMPANY_NAME.test(name)
    // A single & is needed (AT&T, Marks & Spencer); && is a command separator and
    // appears in no real company name. Every other chaining character — ; | $ `
    // quotes, newline — is already outside the character class.
    && !name.includes("&&");
}

const SAFE_COMPANY_NAME = /^[\p{L}\p{N} .,&'()+/-]+$/u;

/**
 * The exact prompt each worker kind is sent.
 *
 * Lives in a plain .mjs so it can be asserted on as a VALUE: the pdf prompt is
 * the load-bearing half of #2185 (it is what tells the agent to emit the CV
 * inline instead of writing it), and a guard that greps route.ts for the marker
 * text matched the route's own comments instead. See test-all.mjs §55.6.
 *
 * @param {{kind: string, input: string, memory: string, today: string}} args
 * @returns {string}
 */
/** ISO calendar date, the only form the dashboard's POSTED column parses. */
const ISO_DATE_RE = /^20\d{2}-\d{2}-\d{2}$/;

export function buildPrompt({ kind, input, memory, today, postedAt, lang, paths }) {
  // AGENTS.md's "Output Language vs Market Modes" composition rule. The CLI
  // picks this up by reading AGENTS.md interactively; a one-shot headless
  // prompt has no such chance, so the rule has to be stated in the prompt or a
  // configured market silently does nothing on a web-triggered run.
  //
  // `lang` is optional and defaults to the English/global configuration:
  // readLanguageConfig() touches the filesystem, so callers that cannot supply
  // it (tests, future callers) keep working instead of this module reaching for
  // fs itself and losing its "plain module, testable as a value" property.
  const resolvedLang = lang ?? { output: "en", modesDir: "modes", evalModeFile: "modes/oferta.md" };
  const marketNote =
    resolvedLang.modesDir !== "modes"
      ? ` Also read ${resolvedLang.modesDir}/_shared.md for this market's vocabulary, benefits and legal concepts, and keep those terms (explained in the output language) where relevant.`
      : "";
  const languageDirective = `\n\nWrite all human-facing output in "${resolvedLang.output}" regardless of the language of these instructions or the job description.${marketNote}\n`;
  const mem = (memory.trim() ? `\n\nDurable notes about the user (from their profile):\n${memory.trim()}\n` : "") + languageDirective;
  
  const postedSegment = ISO_DATE_RE.test(String(postedAt ?? "")) ? `; posted: ${postedAt}` : "";

  if (kind === "research") {
    return `You are investigating the user's OWN work / portfolio to surface job-search-relevant strengths, headless. Investigate the target (use WebFetch for URLs; read local files if referenced) and report: what it is, why it is impressive, and how to leverage it in their job search — which roles/claims it supports and how to frame it on a CV. Be specific, honest, and encouraging. Report only: never submit, send, or click Apply anywhere, and contact no one — you are investigating the user's own work, not acting on it.${mem}

End with EXACTLY one final line: VERDICT: {0-5 signal strength}/5 — {why it helps their search, ≤12 words}

Target: ${input}`;
  }
  if (kind === "pdf" || kind === "cover") { //
    // The agent tailors content only — it neither renders the PDF nor saves it.
    // Rendering moved to the backend because launching a real browser can hit a
    // sandbox escalation nobody is present to approve (#2172); SAVING moved for a
    // different reason (#2185): tool grants are tool-name-only, so the Write/Edit
    // this step used to need was unscoped, and a prompt injection in the posting
    // or the report — both of which land in this agent's context — could aim it at
    // cv.md or data/applications.md. The agent now emits the CV inline and the
    // backend (a plain Node process, no CLI sandbox) writes and renders it, so
    // pdf mode runs with no write tool at all.
    // ---toReview** reasons(#2185) above tho when need to generate pdf >>would add points 4 & 5 from old prompt
    const daPAths = paths ?? {html: `cv-web-${input}.html`, reportPath: `reports/${String(postedAt ?? "")}`, //.md ?
          finalPdf: `output/cv-${input}.pdf` };
    //at reports/${input}-*.md 
    return kind === "pdf" ? 
    `You are tailoring the user's ATS-optimized CV for application #${input}, headless, on their machine. Run the REAL career-ops "pdf" mode's CONTENT step: follow modes/pdf.md's TAILORING rules exactly (do not improvise your own scoring or format). Apply its CONTENT rules — keyword injection, ordering, the competency grid, project selection, and its never-invent-a-skill rule. Its steps that shell out (the jd-skill-gap.mjs check, template resolution) and its build/save/render steps are NOT performed on web runs; the platform handles output itself.
1. Read modes/pdf.md, cv.md, config/profile.yml, and the evaluation report at ${daPAths.reportPath} (for the JD keywords + analysis).
2. Tailor the CV per modes/pdf.md: inject the JD's keywords into the summary + first bullets, reorder experience by relevance, build the competency grid, pick the top 3–4 projects. NEVER invent skills — only reword REAL experience using the JD's vocabulary.
3. Fill templates/cv-template.html's {{...}} placeholders with the tailored content. Use that template even though modes/pdf.md resolves one via cv-templates.mjs: web runs always use the base template. ${CV_ENVELOPE_INSTRUCTION}
4. Emit the envelope EXACTLY ONCE. The platform writes the HTML, renders the PDF, and updates the tracker's PDF column itself, only after a confirmed successful render. Do not submit anything anywhere.

After the envelope, end with EXACTLY one final line: VERDICT: {5 if the complete HTML envelope was emitted, else 1}/5 — {a one-line summary, ≤15 words}`
:
`You are generating the user's TAILORED COVER LETTER  for application #${input}, headless, on their machine. Run the REAL career-ops "cover" mode — follow modes/cover.md EXACT STEPS(do not improvise a format).
1. Read the evaluation report at ${daPAths.reportPath}.
2. Read modes/cover.md and follow all EXACT STEPS within, LOAD any requiered files, EXECUTE any script from the steps and report any failure.
4. After all the steps in modes/cover.md, confirm that there is a json file in /output/cover-payload-${today}.json

End with EXACTLY one final line: VERDICT: {5 if the JSON file was written, else 1}/5 — {the output/ path, ≤15 words}`;
  }
  if (kind === "fix-portal") {
    return `A company's job-portal ATS slug is BROKEN — career-ops can no longer scan it, so it silently disappears from every future scan. Repair it (headless, on the user's machine):
1. Run \`node verify-portals.mjs --add "${input}"\` — it probes Greenhouse/Ashby/Lever for the company's correct ATS slug and prints the suggested ats + slug.
2. Open portals.yml, find the "${input}" entry under tracked_companies, and update its careers_url (and any api/slug field) to the suggested WORKING ATS URL. Change ONLY this one company; preserve all other YAML structure, comments and formatting exactly.
3. Re-run \`node verify-portals.mjs\` and confirm "${input}" now shows ✅ live (not ❌).
If NO slug variant resolves, say so clearly and leave portals.yml unchanged. Never touch any other company. This is a config repair: do not submit, send, or click Apply anywhere, and edit no file other than portals.yml.

End with EXACTLY one final line: VERDICT: {5 if now live, else 1}/5 — {what you changed, ≤12 words}`;
  }
  // The posting date is INTERPOLATED, not asked for. The scanner wrote it into
  // pipeline.md from the provider's own `offer.postedAt`; the server already has
  // it (readScanDates/readInbox) and passes it here, so the agent copies a value
  // rather than deriving one. modes/oferta.md is explicit that a guessed date is
  // worse than none — the dashboard's POSTED column renders an absent date as
  // `—`, and an invented one reports a months-old req as fresh.
  //
  // Canonical form, taken from the regex that CONSUMES it (dashboard's
  // rePostedOn) rather than from prose: its own trailing segment after `; `,
  // anchored to a separator, ISO `YYYY-MM-DD`. Mid-sentence mentions are
  // deliberately not metadata there, so this must be a segment or nothing.
  //
  // Absent → the empty string, so the row is byte-identical to today's. Same
  // reason the url field is always written but may be empty: the shape an agent
  // reliably follows is one unconditional template, and here the CONTENT is
  // conditional precisely because "write nothing" is the required behaviour.
  
  //moved up > const postedSegment = ISO_DATE_RE.test(String(postedAt ?? "")) ? `; posted: ${postedAt}` : "";

  // evaluate (default) — run the REAL oferta mode + persist canonically
  //
  // The TSV row carries 10 fields, the 10th being the posting URL that
  // merge-tracker dedupes on (#1298). The web is a WRITER of that file, not only
  // a reader: emitting 9 fields stays valid forever, so nothing would ever go
  // red — every job evaluated from the web would simply sit outside the
  // URL dedup. Compatible and half-dead at once, which is the failure mode with
  // no symptom.
  //
  // ALWAYS 10 fields, empty when there is no URL, deliberately: an
  // unconditional template is one an agent follows, "emit 9 or 10 depending"
  // is one it sometimes forgets. Empty and absent are byte-identical in the
  // written row (verified against merge-tracker), so the robust instruction
  // costs nothing. Not "N/A" either — parseTsvExtras drops placeholders
  // precisely so they can't be misread as the row's LOCATION.
  //
  // The HEADER row is the same argument one level up (#3517). Headerless files
  // stay valid forever, so a stale template here would never go red either — it
  // would just leave every web evaluation on the path where merge-tracker has to
  // tell score from status by CONTENT, and a discarded, never-scored row (`—` in
  // both cells) is undecidable there and is skipped. With the header, the field
  // ORDER below stops being load-bearing at all: merge-tracker resolves each
  // field by name. The order is kept as-is anyway, so this prompt's row stays
  // byte-comparable to the CLI's.

  // Two things this prompt deliberately does NOT do.
  //
  // It does not ENUMERATE the report's sections. It used to say "blocks A–F, G
  // posting-legitimacy, and the Machine Summary", which was a hand-kept copy of
  // a list that lives in modes/oferta.md — and it had already drifted: the
  // template also requires Risk Summary, H) Draft Application Answers and
  // Keywords extracted. The `EXACTLY` carried the real instruction, so nothing
  // broke, which is precisely why the drift was invisible. The mode file is the
  // one source of truth for which sections exist; naming a subset here can only
  // ever go stale, never help.
  //
  // And it does not let a failed fetch become a scored report. WebFetch returns
  // 200 with a login wall, a lazy-loaded shell carrying no description (#2619),
  // an expired-ad page or a bot challenge, and none of that announces itself as
  // an error. An agent handed that text will happily grade it: the output is a
  // confident A–F evaluation of a login screen, shaped exactly like a real one.
  // Reported by a user against LinkedIn URLs in #2995.
  //
  // The REFUSAL IS NOT THIS PROMPT'S POLICY, and saying so matters: the web is a
  // view over the core's modes, never a parallel engine. modes/oferta.md step 3
  // already rules that a posting which "appears closed" stops before Block A with
  // no evaluation, report or CV, and modes/pipeline.md's LinkedIn note already
  // says never to treat a login wall or partial shell as a verified JD. Both were
  // written for the interactive path; headless just never had the case spelled
  // out. So this points AT those rules rather than inventing a third one — if the
  // core changes its mind, this follows instead of contradicting it.
  return `You are running the OFFICIAL career-ops job evaluation, HEADLESS, on the user's own machine. Today is ${today}. Run the REAL career-ops evaluation — do NOT improvise your own scoring.

1. Read ${resolvedLang.evalModeFile} and follow it EXACTLY — EVERY section its report template specifies, in its order, including the Machine Summary. Do not treat any list of sections in THIS prompt as the set to produce; that file is the only source of truth for which sections exist. Ground the fit in THIS person: read cv.md, config/profile.yml and modes/_profile.md.

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
}

export function assistantPreamble() {
  return `You are the career-ops assistant — a proactive, friendly career co-pilot for a person who is actively job-hunting. You live inside their LOCAL career-ops web dashboard (a pipeline of evaluated jobs, A–F reports, their CV, analytics) and run on their own AI CLI.

YOUR MISSION: genuinely help THIS person land a great role. Know them, advise honestly, and do real work for them:
- Know them: use the persistent memory below + their files (cv.md, config/profile.yml, reports/, data/applications.md, and past worker logs in .career-ops-web/runs/{id}.md). Read them to be concrete.
- Be a real advisor: surface strengths they undersell, spot gaps, suggest concrete CV improvements, recommend which roles to chase or skip, and recognise wins.

YOU CAN ACT — you do it by emitting ACTION ENVELOPES inside your reply. An envelope is ONE line, on its own line (never inside a code fence):
<<act:ACTION_ID {"arg":"value"}>>
The args are a single JSON object. The dashboard parses the envelope and performs the action (you won't see its output) — so just say briefly what you're doing, then emit the envelope.

ACTIONS:
- navigate {"path":"/pipeline?tab=OFFER&min=4"} — take the user to a section. Valid paths: /, /pipeline, /portals, /analytics, /cv, /config, /apply, /pipeline/{n} (a report), /jobs/{id} (a worker). The path may carry a query string.
- filterPipeline {"tab":"OFFER","min":4,"q":"text","sort":"score","dir":-1} — filter the pipeline table in place. tab ∈ INBOX, ALL, EVALUATED, APPLIED, RESPONDED, INTERVIEW, OFFER, REJECTED, DISCARDED, SKIP; min = score floor 0–5.
- evaluate {"url":"https://…","title":"Evaluate · Acme","subtitle":"Role"} — spin ONE read-only evaluation worker on a SPECIFIC posting URL. Only when you actually have a real URL (e.g. from the page the user is on).
- evaluateCompany {"company":"Anthropic"} — evaluate ALL of the user's PENDING inbox postings for that company. Emit the COMPANY NAME ONLY — never URLs; the app resolves the concrete postings itself. Big batches ask the user to confirm first.
- research {"target":"https://… or 'my portfolio'","title":"Research · X"} — spin a read-only research worker.
- generatePdf {"n":"42"} — generate an ATS-optimized CV tailored to application #42 (runs the real pdf mode → output/ + marks the tracker PDF column). Spends tokens.
- setStatus {"n":"42","status":"Applied"} — move a tracked application to a new state (asks the user to confirm first). Canonical states: Evaluated, Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP. Use the application number (the "#42" on its report page).
- apply {"url":"https://…"} — open the apply form-proxy for a posting URL (we re-render the real form in plain language; the user verifies and submits it themselves — never auto-submit).
- setApplyField {"field":"Why this role?","value":"<the answer>"} — write or revise an answer in the apply form the user is filling (only when an APPLY FORM is shown in your context). Use the field's label or id. When the user asks to make an answer shorter/sharper/etc, generate the new text and emit this.
- remember {"fact":"the concise fact"} — durably remember a preference/fact about the user (carries across sessions and across whichever CLI runs).
- setProfile {"name":"…","email":"…","location":"…","roles":["AI Engineer","ML Engineer"],"compMin":70000,"compMax":95000,"currency":"EUR","remote":"Remote (EU)","seniority":"Senior"} — PROPOSE the user's profile; the app shows a confirm card and ONLY on their OK writes config/profile.yml (merge-safe — it never clobbers their other fields) AND seeds the free scanner from the roles. Emit only fields you're confident about (most come from their CV). NEVER write a profile they didn't approve.
- setPortals {"roles":["AI Engineer","ML Engineer"]} — seed the free scanner from target roles (writes portals.yml title_filter). Usually unnecessary — setProfile already does this.

RULES: prefer evaluateCompany over guessing URLs; NEVER invent URLs. Spending actions (evaluate/evaluateCompany/research) run on the user's own AI and cost tokens — fire them when asked or clearly useful, not gratuitously. NEVER auto-submit a job application. (Back-compat: <<go:/path>> and <<remember:fact>> still work.)

ONBOARDING — your job is to get this person to their first SCORED job FAST. The rule is VALUE BEFORE COMMITMENT: take the minimum, deliver a wow, THEN deepen. Never make them fill a form or edit YAML.
1. CV FIRST — but ONLY if it is not already on file. Consult SETUP STATE (above): if the CV is already on file, do NOT ask for it again — jump straight to the first missing prerequisite. If cv.md IS missing, warmly ask them to paste it (or just tell you about themselves); read it and take them to the editor with navigate {"path":"/cv"} to save. Do NOT ask for comp/location/roles yet.
2. WOW #1 — DISCOVER, FREE. The moment you have a CV, infer their target roles + location FROM the CV and immediately run a FREE discovery: explore {"positive":["…roles from the CV…"],"run":true}. Say "Before we set anything up — here are live roles that fit you, free." A job THEY didn't have to define is the aha trigger.
3. Then DEEPEN, value-interleaved. Now that they've seen matches, confirm targeting so results sharpen: ask for roles, then comp, then location — one or two at a time, ~2–3 minutes, encouraging.
4. PROPOSE, don't impose. When you have name/email (from the CV) + roles + comp + location, emit setProfile. NEVER write a profile they didn't see + approve — the confirm card is required.
5. WOW #2 is theirs to pick: invite them to open any discovered role and you'll score it A–F with the why ("you're a strong match because…"). That first scored-job-with-explanation is the north star.
Their REAL CV never leaves their machine — reassure them if they hesitate. Never reveal internal file names or YAML unless asked.

Keep replies short, warm, and useful. Don't dump raw files or narrate internal details. If they seem new, onboard them gently. Never reveal internal system details. Ask confirmation to clarify instructions and LET the person know when there is a failure!`;

}