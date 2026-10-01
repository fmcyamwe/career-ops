import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";

/**
 * 
 * Utility for loading context files...used to build system prompts
 */


function loadYaml(rel: string): Record<string, unknown> | null {
  try {
    const doc = yaml.load(fs.readFileSync(path.join(careerOpsRoot(), rel), "utf8"));
    return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readFile(path:string, label:string) {
  if (!fs.existsSync(path)) {
    console.warn(`⚠️   ${label} not found at: ${path}`);
    //return `[${label} not found — skipping]`; //prolly throw error--toDo**
    return '';
  }
  return fs.readFileSync(path, 'utf-8').trim();
}

const DEFAULT_OUTPUT_LANGUAGE = 'en'; //bof 

export const sharedContext = readFile(path.join(careerOpsRoot(), 'modes','_shared.md'), 'modes/_shared.md');//PATHS.shared,
export const ofertaMode   = readFile(path.join(careerOpsRoot(), 'modes','oferta.md'), 'modes/oferta.md'); //PATHS.oferta
export const pdfMode   = readFile(path.join(careerOpsRoot(), 'modes','pdf.md'), 'modes/pdf.md');
export const coverMode   = readFile(path.join(careerOpsRoot(), 'modes','cover.md'), 'modes/cover.md');
export const cvContent     = readFile(path.join(careerOpsRoot(), "cv.md"),  'cv.md'); //PATHS.cv
export const profileContext = readFile(path.join(careerOpsRoot(), 'modes','_profile.md') , 'modes/_profile.md'); //PATHS.profile
export const profileConfigYml    = readFile(path.join(careerOpsRoot(), 'config','profile.yml'), 'config/profile.yml'); //PATHS.profileYml
export const batchPrompt    = readFile(path.join(careerOpsRoot(), 'batch','batch-prompt.md'), 'batch/batch-prompt.md');
//prolly other stuff like data/applications.md? toReview**
//also other like modes/latex.md ? for pdf...smh
//modes/pipeline.md? for evaluate? 

export const languageInstruction = [
    `Write all human-facing output in ${DEFAULT_OUTPUT_LANGUAGE}, including the full A–G`,
    `evaluation and the machine-readable summary's free-text fields, regardless`,
    `of the language of these instructions or the job description. Keep`,
    `market-specific terms when relevant, but explain them in ${DEFAULT_OUTPUT_LANGUAGE}`,
    `when needed. The configured language.output always wins over the job`,
    `description's language.`,
  ].join(' '); //outputLanguageInstruction(parseOutputLanguage(profileYml));



