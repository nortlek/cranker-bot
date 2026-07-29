#!/usr/bin/env node

const MAX_MESSAGE_LENGTH = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;

function usage() {
  return `Usage:
  npm run codex:update -- "Update message"
  printf 'Multiline update\\n' | npm run codex:update`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function splitMessage(message) {
  const parts = [];
  let remaining = message;

  while (remaining.length > MAX_MESSAGE_LENGTH) {
    const candidate = remaining.slice(0, MAX_MESSAGE_LENGTH + 1);
    const newline = candidate.lastIndexOf("\n");
    const space = candidate.lastIndexOf(" ");
    const splitAt = Math.max(newline, space);
    const end = splitAt > 0 ? splitAt : MAX_MESSAGE_LENGTH;

    parts.push(remaining.slice(0, end).trimEnd());
    remaining = remaining.slice(end).trimStart();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts;
}

async function postUpdate(webhook, content) {
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "Codex Updates",
      content,
      allowed_mentions: { parse: [] },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.ok) {
    return;
  }

  const details = (await response.text()).trim();
  throw new Error(
    `Discord webhook returned HTTP ${response.status}${
      details.length === 0 ? "" : `: ${details.slice(0, 500)}`
    }`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }

  const webhook = process.env.CODEX_UPDATES_WEBHOOK?.trim();
  if (!webhook) {
    throw new Error("CODEX_UPDATES_WEBHOOK is not set");
  }

  const parsedWebhook = new URL(webhook);
  if (!["http:", "https:"].includes(parsedWebhook.protocol)) {
    throw new Error("CODEX_UPDATES_WEBHOOK must be an HTTP(S) URL");
  }

  const message = (
    args.length > 0 ? args.join(" ") : await readStdin()
  ).trim();
  if (!message) {
    throw new Error(`An update message is required\n\n${usage()}`);
  }

  const parts = splitMessage(message);
  for (const part of parts) {
    await postUpdate(parsedWebhook, part);
  }
  console.log(
    `Sent ${parts.length === 1 ? "update" : `${parts.length} update parts`} to Discord.`,
  );
}

main().catch((error) => {
  console.error(
    `codex-update: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
