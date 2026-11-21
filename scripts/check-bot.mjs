// Deterministic formatter & length checker for a WeChat group guide message written by Antigravity.
//   node "$BOT/scripts/check-bot.mjs" BOT_INPUT_JSON MESSAGE_MD [--fix]
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkBotMessage } from '../lib/bot-message.mjs';

export async function runCheckBot(inputFile, messageFile, { fix = false, log = console.log } = {}) {
  if (!inputFile || !messageFile) throw new Error('Usage: check-bot.mjs BOT_INPUT_JSON MESSAGE_MD [--fix]');
  const spec = JSON.parse(await readFile(inputFile, 'utf8'));
  const text = await readFile(messageFile, 'utf8');
  const result = checkBotMessage(text, spec);
  if (!result.ok) throw new Error(`Invalid bot message:\n- ${result.errors.join('\n- ')}`);
  if (fix) await writeFile(messageFile, result.formatted);
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  log(`Bot message OK (${result.total} chars, ${spec.sections.length} sections)`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const files = args.filter(a => a !== '--fix');
  await runCheckBot(files[0], files[1], { fix });
}
