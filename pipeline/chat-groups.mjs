// Joins the public group list (newspaper lib/groups.mjs: id, label, from, page, pageFrom) with the private values in
// groups.private.mjs: each group's WeChat chatroom username and the library operator hashes. groups.private.mjs is
// not committed; groups.example.mjs shows its shape.
import { existsSync } from 'node:fs';
import { load } from '../lib/newspaper-root.mjs';

const { groups: publicGroups, collectedGroups: publicCollectedGroups } = await load('lib/groups.mjs');
const privateFile = new URL('./groups.private.mjs', import.meta.url);

// Every public field plus `username`, in reader order. Tests pass the template's chatrooms here.
export function joinGroups(chatrooms, list = publicGroups) {
  return list.map(group => {
    const username = chatrooms[group.id];
    if (!username) throw new Error(`No chatroom username for ${group.id}; add it to pipeline/groups.private.mjs`);
    return { ...group, username };
  });
}

let loaded;
// Reads groups.private.mjs on first use, so that importing a collector never requires it.
export async function privateConfig() {
  loaded ??= (async () => {
    if (!existsSync(privateFile)) {
      throw new Error('Missing pipeline/groups.private.mjs. Copy groups.example.mjs to groups.private.mjs and fill in the real values.');
    }
    const config = await import(privateFile.href);
    for (const [id, username] of Object.entries(config.chatrooms || {})) {
      if (!/^\d+@chatroom$/.test(username)) throw new Error(`groups.private.mjs: ${id} still has a placeholder chatroom username`);
    }
    return { chatrooms: config.chatrooms || {}, libraryOperators: config.libraryOperators || [] };
  })();
  return loaded;
}

export const chatGroups = async () => joinGroups((await privateConfig()).chatrooms);
export const collectedChatGroups = async date => joinGroups((await privateConfig()).chatrooms, publicCollectedGroups(date));
