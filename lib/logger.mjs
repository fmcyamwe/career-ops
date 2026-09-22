// copied from web/src/lib/logger.mjs
import fs from "node:fs";

function log(level, message, meta) {
  const payload = {
    level,
    message: String(message || ""), //redactForLogging(String(message || "")),
    time: new Date().toISOString(),
    ...(meta ? { meta: meta} : {}) //redactForLogging(meta) 
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error("\n"+line);
  } else {
    console.error("\n"+line);
  }
}

function logToFile(path, data) {
  fs.writeFileSync(path, data, {flag: 'a',encoding: 'utf8'}); // 'a' flag to append!!
}


//..huh below way to export so that can do import of each function i.e: import {info, warn} from ...
//export const info = (message, meta) => log("info", message, meta)
//export const warn = (message, meta) => log("warn", message, meta)
//export const error = (message, meta) => log("error", message, meta)
//export const toFile = (path, data) => logToFile(path, data)

export default { //this(easier) gotta do import as >> import {default as logger } from ...
  info: (message, meta) => log("info", message, meta),
  warn: (message, meta) => log("warn", message, meta),
  error: (message, meta) => log("error", message, meta),
  toFile: (path, data) => logToFile(path, data),
};
