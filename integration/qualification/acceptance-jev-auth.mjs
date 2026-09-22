#!/usr/bin/env node
// Minimal Jev stand-in that records sentinel equality, never credentials, for every
// SystemOne request and answers "no tool needed" with low need. Values here
// are dummy sentinels, never real credentials.
// Env: PORT, LOG (JSON lines: {n, expectedSentinel}).
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 18091);
const LOG = process.env.LOG ?? "./jev-auth.log";
writeFileSync(LOG, "");
let n = 0;

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    n++;
    let questions = {};
    try { questions = JSON.parse(body).questions ?? {}; } catch {}
    const answers = {};
    for (const [key, q] of Object.entries(questions)) {
      if (key === "tool") {
        const options = Object.keys(q.criteria ?? {});
        const choice = options.includes("no_tool_needed") ? "no_tool_needed" : options[0];
        answers[key] = { type: "choice", choice, confidence: 0.9, probabilities: {} };
      } else if (key === "needs_tool") {
        answers[key] = { type: "noul", noul: 0.1 };
      } else if (q.type === "noul") {
        answers[key] = { type: "noul", noul: 0.5 };
      } else {
        answers[key] = { type: "score", score: 0.5 };
      }
    }
    appendFileSync(LOG, JSON.stringify({ n, expectedSentinel: req.headers.authorization === "Bearer jev-sentinel" }) + "\n");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "auth-probe", answers, usage: { input_tokens: 10, output_tokens: 0 } }));
  });
}).listen(PORT, "127.0.0.1", () => console.log(`acceptance-jev-auth on 127.0.0.1:${PORT}`));
